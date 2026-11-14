"""The editor's web application: static front-end plus a JSON API for media, projects and export."""

import json
import os
import re
import subprocess
import threading
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor

from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from . import luts as L
from . import media as M
from . import render as R
from . import regen as RG
from . import shots as SH
from . import titles as TT
from . import transcribe as TX

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")


class NoCacheStaticFiles(StaticFiles):
    """Revalidate front-end files on every load so plugin updates show up without a hard refresh."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


def _safe_name(name, default="Untitled"):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(name or "")).strip(" .")
    return name[:120] or default


class EditorService:
    def __init__(self, get_config, host=None):
        self.get_config = get_config
        config = get_config() or {}
        self.save_path = os.path.abspath(config.get("save_path") or "outputs")
        self.image_save_path = os.path.abspath(config.get("image_save_path") or self.save_path)
        self.data_root = os.path.join(self.save_path, "video_editor")
        self.projects_dir = os.path.join(self.data_root, "projects")
        self.exports_dir = os.path.join(self.data_root, "exports")
        self.temp_dir = os.path.join(self.data_root, "temp")
        self.luts_dir = os.path.join(self.data_root, "luts")
        for folder in (self.projects_dir, self.exports_dir, self.temp_dir, self.luts_dir):
            os.makedirs(folder, exist_ok=True)
        self.registry = M.MediaRegistry(self.data_root)
        self.jobs = {}
        self.export_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="video_editor_export")
        self.lock = threading.Lock()
        self.regen = RG.RegenService(self.registry, self.data_root, host or RG.NoHost())


def create_app(get_config, host=None):
    service = EditorService(get_config, host)
    app = FastAPI(title="WanGP Video Editor", docs_url=None, redoc_url=None, openapi_url=None)
    threading.Thread(target=R.detect_hw_codecs, daemon=True, name="video_editor_hw_codecs").start()
    app.mount("/static", NoCacheStaticFiles(directory=STATIC), name="static")

    @app.get("/", response_class=HTMLResponse)
    def index():
        with open(os.path.join(STATIC, "index.html"), "r", encoding="utf-8") as handle:
            html = handle.read()
        version = str(int(max(os.path.getmtime(os.path.join(root, f)) for root, _, files in os.walk(STATIC) for f in files)))
        return HTMLResponse(html.replace("__V__", version), headers={"Cache-Control": "no-cache"})

    # ------------------------------------------------------------------ status
    @app.get("/api/status")
    def status():
        try:
            import torch
            device = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU"
        except Exception:
            device = "unavailable"
        rife = False
        try:
            from shared.utils.files_locator import locate_file
            rife = bool(locate_file("rife4.26.pkl", error_if_none=False))
        except Exception:
            pass
        return {"data_root": service.data_root, "exports_dir": service.exports_dir, "device": device, "rife": rife,
                "codecs": [{"id": key, "label": value["label"], "kind": value.get("kind", "video")} for key, value in R.CODECS.items()],
                "codecsReady": R._HW_STATE["done"],
                "fonts": TT.available_fonts(),
                "roots": [{"label": "WanGP outputs", "path": service.save_path},
                          {"label": "WanGP image outputs", "path": service.image_save_path},
                          {"label": "Editor uploads", "path": service.registry.upload_dir},
                          {"label": "Editor exports", "path": service.exports_dir}]}

    # ------------------------------------------------------------------ browsing / import
    @app.post("/api/media/relink")
    def media_relink(payload: dict = Body(...)):
        """Point a missing media item at its file's new place: {id, path, kind?, duration?}."""
        try:
            item, warning = service.registry.relink(payload["id"], payload["path"], payload)
        except FileNotFoundError:
            raise HTTPException(404, "File not found")
        except (ValueError, KeyError) as error:
            raise HTTPException(400, str(error))
        return {"media": service.registry.public(item), "warning": warning}

    @app.post("/api/media/relink-folder")
    def media_relink_folder(payload: dict = Body(...)):
        """Look for missing files by name in a folder and the folders under it (3 levels): {folder, items: [{id, name,
        kind, duration}]}. Relinks each one found (a same-name file that's a different kind is left alone)."""
        folder = os.path.abspath(payload.get("folder") or "")
        if not os.path.isdir(folder):
            raise HTTPException(404, "Folder not found")
        wanted = {}
        for it in payload.get("items") or []:
            if it.get("id") and it.get("name"):
                wanted.setdefault(it["name"].lower(), []).append(it)
        found, relinked, warnings = {}, [], []
        base_depth = folder.rstrip(os.sep).count(os.sep)
        for root, dirs, files in os.walk(folder):
            if root.count(os.sep) - base_depth >= 3:
                dirs[:] = []
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for f in files:
                if f.lower() in wanted and f.lower() not in found:
                    found[f.lower()] = os.path.join(root, f)
            if len(found) == len(wanted):
                break
        for name, path in found.items():
            for it in wanted[name]:
                try:
                    item, warning = service.registry.relink(it["id"], path, it)
                    relinked.append(service.registry.public(item))
                    if warning:
                        warnings.append(warning)
                except Exception as error:
                    warnings.append(f"{it['name']}: {error}")
        return {"media": relinked, "warnings": warnings, "notFound": [it["name"] for n, its in wanted.items() if n not in found for it in its]}

    @app.get("/api/browse")
    def browse(path: str = ""):
        path = os.path.abspath(path or service.save_path)
        if not os.path.isdir(path):
            raise HTTPException(404, f"Folder not found: {path}")
        dirs, files = [], []
        try:
            with os.scandir(path) as entries:
                for entry in entries:
                    try:
                        if entry.name.startswith("."):
                            continue
                        if entry.is_dir():
                            dirs.append({"name": entry.name, "path": entry.path})
                        elif entry.name.lower().endswith(M.MEDIA_EXT):
                            stat = entry.stat()
                            files.append({"name": entry.name, "path": entry.path, "size": stat.st_size, "mtime": stat.st_mtime,
                                          "kind": M.media_kind(entry.name)})
                    except OSError:
                        continue
        except PermissionError:
            raise HTTPException(403, f"Cannot read {path}")
        dirs.sort(key=lambda d: d["name"].lower())
        files.sort(key=lambda f: -f["mtime"])
        parent = os.path.dirname(path)
        return {"path": path, "parent": parent if parent != path else None, "dirs": dirs, "files": files[:2000]}

    @app.post("/api/import")
    def import_paths(payload: dict = Body(...)):
        results, errors = [], []
        for path in payload.get("paths", []):
            try:
                results.append(service.registry.public(service.registry.register(path)))
            except Exception as error:
                errors.append({"path": path, "error": str(error)})
        return {"media": results, "errors": errors}

    @app.post("/api/upload")
    async def upload(files: list[UploadFile] = File(...)):
        results, errors = [], []
        for upload_file in files:
            name = _safe_name(os.path.basename(upload_file.filename or "upload"), "upload")
            if not name.lower().endswith(M.MEDIA_EXT):
                errors.append({"path": name, "error": "Unsupported file type"})
                continue
            base, ext = os.path.splitext(name)
            target = os.path.join(service.registry.upload_dir, name)
            counter = 1
            while os.path.exists(target):
                target = os.path.join(service.registry.upload_dir, f"{base}_{counter}{ext}")
                counter += 1
            with open(target, "wb") as handle:
                while True:
                    chunk = await upload_file.read(8 * 1024 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
            try:
                results.append(service.registry.public(service.registry.register(target)))
            except Exception as error:
                errors.append({"path": name, "error": str(error)})
        return {"media": results, "errors": errors}

    # ------------------------------------------------------------------ media
    def _item(media_id):
        item = service.registry.refresh(media_id)
        if item is None:
            raise HTTPException(404, "Unknown media")
        return item

    @app.get("/api/media/{media_id}")
    def media_info(media_id: str):
        return service.registry.public(_item(media_id))

    @app.post("/api/media/batch")
    def media_batch(payload: dict = Body(...)):
        out = {}
        for media_id in payload.get("ids", []):
            item = service.registry.refresh(media_id)
            out[media_id] = service.registry.public(item) if item else None
        return out

    @app.get("/api/media/{media_id}/proxy")
    def media_proxy(media_id: str):
        _item(media_id)
        path = service.registry.proxy_path(media_id)
        if not path or not os.path.isfile(path):
            raise HTTPException(404, "File missing")
        return FileResponse(path)

    @app.post("/api/media/{media_id}/reverse")
    def media_reverse(media_id: str):
        _item(media_id)
        return service.registry.public(service.registry.make_reverse(media_id))

    @app.get("/api/media/{media_id}/proxy_rev")
    def media_proxy_rev(media_id: str):
        _item(media_id)
        path = service.registry.reverse_path(media_id)
        if not path:
            raise HTTPException(404, "Reversed preview not ready")
        return FileResponse(path)

    @app.get("/api/media/{media_id}/shots")
    def media_shots(media_id: str):
        _item(media_id)
        try:
            return SH.analyse(service.registry, media_id)
        except ValueError as error:
            raise HTTPException(400, str(error))

    @app.get("/api/media/{media_id}/original")
    def media_original(media_id: str):
        item = _item(media_id)
        if not os.path.isfile(item["path"]):
            raise HTTPException(404, "File missing")
        return FileResponse(item["path"])

    @app.get("/api/media/{media_id}/thumbs")
    def media_thumbs(media_id: str):
        _item(media_id)
        path = service.registry.cached_file(media_id, "thumbs.jpg")
        if not path:
            raise HTTPException(404, "Not ready")
        return FileResponse(path, headers={"Cache-Control": "max-age=86400"})

    @app.get("/api/media/{media_id}/wave")
    def media_wave(media_id: str):
        _item(media_id)
        path = service.registry.cached_file(media_id, "wave.json")
        if not path:
            raise HTTPException(404, "Not ready")
        return FileResponse(path, media_type="application/json", headers={"Cache-Control": "max-age=86400"})

    @app.get("/api/media/{media_id}/metadata")
    def media_metadata(media_id: str):
        _item(media_id)
        path = service.registry.cached_file(media_id, "metadata.json")
        if not path:
            return {}
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)

    @app.get("/api/media/{media_id}/frame")
    def media_frame(media_id: str, t: float = 0.0):
        """One frame of the original file as a JPEG (start / end image previews)."""
        item = _item(media_id)
        if item["kind"] not in ("video", "image") or not os.path.isfile(item["path"]):
            raise HTTPException(404, "No picture")
        folder = os.path.join(service.temp_dir, "frames")
        os.makedirs(folder, exist_ok=True)
        out = os.path.join(folder, f"{media_id}_{int(round(t * 1000))}.jpg")
        if not os.path.isfile(out):
            try:
                RG.extract_frame(item["path"], t, out)
            except Exception as error:
                raise HTTPException(500, str(error))
        return FileResponse(out, headers={"Cache-Control": "max-age=86400"})

    # ------------------------------------------------------------------ stabilise
    stab_jobs = {}
    stab_caps = {}

    def _has_vidstab():
        if "vidstab" not in stab_caps:
            try:
                out = M.run([M.ffmpeg_path(), "-hide_banner", "-filters"], timeout=30).stdout or ""
                stab_caps["vidstab"] = "vidstabdetect" in out and "vidstabtransform" in out
            except Exception:
                stab_caps["vidstab"] = False
        return stab_caps["vidstab"]

    def _stabilise(job_id, item, smoothing, zoom):
        """Write a stabilised copy of a video: two-pass vidstab when this ffmpeg has it (motion analysis, then
        smoothing over `smoothing` frames either side), else ffmpeg's deshake. zoom: scale up to hide the moving
        edges, else leave them black. Sound is copied as it is."""
        job = stab_jobs[job_id]
        try:
            folder = os.path.join(service.data_root, "stabilised")
            os.makedirs(folder, exist_ok=True)
            base = _safe_name(os.path.splitext(os.path.basename(item["path"]))[0], "clip")
            out = os.path.join(folder, f"{base}_stab.mp4")
            n = 1
            while os.path.exists(out):
                n += 1
                out = os.path.join(folder, f"{base}_stab{n}.mp4")
            enc = ["-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart"]
            work = os.path.join(service.temp_dir, f"stab_{job_id}")
            os.makedirs(work, exist_ok=True)
            if _has_vidstab():
                job.update(stage="Analysing the motion", method="vidstab")
                # relative file names (run in the work folder): a Windows drive letter's colon would break the filter
                r = subprocess.run([M.ffmpeg_path(), "-y", "-v", "error", "-i", item["path"], "-vf", "vidstabdetect=shakiness=6:accuracy=15:result=motion.trf", "-f", "null", "-"],
                                   cwd=work, capture_output=True, text=True, timeout=7200, **M.popen_kwargs())
                if r.returncode != 0:
                    raise RuntimeError((r.stderr or "analysis failed").strip()[-300:])
                job.update(stage="Smoothing and rendering")
                vf = f"vidstabtransform=input=motion.trf:smoothing={int(smoothing)}:optzoom={1 if zoom else 0}:zoomspeed=0.2:interpol=bicubic,unsharp=5:5:0.4:3:3:0.2"
            else:
                job.update(stage="Stabilising", method="deshake")
                w, h = int(item.get("width") or 0), int(item.get("height") or 0)
                vf = "deshake=rx=48:ry=48:edge=blank" + (f",crop=iw*0.9:ih*0.9,scale={w}:{h}:flags=bicubic" if zoom and w and h else "")
            r = subprocess.run([M.ffmpeg_path(), "-y", "-v", "error", "-i", item["path"], "-vf", vf] + enc + [out],
                               cwd=work, capture_output=True, text=True, timeout=7200, **M.popen_kwargs())
            if r.returncode != 0 or not os.path.isfile(out):
                raise RuntimeError((r.stderr or "render failed").strip()[-300:])
            job.update(status="done", stage="Done", media=service.registry.public(service.registry.register(out)))
        except Exception as error:
            job.update(status="error", error=str(error))
        finally:
            try:
                import shutil
                shutil.rmtree(os.path.join(service.temp_dir, f"stab_{job_id}"), ignore_errors=True)
            except Exception:
                pass

    @app.post("/api/media/{media_id}/stabilise")
    def media_stabilise(media_id: str, payload: dict = Body(default={})):
        item = _item(media_id)
        if item["kind"] != "video" or not os.path.isfile(item["path"]):
            raise HTTPException(400, "Only video files can be stabilised")
        job_id = uuid.uuid4().hex[:10]
        stab_jobs[job_id] = {"id": job_id, "status": "running", "stage": "Starting", "mediaId": media_id}
        smoothing = max(4, min(120, int(payload.get("smoothing") or 30)))
        threading.Thread(target=_stabilise, args=(job_id, item, smoothing, payload.get("zoom", True) is not False), daemon=True).start()
        return stab_jobs[job_id]

    @app.get("/api/stabilise/{job_id}")
    def stabilise_status(job_id: str):
        if job_id not in stab_jobs:
            raise HTTPException(404, "Unknown job")
        return stab_jobs[job_id]

    @app.get("/api/media/{media_id}/loudness")
    def media_loudness(media_id: str, a: float = 0.0, b: float = 0.0):
        """Integrated loudness (LUFS) and true peak (dBTP) of a stretch of a file's sound (normalise a clip)."""
        import re
        item = _item(media_id)
        if not os.path.isfile(item["path"]) or not (item.get("has_audio") or item["kind"] == "audio"):
            raise HTTPException(404, "No sound")
        args = [M.ffmpeg_path(), "-hide_banner", "-nostats", "-ss", f"{max(0.0, a):.4f}"]
        if b > a:
            args += ["-t", f"{b - a:.4f}"]
        result = M.run(args + ["-i", item["path"], "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], timeout=900)
        text = result.stderr or ""
        summary = text[text.rfind("Summary:"):] if "Summary:" in text else text
        num = lambda m: float(m.group(1)) if m and m.group(1) not in ("-inf", "inf", "nan") else None
        return {"lufs": num(re.search(r"I:\s*(-?[\d.]+|-inf)\s*LUFS", summary)),
                "peak": num(re.search(r"Peak:\s*(-?[\d.]+|-inf)\s*dBFS", summary))}

    @app.get("/api/media/{media_id}/speech")
    def media_speech(media_id: str, a: float = 0.0, b: float = 0.0, sensitivity: float = 0.5):
        """Where someone is speaking in a stretch of a file: [[t0, t1], ...] in source seconds (auto-ducking).
        Speech-band (250 Hz to 3.5 kHz) loudness against a threshold set between the stretch's quiet floor and its
        loud level; sensitivity 0..1 lowers the threshold (more counts as speech). Short blips are dropped, short
        pauses inside a line bridged."""
        import numpy as np
        item = _item(media_id)
        if not os.path.isfile(item["path"]) or not (item.get("has_audio") or item["kind"] == "audio"):
            raise HTTPException(404, "No sound")
        end = b if b > a else float(item.get("duration") or 0)
        times, db = RG.speech_envelope(item["path"], a, end, hop=0.02)
        if times is None:
            return {"segments": []}
        loud, floor = float(np.percentile(db, 95)), float(np.percentile(db, 10))
        if loud < -55 or loud - floor < 8:
            return {"segments": [], "loud": loud, "floor": floor}
        k = 0.75 - 0.5 * min(1.0, max(0.0, sensitivity))
        level = floor + (loud - floor) * k
        on = db > level
        segs, start = [], None
        for i, v in enumerate(on):
            if v and start is None:
                start = float(times[i]) - 0.01
            if (not v or i == len(on) - 1) and start is not None:
                segs.append([start, float(times[i]) + 0.01])
                start = None
        merged = []
        for s0, s1 in segs:                      # bridge pauses under 0.3 s
            if merged and s0 - merged[-1][1] < 0.3:
                merged[-1][1] = s1
            else:
                merged.append([s0, s1])
        return {"segments": [[round(x, 3), round(y, 3)] for x, y in merged if y - x >= 0.15], "loud": loud, "floor": floor}

    # ------------------------------------------------------------------ regeneration
    @app.get("/api/regen/status")
    def regen_status():
        return service.regen.status()

    @app.post("/api/regen/prepare")
    def regen_prepare(payload: dict = Body(...)):
        try:
            return service.regen.prepare(payload)
        except ValueError as error:
            raise HTTPException(400, str(error))

    @app.post("/api/regen/submit")
    def regen_submit(payload: dict = Body(...)):
        try:
            return service.regen.submit(payload)
        except ValueError as error:
            raise HTTPException(400, str(error))

    @app.get("/api/regen/jobs")
    def regen_jobs(project: str = None):
        return {"jobs": service.regen.list(project)}

    @app.post("/api/regen/jobs/{job_id}/cancel")
    def regen_cancel(job_id: str):
        service.regen.cancel(job_id)
        return {"ok": True}

    @app.post("/api/gen/prepare")
    def gen_prepare(payload: dict = Body(...)):
        try:
            return service.regen.compose_prepare(payload)
        except ValueError as error:
            raise HTTPException(400, str(error))

    @app.post("/api/gen/submit")
    def gen_submit(payload: dict = Body(...)):
        try:
            return service.regen.compose_submit(payload)
        except ValueError as error:
            raise HTTPException(400, str(error))

    @app.post("/api/render/prepare")
    def render_prepare(payload: dict = Body(...)):
        try:
            return service.regen.render_prepare(payload)
        except (ValueError, KeyError) as error:
            raise HTTPException(400, str(error))

    @app.post("/api/render/submit")
    def render_submit(payload: dict = Body(...)):
        try:
            return service.regen.render_submit(payload)
        except (ValueError, KeyError) as error:
            raise HTTPException(400, str(error))

    @app.post("/api/gen/drift")
    def gen_drift(payload: dict = Body(...)):
        try:
            return service.regen.drift(payload.get("mediaIds") or [])
        except ValueError as error:
            raise HTTPException(400, str(error))

    @app.post("/api/gen/windows")
    def gen_windows(payload: dict = Body(...)):
        try:
            return service.regen.window_cuts(payload["mediaId"])
        except (ValueError, KeyError) as error:
            raise HTTPException(400, str(error))

    @app.post("/api/gen/seam")
    def gen_seam(payload: dict = Body(...)):
        try:
            return service.regen.seam(payload)
        except (ValueError, KeyError) as error:
            raise HTTPException(400, str(error))

    @app.post("/api/gen/joinmatch")
    def gen_join_match(payload: dict = Body(...)):
        try:
            return service.regen.join_match(payload)
        except (ValueError, KeyError) as error:
            raise HTTPException(400, str(error))

    @app.get("/api/regen/jobs/{job_id}/preview")
    def regen_preview(job_id: str):
        path, kind = service.regen.preview_path(job_id)
        if not path:
            raise HTTPException(404, "No preview yet")
        return FileResponse(path, media_type="video/mp4" if kind == "mp4" else "image/jpeg", headers={"Cache-Control": "no-store"})

    @app.post("/api/regen/jobs/{job_id}/dismiss")
    def regen_dismiss(job_id: str):
        try:
            service.regen.dismiss(job_id)
        except ValueError as error:
            raise HTTPException(400, str(error))
        return {"ok": True}

    # ------------------------------------------------------------------ LUTs and fonts
    @app.get("/api/luts")
    def list_luts():
        names = sorted(entry.name[:-5] for entry in os.scandir(service.luts_dir) if entry.name.lower().endswith(".cube"))
        return names

    @app.post("/api/luts")
    async def upload_luts(files: list[UploadFile] = File(...)):
        saved, errors = [], []
        for upload_file in files:
            raw = await upload_file.read()
            name = L.safe_name(upload_file.filename)
            try:
                text = raw.decode("utf-8", "ignore")
                L.parse_cube(text)
            except Exception as error:
                errors.append({"name": upload_file.filename, "error": str(error)})
                continue
            with open(os.path.join(service.luts_dir, name + ".cube"), "w", encoding="utf-8") as handle:
                handle.write(text)
            saved.append(name)
        return {"saved": saved, "errors": errors}

    @app.get("/api/luts/{name}")
    def get_lut(name: str):
        path = os.path.join(service.luts_dir, L.safe_name(name) + ".cube")
        if not os.path.isfile(path):
            raise HTTPException(404, "LUT not found")
        with open(path, "r", encoding="utf-8", errors="ignore") as handle:
            return PlainTextResponse(handle.read())

    @app.delete("/api/luts/{name}")
    def delete_lut(name: str):
        path = os.path.join(service.luts_dir, L.safe_name(name) + ".cube")
        if os.path.isfile(path):
            os.remove(path)
        return {"ok": True}

    # ------------------------------------------------------------------ hand-off and collect
    from . import interchange as IX
    collect_jobs = {}

    def _unique_export(base, ext):
        base = _safe_name(base or "timeline")
        out = os.path.join(service.exports_dir, base + ext)
        k = 1
        while os.path.exists(out):
            out = os.path.join(service.exports_dir, f"{base}_{k}{ext}")
            k += 1
        return out

    @app.post("/api/interchange/{fmt}")
    def interchange(fmt: str, payload: dict = Body(...)):
        """The open timeline as FCP 7 XML (Premiere, Resolve) or a CMX 3600 EDL, saved with the exports."""
        project = payload.get("project") or {}
        if fmt not in ("xml", "edl"):
            raise HTTPException(400, "Unknown format")
        text, notes = IX.to_xmeml(project) if fmt == "xml" else IX.to_edl(project)
        if not text:
            raise HTTPException(400, "; ".join(notes) or "Nothing to export")
        tl = next((t.get("name") for t in project.get("timelines") or [] if t.get("id") == project.get("activeTimeline")), None)
        out = _unique_export(f"{project.get('name') or 'project'}{'_' + tl if tl else ''}", "." + fmt)
        with open(out, "w", encoding="utf-8", newline="\r\n" if fmt == "edl" else None) as handle:
            handle.write(text)
        return {"name": os.path.basename(out), "path": out, "notes": notes}

    def _collect(job_id, project, out):
        job = collect_jobs[job_id]
        try:
            res = IX.collect(project, service.luts_dir, out, progress=lambda f, msg: job.update(progress=round(f, 4), message=msg),
                             cancelled=lambda: job.get("cancel"))
            job.update(status="done", progress=1.0, message="Done", name=os.path.basename(out), path=out, **res)
        except Exception as error:
            try:
                if os.path.exists(out + ".part"):
                    os.remove(out + ".part")
            except OSError:
                pass
            job.update(status="cancelled" if job.get("cancel") else "error", error=str(error))

    @app.post("/api/collect")
    def collect_start(payload: dict = Body(...)):
        """Zip the project with every file it uses (all its timelines) and its LUTs, in the background."""
        project = payload.get("project") or {}
        media = project.get("media") or {}
        need = sum(os.path.getsize(media[m]["path"]) for m in IX.used_media_ids(project) if os.path.isfile(media[m]["path"]))
        out = _unique_export(f"{project.get('name') or 'project'}_collected", ".zip")
        try:
            M.need_space(out, int(need * 1.05 + 100e6), "the collected project")
        except ValueError as error:
            raise HTTPException(400, str(error))
        job_id = uuid.uuid4().hex[:10]
        collect_jobs[job_id] = {"id": job_id, "status": "running", "progress": 0.0, "message": "Starting", "bytes_total": need}
        threading.Thread(target=_collect, args=(job_id, project, out), daemon=True).start()
        return collect_jobs[job_id]

    @app.get("/api/collect/{job_id}")
    def collect_status(job_id: str):
        if job_id not in collect_jobs:
            raise HTTPException(404, "Unknown job")
        return collect_jobs[job_id]

    @app.post("/api/collect/{job_id}/cancel")
    def collect_cancel(job_id: str):
        if job_id in collect_jobs:
            collect_jobs[job_id]["cancel"] = True
        return {"ok": True}

    # ------------------------------------------------------------------ speech to captions (WanGP's Whisper)
    speech_jobs = {}

    @app.get("/api/transcribe/available")
    def transcribe_available():
        return TX.available()

    @app.post("/api/transcribe")
    def transcribe_start(payload: dict = Body(...)):
        """Transcribe stretches of source files ({ranges: [{key, mediaId, a, b}], model, language}) in the background.
        Waits for no generation to be running (Whisper and a generation would share the GPU)."""
        why = TX.available()["why"]
        if why:
            raise HTTPException(400, why)
        ranges = []
        for r in payload.get("ranges") or []:
            item = _item(r["mediaId"])
            if not os.path.isfile(item["path"]):
                raise HTTPException(400, f"{item.get('name') or 'A file'} is missing: relink it first")
            ranges.append({"key": str(r["key"]), "path": item["path"], "a": max(0.0, float(r.get("a") or 0)), "b": float(r.get("b") or item.get("duration") or 0)})
        if not ranges:
            raise HTTPException(400, "Nothing to transcribe")
        job_id = uuid.uuid4().hex[:10]
        job = speech_jobs[job_id] = {"id": job_id, "status": "running", "progress": 0.0, "message": "Starting"}

        def busy():
            return any(j.get("status") in ("queued", "running") for j in list(service.regen.jobs.values()))

        def run():
            def progress(f, m):
                job.update(progress=f, message=m)
            try:
                while busy() and not job.get("cancel"):
                    job["message"] = "Waiting for the generation that's running to finish (Whisper shares the GPU)"
                    time.sleep(2)
                job["result"] = TX.transcribe(ranges, os.path.join(service.data_root, "transcripts"), service.temp_dir,
                                              model=payload.get("model") or None, language=payload.get("language") or None,
                                              progress=progress, cancelled=lambda: bool(job.get("cancel")))
                job.update(status="done", progress=1.0, message="Done")
            except Exception as error:                              # noqa: BLE001
                job.update(status="cancelled" if job.get("cancel") else "error", message=str(error))
        threading.Thread(target=run, daemon=True, name=f"video_editor_speech_{job_id}").start()
        return job

    @app.get("/api/transcribe/{job_id}")
    def transcribe_status(job_id: str):
        if job_id not in speech_jobs:
            raise HTTPException(404, "Unknown job")
        return speech_jobs[job_id]

    @app.post("/api/transcribe/{job_id}/cancel")
    def transcribe_cancel(job_id: str):
        if job_id in speech_jobs:
            speech_jobs[job_id]["cancel"] = True
        return {"ok": True}

    @app.post("/api/collect/open")
    async def collect_open(file: UploadFile = File(...)):
        """Open a collected project ZIP: unpack it under collected/, relink its files where they landed, save it as a
        project and return its name."""
        stem = _safe_name(os.path.splitext(os.path.basename(file.filename or "project"))[0], "project")
        tmp = os.path.join(service.temp_dir, f"open_{uuid.uuid4().hex[:8]}.zip")
        with open(tmp, "wb") as handle:
            while True:
                chunk = await file.read(8 * 1024 * 1024)
                if not chunk:
                    break
                handle.write(chunk)
        try:
            dest = os.path.join(service.data_root, "collected", stem)
            k = 1
            while os.path.exists(dest):
                k += 1
                dest = os.path.join(service.data_root, "collected", f"{stem}_{k}")
            os.makedirs(dest, exist_ok=True)
            M.need_space(dest, int(os.path.getsize(tmp) * 1.05 + 100e6), "unpacking the project")
            project = IX.open_collected(tmp, dest, service.luts_dir)
        except (ValueError, zipfile.BadZipFile) as error:
            raise HTTPException(400, str(error))
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
        notes = []
        for mid, item in (project.get("media") or {}).items():
            if item.get("generator") or not item.get("path"):
                continue
            if not os.path.isfile(item["path"]):
                notes.append(f"{item.get('name')} wasn't in the ZIP")
                continue
            try:
                fresh, warning = service.registry.relink(mid, item["path"], item)
                project["media"][mid] = {**item, **service.registry.public(fresh)}
                if warning:
                    notes.append(warning)
            except Exception as error:
                notes.append(f"{item.get('name')}: {error}")
        name = _safe_name(project.get("name") or stem)
        base, k = name, 1
        while os.path.exists(_project_path(name)):
            k += 1
            name = f"{base} ({k})"
        project["name"] = name
        with open(_project_path(name), "w", encoding="utf-8") as handle:
            json.dump(project, handle)
        return {"name": name, "folder": dest, "notes": notes}

    # ------------------------------------------------------------------ projects
    def _project_path(name):
        return os.path.join(service.projects_dir, _safe_name(name) + ".json")

    @app.get("/api/projects")
    def list_projects():
        items = []
        for entry in os.scandir(service.projects_dir):
            if entry.name.endswith(".json"):
                items.append({"name": entry.name[:-5], "mtime": entry.stat().st_mtime})
        items.sort(key=lambda p: -p["mtime"])
        return items

    @app.get("/api/projects/{name}")
    def get_project(name: str):
        path = _project_path(name)
        if not os.path.isfile(path):
            raise HTTPException(404, "Project not found")
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)

    @app.put("/api/projects/{name}")
    def put_project(name: str, project: dict = Body(...)):
        path = _project_path(name)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(project, handle)
        os.replace(tmp, path)
        return {"ok": True, "name": _safe_name(name), "saved": time.time()}

    @app.delete("/api/projects/{name}")
    def delete_project(name: str):
        path = _project_path(name)
        if os.path.isfile(path):
            os.remove(path)
        return {"ok": True}

    # ------------------------------------------------------------------ export
    @app.post("/api/export")
    def start_export(payload: dict = Body(...)):
        project, options = payload.get("project") or {}, payload.get("options") or {}
        R.detect_hw_codecs()      # a hardware encoder picked before detection finished still resolves
        codec = R.CODECS.get(options.get("codec") or "h264", R.CODECS["h264"])
        base = _safe_name(options.get("filename") or project.get("name") or "export")
        out_path = os.path.join(service.exports_dir, base + codec["ext"])
        counter = 1
        while os.path.exists(out_path):
            out_path = os.path.join(service.exports_dir, f"{base}_{counter}{codec['ext']}")
            counter += 1
        # enough room for the file and the temporary sound mix? (a rough, generous estimate)
        try:
            ends = [float(c.get("start") or 0) + abs(float(c.get("out") or 0) - float(c.get("in") or 0)) / max(0.01, abs(float(c.get("speed") or 1)))
                    for c in project.get("clips") or [] if not c.get("disabled")]
            start, end = float(options.get("start") or 0), float(options.get("end") or 0) or max(ends or [0])
            seconds = max(0.0, end - start)
            w, h = int(options.get("width") or (project.get("settings") or {}).get("width") or 1920), int(options.get("height") or (project.get("settings") or {}).get("height") or 1080)
            fps = float(options.get("fps") or (project.get("settings") or {}).get("fps") or 24)
            key = (options.get("codec") or "h264").lower()
            bpp = 4.5 if ("prores" in key or "dnx" in key) else 0.1 if ("265" in key or "hevc" in key or "av1" in key) else 0.25
            video = 0 if codec.get("kind") in ("audio", "still") else w * h * fps * seconds * bpp / 8
            M.need_space(out_path, int(video * 1.3 + 200e6), "this export")
            M.need_space(service.temp_dir, int(seconds * 48000 * 2 * 4 * 1.2 + 100e6), "this export's temporary sound mix")
        except ValueError as error:
            raise HTTPException(400, str(error))
        job_id = uuid.uuid4().hex[:12]
        job = R.ExportJob(job_id, project, options, service.registry, out_path, service.temp_dir)
        service.jobs[job_id] = job
        service.export_pool.submit(job.run)
        return job.public()

    @app.get("/api/jobs/{job_id}")
    def job_status(job_id: str):
        job = service.jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "Unknown job")
        return job.public()

    @app.post("/api/jobs/{job_id}/cancel")
    def job_cancel(job_id: str):
        job = service.jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "Unknown job")
        job.cancel_event.set()
        return job.public()

    @app.get("/api/exports/{name}")
    def get_export(name: str):
        path = os.path.join(service.exports_dir, os.path.basename(name))
        if not os.path.isfile(path):
            raise HTTPException(404, "Export not found")
        return FileResponse(path, filename=os.path.basename(path))

    @app.post("/api/exports/import")
    def import_export(payload: dict = Body(...)):
        path = os.path.join(service.exports_dir, os.path.basename(payload.get("name", "")))
        return service.registry.public(service.registry.register(path))

    return app
