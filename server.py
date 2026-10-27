"""The editor's web application: static front-end plus a JSON API for media, projects and export."""

import json
import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import media as M
from . import render as R

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
    def __init__(self, get_config):
        self.get_config = get_config
        config = get_config() or {}
        self.save_path = os.path.abspath(config.get("save_path") or "outputs")
        self.image_save_path = os.path.abspath(config.get("image_save_path") or self.save_path)
        self.data_root = os.path.join(self.save_path, "video_editor")
        self.projects_dir = os.path.join(self.data_root, "projects")
        self.exports_dir = os.path.join(self.data_root, "exports")
        self.temp_dir = os.path.join(self.data_root, "temp")
        for folder in (self.projects_dir, self.exports_dir, self.temp_dir):
            os.makedirs(folder, exist_ok=True)
        self.registry = M.MediaRegistry(self.data_root)
        self.jobs = {}
        self.export_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="video_editor_export")
        self.lock = threading.Lock()


def create_app(get_config):
    service = EditorService(get_config)
    app = FastAPI(title="WanGP Video Editor", docs_url=None, redoc_url=None, openapi_url=None)
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
                "codecs": [{"id": key, "label": value["label"]} for key, value in R.CODECS.items()],
                "roots": [{"label": "WanGP outputs", "path": service.save_path},
                          {"label": "WanGP image outputs", "path": service.image_save_path},
                          {"label": "Editor uploads", "path": service.registry.upload_dir},
                          {"label": "Editor exports", "path": service.exports_dir}]}

    # ------------------------------------------------------------------ browsing / import
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
        codec = R.CODECS.get(options.get("codec") or "h264", R.CODECS["h264"])
        base = _safe_name(options.get("filename") or project.get("name") or "export")
        out_path = os.path.join(service.exports_dir, base + codec["ext"])
        counter = 1
        while os.path.exists(out_path):
            out_path = os.path.join(service.exports_dir, f"{base}_{counter}{codec['ext']}")
            counter += 1
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
