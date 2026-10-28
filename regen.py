"""Shot regeneration: rebuild a WanGP task for one shot of a generated clip, queue it in WanGP's main queue and hand
the result back to the editor as a new take.

The prompt of a sliding-window H3 generation is a list of windows ([/duration=..]) whose detailed description holds
[Shot N] entries timed with 'At mm:ss.sss'. For a shot (a source time range of the clip) we keep the window's subject
definitions and other sections, replace its shot list with the shots inside the range, renumber them from [Shot 1]
and move every 'At' time so the range starts at 00:00."""

import copy
import json
import math
import os
import random
import re
import subprocess
import threading
import time
import uuid

from . import compose as C
from . import media as M

# Keys WanGP writes into an output's metadata that are not generation settings.
META_ONLY = {"type", "generation_time", "creation_date", "creation_timestamp", "output_role", "window_no", "extra_info",
             "model_filename", "config", "state", "client_id", "plugin_data", "output_filename"}
# Inputs from the original task that must not leak into a regeneration (we set our own).
MEDIA_KEYS = {"image_start", "image_end", "video_source", "video_guide", "video_guide2", "video_guide3", "video_mask",
              "audio_guide", "audio_guide2", "audio_guide3", "audio_source", "keep_frames_video_source"}

_WINDOW = re.compile(r"\[/duration=([\d.]+)s([^\]]*)\]")
_SHOT = re.compile(r"\[Shot\s+(\d+)\]")
_AT = re.compile(r"\bAt\s+(\d+):(\d+(?:\.\d+)?)")
# A line that starts another prompt section: an XML-style tag (<overall_soundscape>, </detailed_description>) or a
# plain heading ("overall_soundscape:").
_SECTION = re.compile(r"^[ \t]*(?:</?[A-Za-z_]+>|[a-z_]+:)[ \t]*$", re.M)
_DESCRIPTION = re.compile(r"<detailed_description>|^[ \t]*detailed_description:[ \t]*$", re.M)
_LEAD_AT = re.compile(r"\s*At\s+(\d+):(\d+(?:\.\d+)?)")
_CUT_LEAD = re.compile(r"^\s*At\s+\d+:\d+(?:\.\d+)?\s*,\s*", re.I)
_CAMERA_CUT = re.compile(r"^the camera (?:cuts|hard-cuts|smash-cuts)(?: back)? to ", re.I)


def shot_region_start(text):
    """Where a window's shot list can start: after its detailed-description heading when it has one, so mentions such as
    "(appears in [Shot 1], [Shot 2])" in other sections are not taken for shots."""
    m = _DESCRIPTION.search(text)
    return m.end() if m else 0


def find_shots(text):
    return list(_SHOT.finditer(text, shot_region_start(text)))


def _seconds(match):
    return int(match.group(1)) * 60 + float(match.group(2))


def fmt_time(t):
    t = max(0.0, t)
    return f"{int(t // 60):02d}:{t - 60 * int(t // 60):06.3f}"


def parse_prompt(prompt, fps, default_overlap=0.0):
    """Windows of a prompt, each with its source start time and its shots (with character spans inside the window
    text). Prompts without window markers are one window."""
    prompt = str(prompt or "")
    fps = fps or 24.0
    marks = list(_WINDOW.finditer(prompt))
    blocks = []
    if marks:
        for i, m in enumerate(marks):
            end = marks[i + 1].start() if i + 1 < len(marks) else len(prompt)
            overlap = re.search(r"/overlap=(\d+)", m.group(2))
            blocks.append({"duration": float(m.group(1)), "overlap": float(overlap.group(1)) if overlap else float(default_overlap or 0),
                           "text": prompt[m.end():end]})
    else:
        blocks.append({"duration": None, "overlap": 0.0, "text": prompt})
    start = 0.0
    for w, block in enumerate(blocks):
        if w > 0:
            start += (blocks[w - 1]["duration"] or 0) - block["overlap"] / fps
        block["index"] = w + 1
        block["start"] = start
        text = block["text"]
        found = find_shots(text)
        sections = [m.start() for m in _SECTION.finditer(text)]
        shots = []
        previous = 0.0
        for i, m in enumerate(found):
            end = found[i + 1].start() if i + 1 < len(found) else len(text)
            end = min([end] + [s for s in sections if s > m.end()])
            body = text[m.end():end]
            at = _LEAD_AT.match(body)
            number = int(m.group(1))
            offset = _seconds(at) if at else (0.0 if number == 1 or not shots else previous)
            previous = offset
            shots.append({"window": w + 1, "shot": number, "offset": offset, "span": (m.start(), end), "body": body.strip()})
        block["shots"] = shots
    for w, block in enumerate(blocks):
        win_end = block["start"] + block["duration"] if block["duration"] else None
        for i, s in enumerate(block["shots"]):
            s["start"] = block["start"] + s["offset"]
            s["end"] = (block["start"] + block["shots"][i + 1]["offset"]) if i + 1 < len(block["shots"]) else win_end
    return blocks


def _rebase(body, shift, first):
    """Move every 'At' time in a shot by -shift seconds; the first shot loses its leading cue and 'the camera cuts to'."""
    if first:
        body = _CUT_LEAD.sub("", body, count=1)
        stripped = _CAMERA_CUT.sub("", body, count=1)
        if stripped != body:
            body = stripped[:1].upper() + stripped[1:]
    return _AT.sub(lambda m: f"At {fmt_time(_seconds(m) - shift)}", body)


def shot_prompt(prompt, fps, a, b, default_overlap=0.0):
    """Prompt for the source range [a, b] of a generated clip, and the shots it contains ([] when the prompt has no
    shot list, in which case the window that holds `a` is returned without its marker)."""
    blocks = parse_prompt(prompt, fps, default_overlap)
    eps = 0.05
    selected = [s for block in blocks for s in block["shots"]
                if s["start"] < b - eps and (s["end"] is None or s["end"] > a + eps)]
    if not selected:
        block = next((bl for bl in reversed(blocks) if bl["start"] <= a + eps), blocks[0])
        return block["text"].strip(), []
    # Windows overlap: shot 1 of a later window that carries on the previous window's last shot (no cut) is the same
    # camera shot, already described.
    unique = []
    for s in selected:
        if unique and s["shot"] == 1 and s["window"] != unique[-1]["window"]:
            continue
        unique.append(s)
    selected = unique
    if abs(selected[0]["start"] - a) < 1.5 / fps:
        a = selected[0]["start"]   # the cut was snapped to a frame: time the prompt from the shot's own start
    block = blocks[selected[0]["window"] - 1]
    text = block["text"]
    first_span = block["shots"][0]["span"][0]
    last_span = block["shots"][-1]["span"][1]
    parts = []
    for i, s in enumerate(selected):
        win = blocks[s["window"] - 1]
        shift = a - win["start"]
        parts.append(f"[Shot {i + 1}] " + _rebase(s["body"], shift, i == 0))
    middle = "\n".join(parts)
    suffix = text[last_span:]
    if not suffix.startswith("\n"):
        suffix = "\n" + suffix.lstrip(" ")
    return (text[:first_span] + middle + suffix).strip(), [{"window": s["window"], "shot": s["shot"], "start": s["start"]} for s in selected]


def allowed_frames(n, model_def):
    """The smallest frame count the model accepts that is >= n."""
    minimum = int(model_def.get("frames_minimum", 5) or 5)
    step = max(1, int(model_def.get("frames_steps", 4) or 4))
    offset = int(model_def.get("frames_offset", 1) or 1)
    n = max(int(math.ceil(n)), minimum)
    k = max(0, int(math.ceil((n - offset) / step)))
    frames = offset + k * step
    while frames < minimum:
        frames += step
    return frames


def capabilities(model_def):
    """What a model supports for regeneration."""
    model_def = model_def or {}
    images = str(model_def.get("image_prompt_types_allowed", "") or "")
    audio_sources = ((model_def.get("audio_prompt_type_sources") or {}).get("selection")) or []
    return {"start": "S" in images, "end": "E" in images, "extend": "V" in images and bool(model_def.get("video_continuation", True)),
            "keepAudio": "AS" in audio_sources, "fps": float(model_def.get("fps", 16) or 16),
            "framesMinimum": int(model_def.get("frames_minimum", 5) or 5), "framesSteps": int(model_def.get("frames_steps", 4) or 4)}


def base_settings(settings):
    out = {k: copy.deepcopy(v) for k, v in (settings or {}).items() if k not in META_ONLY and k not in MEDIA_KEYS}
    return out


def build_task(base, *, prompt, seed, frames, fps, start_image=None, end_image=None, keep_audio=None, video_source=None,
               model_def=None):
    """WanGP settings for a regeneration. base: the clip's (or the Media Generator's) settings."""
    settings = base_settings(base)
    settings["prompt"] = prompt
    settings["seed"] = int(seed)
    settings["video_length"] = int(frames)
    settings["repeat_generation"] = 1
    settings["multi_prompts_gen_type"] = settings.get("multi_prompts_gen_type") or "PW"
    window = int(settings.get("sliding_window_size") or 0)
    window_max = int(((model_def or {}).get("sliding_window_defaults") or {}).get("window_max") or 0)
    if window and frames > window:
        settings["sliding_window_size"] = min(frames, window_max) if window_max else frames
    letters = ""
    if video_source:
        letters += "V"
        settings["video_source"] = video_source
    if start_image and not video_source:
        letters += "S"
        settings["image_start"] = start_image
    if end_image:
        letters += "E"
        settings["image_end"] = end_image
    settings["image_prompt_type"] = letters
    if keep_audio:
        settings["audio_prompt_type"] = "AS"
        settings["audio_guide"] = keep_audio
    elif "S" in str(settings.get("audio_prompt_type") or ""):
        settings["audio_prompt_type"] = ""
    return settings


# --------------------------------------------------------------------------- RefMods

REFMOD_SETTING = "h3_refmod_state"
REFMODS_REL = ("loras", "refmods_plugin", "minimax_h3")   # the RefMod plugin's storage, under the WanGP root


def refmods_root():
    return os.path.join(os.getcwd(), *REFMODS_REL)   # WanGP runs from its install folder


def relink_refmods(settings, root=None):
    """RefMods saved in a clip's settings are named by their path inside the RefMod folder. If a mod has been moved
    into a subfolder since the clip was made, find it by file name and point the task at its new place.
    Returns (settings, notes); notes describe what was relinked or is missing."""
    custom = (settings or {}).get("custom_settings")
    if not isinstance(custom, dict) or not custom.get(REFMOD_SETTING):
        return settings, []
    root = root or refmods_root()
    try:
        blob = custom[REFMOD_SETTING]
        state = json.loads(blob) if isinstance(blob, str) else copy.deepcopy(blob)
    except Exception:
        return settings, []
    rows = state.get("rows") if isinstance(state, dict) else None
    if not isinstance(rows, list) or not os.path.isdir(root):
        return settings, []
    index = None
    notes, changed = [], False
    for row in rows:
        name = str((row or {}).get("mod") or "").replace("\\", "/").strip("/")
        if not name:
            continue
        if os.path.isfile(os.path.join(root, *name.split("/")) + ".safetensors"):
            continue
        if index is None:
            index = {}
            for folder, _, files in os.walk(root):
                for f in files:
                    if f.lower().endswith(".safetensors"):
                        rel = os.path.relpath(os.path.join(folder, f[:-len(".safetensors")]), root).replace(os.sep, "/")
                        index.setdefault(f[:-len(".safetensors")].lower(), []).append(rel)
        found = index.get(name.split("/")[-1].lower(), [])
        if len(found) == 1:
            row["mod"] = found[0]
            changed = True
            notes.append({"mod": name, "now": found[0], "status": "relinked"})
        elif len(found) > 1:
            notes.append({"mod": name, "candidates": found, "status": "ambiguous"})
        else:
            notes.append({"mod": name, "status": "missing"})
    if changed:
        settings = dict(settings)
        settings["custom_settings"] = {**custom, REFMOD_SETTING: json.dumps(state) if isinstance(blob, str) else state}
    return settings, notes


# --------------------------------------------------------------------------- ffmpeg helpers

def _run(args):
    proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **M.popen_kwargs())
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace").strip().splitlines()[-1] if proc.stderr else "ffmpeg failed")


def extract_frame(path, t, out_path):
    _run([M.ffmpeg_path(), "-v", "error", "-y", "-ss", f"{max(0.0, t):.4f}", "-i", path, "-frames:v", "1", out_path])
    if not os.path.isfile(out_path):  # past the last frame: take the last one
        _run([M.ffmpeg_path(), "-v", "error", "-y", "-sseof", "-0.1", "-i", path, "-frames:v", "1", "-update", "1", out_path])
    return out_path


def extract_audio(path, a, b, out_path):
    _run([M.ffmpeg_path(), "-v", "error", "-y", "-ss", f"{a:.4f}", "-t", f"{max(0.04, b - a):.4f}", "-i", path, "-vn", "-ac", "2",
          "-ar", "48000", "-c:a", "pcm_s16le", out_path])
    return out_path


def extract_video(path, a, b, out_path):
    _run([M.ffmpeg_path(), "-v", "error", "-y", "-ss", f"{a:.4f}", "-t", f"{max(0.04, b - a):.4f}", "-i", path, "-c:v", "libx264",
          "-crf", "12", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", out_path])
    return out_path


# --------------------------------------------------------------------------- jobs

class RegenService:
    """Builds and queues regeneration tasks through a host (WanGP's main queue) and tracks them for the editor."""

    def __init__(self, registry, data_root, host):
        self.registry = registry
        self.host = host
        self.root = os.path.join(data_root, "regen")
        os.makedirs(self.root, exist_ok=True)
        self.jobs = {}
        self.handles = {}
        self.lock = threading.Lock()
        self._sha_cache = {}
        from .h3pins import LatentStore
        self.latents = LatentStore(os.path.join(data_root, "latents"))
        self._load()

    # ---- persistence: finished jobs survive a reload of the editor (and of WanGP) until the editor applies them
    def _index(self):
        return os.path.join(self.root, "jobs.json")

    def _load(self):
        try:
            with open(self._index(), "r", encoding="utf-8") as handle:
                for job in json.load(handle):
                    if job.get("status") in ("queued", "running"):
                        job["status"] = "error"
                        job["error"] = "WanGP restarted before the regeneration finished"
                    self.jobs[job["id"]] = job
        except Exception:
            pass

    def _save(self):
        try:
            tmp = self._index() + ".tmp"
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(list(self.jobs.values()), handle)
            os.replace(tmp, self._index())
        except Exception:
            pass

    def _update(self, job_id, **changes):
        with self.lock:
            job = self.jobs.get(job_id)
            if job:
                job.update(changes)
                if "status" in changes or "media" in changes:
                    self._save()

    # ---- info
    def status(self):
        ok, reason = self.host.available()
        current = self.host.current_settings()
        h3 = self.host.h3_status() if hasattr(self.host, "h3_status") else {"installed": False}
        return {"available": ok, "reason": reason, "h3": h3,
                "current": {"modelType": current.get("model_type"), "name": self.host.model_name(current.get("model_type")),
                            "capturedAt": current.get("_captured_at")} if current else None}

    def _settings_for(self, item, use_current):
        if use_current:
            current = self.host.current_settings()
            if not current:
                raise ValueError("No Media Generator settings yet: open the Video Generator tab, then come back to the Video Editor")
            return {k: v for k, v in current.items() if not k.startswith("_")}
        meta = self._meta(item)
        if not meta or not meta.get("model_type"):
            raise ValueError("This clip has no WanGP generation settings")
        return meta

    def _meta(self, item):
        path = self.registry.cached_file(item["id"], "metadata.json")
        if not path:
            return None
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)

    def prepare(self, req):
        item = self._item(req.get("mediaId"))
        a, b = sorted(float(x) for x in req.get("range"))
        meta = self._meta(item) or {}
        settings = self._settings_for(item, bool(req.get("useCurrent")))
        settings, refmods = relink_refmods(settings)
        model_type = settings.get("model_type")
        model_def = self.host.model_def(model_type) or {}
        caps = capabilities(model_def)
        source_fps = float(item.get("fps") or meta.get("force_fps") or caps["fps"] or 24)
        prompt_fps = caps["fps"] if not str(meta.get("force_fps") or "").strip().isdigit() else float(meta["force_fps"])
        prompt, shots = shot_prompt(meta.get("prompt") or settings.get("prompt") or "", prompt_fps, a, b, meta.get("sliding_window_overlap") or 0)
        return {"model": {"type": model_type, "name": self.host.model_name(model_type)}, "capabilities": caps,
                "originalSeed": meta.get("seed"), "prompt": prompt, "shots": shots, "range": [a, b], "sourceFps": source_fps,
                "minSeconds": caps["framesMinimum"] / caps["fps"], "refmods": refmods}

    def _item(self, media_id):
        item = self.registry.get(media_id)
        if not item:
            raise ValueError("Unknown media")
        if not os.path.isfile(item.get("path", "")):
            raise ValueError("The clip's file is missing")
        return item

    def submit(self, req):
        ok, reason = self.host.available()
        if not ok:
            raise ValueError(reason)
        item = self._item(req.get("mediaId"))
        a, b = sorted(float(x) for x in req.get("range"))
        meta = self._meta(item) or {}
        settings = self._settings_for(item, bool(req.get("useCurrent")))
        settings, _ = relink_refmods(settings)
        model_type = settings.get("model_type")
        model_def = self.host.model_def(model_type) or {}
        caps = capabilities(model_def)
        mode = req.get("mode") or "regen"
        seed = req.get("seed")
        if seed in (None, "", "new") or int(seed) < 0:
            seed = random.randint(0, 2 ** 31 - 1)
        seed = int(seed)
        length = max(0.04, float(req.get("length") or (b - a)))
        job_id = uuid.uuid4().hex[:12]
        folder = os.path.join(self.root, job_id)
        os.makedirs(folder, exist_ok=True)
        inputs = {}
        try:
            if mode == "extend":
                if not caps["extend"]:
                    raise ValueError("This model can't continue a video")
                inputs["video_source"] = extract_video(item["path"], a, b, os.path.join(folder, "source.mp4"))
                # the continuation's frame count includes the source frames it overlaps; the take is trimmed to the
                # requested extra length afterwards (the model may have a minimum length longer than that)
                overlap = int(settings.get("sliding_window_overlap") or 0)
                frames = allowed_frames(float(req.get("extra") or 2.0) * caps["fps"] + overlap, model_def)
            else:
                frames = allowed_frames(length * caps["fps"], model_def)
                start = req.get("startImage")
                if start and caps["start"]:
                    inputs["start_image"] = extract_frame(self._item(start["mediaId"])["path"], float(start["t"]), os.path.join(folder, "start.png"))
                end = req.get("endImage")
                if end and caps["end"]:
                    inputs["end_image"] = extract_frame(self._item(end["mediaId"])["path"], float(end["t"]), os.path.join(folder, "end.png"))
                if req.get("audio") == "keep" and caps["keepAudio"] and item.get("has_audio"):
                    inputs["keep_audio"] = extract_audio(item["path"], a, b, os.path.join(folder, "audio.wav"))
            if mode == "extend" and req.get("endImage") and caps["end"]:
                end = req["endImage"]
                inputs["end_image"] = extract_frame(self._item(end["mediaId"])["path"], float(end["t"]), os.path.join(folder, "end.png"))
        except ValueError:
            raise
        except Exception as error:
            raise ValueError(f"Could not prepare the inputs: {error}")
        prompt = str(req.get("prompt") or "").strip() or shot_prompt(meta.get("prompt") or "", caps["fps"], a, b)[0]
        task = build_task(settings, prompt=prompt, seed=seed, frames=frames, fps=caps["fps"], model_def=model_def, **inputs)
        with open(os.path.join(folder, "task.json"), "w", encoding="utf-8") as handle:
            json.dump(task, handle, indent=1, default=str)
        job = {"id": job_id, "status": "queued", "progress": 0.0, "message": "Queued in WanGP…", "created": time.time(),
               "project": req.get("project"), "clipId": req.get("clipId"), "mediaId": item["id"], "range": [a, b],
               "mode": mode, "seed": seed, "length": length, "extra": float(req.get("extra") or 0), "audio": "keep" if inputs.get("keep_audio") else "new",
               "model": self.host.model_name(model_type), "label": req.get("label") or "", "media": None, "error": None}
        with self.lock:
            self.jobs[job_id] = job
            self._save()
        threading.Thread(target=self._run, args=(job_id, task), daemon=True, name=f"video_editor_regen_{job_id}").start()
        return job

    def _run(self, job_id, task, plugin_data=None):
        service = self
        folder = os.path.join(self.root, job_id)
        last_preview = [0.0]

        class Callbacks:
            def on_status(self, status):
                text = str(status or "").strip()
                if text:
                    service._update(job_id, message=text)

            def on_progress(self, update):
                try:
                    p = float(getattr(update, "progress", 0) or 0) / 100.0
                except (TypeError, ValueError):
                    p = 0.0
                service._update(job_id, status="running", progress=max(0.0, min(1.0, p)), message=str(getattr(update, "status", "") or "Generating…"))

            def on_preview(self, update):
                # WanGP's live preview while sampling: a frame strip, or a short silent MP4 in Tiny VAE video mode
                now = time.time()
                if now - last_preview[0] < 0.8:
                    return
                last_preview[0] = now
                try:
                    video = getattr(update, "video", None)
                    if video:
                        with open(os.path.join(folder, "preview.mp4.tmp"), "wb") as handle:
                            handle.write(video)
                        os.replace(os.path.join(folder, "preview.mp4.tmp"), os.path.join(folder, "preview.mp4"))
                        service._update(job_id, preview="mp4", previewAt=now)
                    elif getattr(update, "image", None) is not None:
                        update.image.convert("RGB").save(os.path.join(folder, "preview.jpg.tmp"), "JPEG", quality=82)
                        os.replace(os.path.join(folder, "preview.jpg.tmp"), os.path.join(folder, "preview.jpg"))
                        service._update(job_id, preview="jpg", previewAt=now)
                except Exception:
                    pass

        try:
            handle = self.host.submit(task, Callbacks(), plugin_data) if plugin_data else self.host.submit(task, Callbacks())
            self.handles[job_id] = handle
            result = handle.result()
            if getattr(result, "cancelled", False) or self.jobs.get(job_id, {}).get("status") == "cancelled":
                self._update(job_id, status="cancelled", message="Cancelled")
                return
            files = [f for f in (getattr(result, "generated_files", None) or []) if os.path.isfile(f)]
            if not getattr(result, "success", False) or not files:
                errors = getattr(result, "errors", None) or []
                message = "; ".join(str(getattr(e, "message", e)) for e in errors) or "WanGP produced no video"
                self._update(job_id, status="error", error=message, message=message)
                return
            video = next((f for f in files if os.path.splitext(f)[1].lower() in (".mp4", ".mkv", ".mov", ".webm")), files[0])
            item = self.registry.register(video)
            self._update(job_id, status="done", progress=1.0, message="Done", media=self.registry.public(item))
        except Exception as error:
            self._update(job_id, status="error", error=str(error), message=str(error))
        finally:
            self.handles.pop(job_id, None)

    # ---- timeline generations: extend / prepend / bridge / fill / loop
    def _sha(self, item):
        path = item["path"]
        st = os.stat(path)
        key = (path, st.st_mtime, st.st_size)
        if key not in self._sha_cache:
            from .h3pins import sha256_file
            self._sha_cache[key] = sha256_file(path)
        return self._sha_cache[key]

    def _pin(self, side, place, window, gen_fps):
        """Plan one pin from {mediaId, cut (seconds in its file)}: which frames, at what grade, and how far the cut moves."""
        item = self._item(side["mediaId"])
        src_fps = float(item.get("fps") or gen_fps)
        file_frames = int(round(float(item.get("duration") or 0) * src_fps))
        cut = int(round(float(side["cut"]) * src_fps))
        available = cut if place == "before" else max(0, file_frames - cut)
        frames = C.fit_window(int(window), int(available * gen_fps / src_fps))
        if frames < 5:
            raise ValueError(f"the {'previous' if place == 'before' else 'next'} clip has too few frames {'before' if place == 'before' else 'after'} the cut to pin")
        manifest, sha = None, None
        if abs(src_fps - gen_fps) < 1e-3:
            try:
                sha = self._sha(item)
                manifest = self.latents.manifest(sha)
            except Exception:
                manifest = None
        aligned = (C.align_before_pin if place == "before" else C.align_after_pin)(manifest, cut, frames)
        if side.get("pixel") and aligned["grade"] == "latent" and aligned["shift"]:
            aligned = {"start": cut - frames if place == "before" else cut, "cut": cut, "grade": "pixel", "shift": 0, "reason": "kept your cut"}
        if aligned["grade"] != "latent" and abs(src_fps - gen_fps) >= 1e-3:
            aligned["reason"] = f"the clip is {src_fps:g} fps; pins are re-encoded at {gen_fps:g} fps"
        return {"place": place, "mediaId": item["id"], "file": item["path"], "fps": src_fps, "frames": frames,
                "start_frame": int(aligned["start"]), "cut_frame": int(aligned["cut"]), "cut": aligned["cut"] / src_fps,
                "shift": int(aligned["shift"]), "grade": aligned["grade"], "reason": aligned["reason"],
                "sha": sha if aligned["grade"] == "latent" else None, "audio": bool(side.get("audio", True))}

    def _compose(self, req):
        ok, reason = self.host.available()
        mode = req.get("mode")
        if mode not in ("new", "extend", "prepend", "bridge", "fill", "loop", "replace"):
            raise ValueError("Unknown generation mode")
        fresh = mode == "new"
        source_id = req.get("settingsFrom") or (req.get("left") or req.get("right") or {}).get("mediaId")
        source = self._item(source_id) if source_id else None
        if source is None and not fresh:
            raise ValueError("Nothing to pin: this needs a clip on the side it continues from")
        meta = (self._meta(source) if source else None) or {}
        settings = self._settings_for(source, bool(req.get("useCurrent")) or source is None)
        settings, refmods = relink_refmods(settings)
        model_type = settings.get("model_type")
        model_def = self.host.model_def(model_type) or {}
        caps = capabilities(model_def)
        gen_fps = caps["fps"]
        window = int(req.get("window") or 22)
        pins = []
        if not fresh:
            if req.get("left") and mode in ("extend", "bridge", "fill", "loop", "replace"):
                pins.append(self._pin(req["left"], "before", window, gen_fps))
            if req.get("right") and mode in ("prepend", "bridge", "fill", "loop", "replace"):
                pins.append(self._pin(req["right"], "after", window, gen_fps))
            if not pins:
                raise ValueError("Nothing to pin: this needs a clip on the side it continues from")
        before = sum(p["frames"] for p in pins if p["place"] == "before")
        after = sum(p["frames"] for p in pins if p["place"] == "after")
        window_max = int(((model_def or {}).get("sliding_window_defaults") or {}).get("window_max") or 0)
        if fresh:
            # a new shot: no pins, the model's own legal lengths, and WanGP's sliding windows may run it as long as asked
            h3 = "minimax_h3" in str(model_type or "")
            step = C.GRID if h3 else max(1, caps["framesSteps"])
            minimum = caps["framesMinimum"]
            total = C.nearest_total(float(req.get("newSeconds") or 5.0) * gen_fps, minimum, step=step, offset=minimum % step)
            lengths = {"total": total, "new": total, "before": 0, "after": 0}
            step_note = f"{model_def.get('name') or 'This model'} runs in steps of {step} frames, so this is the nearest legal length."
        else:
            lengths = C.plan_lengths(float(req.get("newSeconds") or 3.0), gen_fps, before, after, caps["framesMinimum"], nearest=True)
            if window_max and lengths["total"] > window_max:
                raise ValueError(f"that's {lengths['total']} frames in one run; this model allows {window_max} ({window_max / gen_fps:.1f}s) including the pins")
            step_note = "H3 runs in steps of 17 frames, so the new part is the nearest legal length."
        if fresh:
            prompt, shots = str(settings.get("prompt") or meta.get("prompt") or ""), []
        else:
            a, b = sorted(float(x) for x in (req.get("promptRange") or [0, 0]))
            prompt_fps = caps["fps"] if not str(meta.get("force_fps") or "").strip().isdigit() else float(meta["force_fps"])
            prompt, shots = shot_prompt(meta.get("prompt") or settings.get("prompt") or "", prompt_fps, a, b, meta.get("sliding_window_overlap") or 0) if b > a else (meta.get("prompt") or "", [])
        info = {"mode": mode, "model": {"type": model_type, "name": self.host.model_name(model_type)}, "capabilities": caps,
                "fps": gen_fps, "pins": pins, "lengths": {**lengths, "newSeconds": lengths["new"] / gen_fps, "totalSeconds": lengths["total"] / gen_fps,
                                                          "trimHead": before / gen_fps, "trimTail": after / gen_fps, "note": step_note},
                "originalSeed": meta.get("seed"), "prompt": prompt, "shots": shots, "refmods": refmods,
                "available": ok, "reason": reason, "h3": self.host.h3_status() if hasattr(self.host, "h3_status") else {"installed": False}}
        return info, settings, model_def

    def compose_prepare(self, req):
        info, _, _ = self._compose(req)
        return {k: v for k, v in info.items()}

    def compose_submit(self, req):
        info, settings, model_def = self._compose(req)
        if not info["available"]:
            raise ValueError(info["reason"])
        if info["pins"] and not (info.get("h3") or {}).get("installed"):
            raise ValueError("The editor's H3 add-on isn't active in WanGP (see the console), so pinned generations can't run")
        seed = req.get("seed")
        if seed in (None, "", "new") or int(seed) < 0:
            seed = random.randint(0, 2 ** 31 - 1)
        seed = int(seed)
        lengths = info["lengths"]
        prompt = str(req.get("prompt") or "").strip() or info["prompt"]
        task = build_task(settings, prompt=prompt, seed=seed, frames=lengths["total"], fps=info["fps"], model_def=model_def)
        if info["pins"]:
            task["sliding_window_size"] = max(int(task.get("sliding_window_size") or 0), lengths["total"])   # one window: pins only apply to window 1
        spec = {"pins": [{k: p[k] for k in ("place", "file", "fps", "frames", "start_frame", "sha", "audio")} for p in info["pins"]],
                "mode": info["mode"]}
        job_id = uuid.uuid4().hex[:12]
        folder = os.path.join(self.root, job_id)
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "task.json"), "w", encoding="utf-8") as handle:
            json.dump({"settings": task, "plugin_data": {"video_editor": spec}}, handle, indent=1, default=str)
        job = {"id": job_id, "status": "queued", "progress": 0.0, "message": "Queued in WanGP…", "created": time.time(),
               "project": req.get("project"), "kind": "compose", "mode": info["mode"], "seed": seed,
               "clipId": req.get("clipId"), "trackId": req.get("trackId"), "place": req.get("place"),
               "left": {**(req.get("left") or {}), "cut": next((p["cut"] for p in info["pins"] if p["place"] == "before"), None)} if req.get("left") else None,
               "right": {**(req.get("right") or {}), "cut": next((p["cut"] for p in info["pins"] if p["place"] == "after"), None)} if req.get("right") else None,
               "pins": [{k: p[k] for k in ("place", "grade", "frames", "shift", "reason")} for p in info["pins"]],
               "trimHead": lengths["trimHead"], "trimTail": lengths["trimTail"], "newSeconds": lengths["newSeconds"],
               "prompt": prompt, "model": info["model"]["name"], "audio": "new", "media": None, "error": None,
               "request": {k: v for k, v in req.items() if k not in ("prompt",)}}
        with self.lock:
            self.jobs[job_id] = job
            self._save()
        threading.Thread(target=self._run, args=(job_id, task, {"video_editor": spec}), daemon=True, name=f"video_editor_gen_{job_id}").start()
        return job

    def preview_path(self, job_id):
        job = self.jobs.get(job_id) or {}
        kind = job.get("preview")
        path = os.path.join(self.root, job_id, f"preview.{kind}") if kind else None
        return (path, kind) if path and os.path.isfile(path) else (None, None)

    def seam(self, req):
        a, b = self._item(req["a"]["mediaId"]), self._item(req["b"]["mediaId"])
        fps = float(a.get("fps") or b.get("fps") or 24)
        return C.seam_verdict(a["path"], float(req["a"]["end"]), b["path"], float(req["b"]["start"]), fps)

    def list(self, project=None):
        with self.lock:
            jobs = [dict(j) for j in self.jobs.values() if project is None or j.get("project") in (None, project)]
        return sorted(jobs, key=lambda j: j["created"])

    def cancel(self, job_id):
        handle = self.handles.get(job_id)
        self._update(job_id, status="cancelled", message="Cancelled")
        if handle is not None:
            try:
                handle.cancel()
            except Exception:
                pass

    def dismiss(self, job_id):
        """Forget a finished job (the editor has added its take, or the user cleared it)."""
        with self.lock:
            job = self.jobs.get(job_id)
            if job and job.get("status") in ("queued", "running"):
                raise ValueError("The regeneration is still running")
            self.jobs.pop(job_id, None)
            self._save()


class NoHost:
    """Used when the editor runs outside WanGP (or WanGP's queue can't be reached)."""

    def available(self):
        return False, "Regeneration needs the editor running inside WanGP"

    def current_settings(self):
        return None

    def model_def(self, model_type):
        return None

    def model_name(self, model_type):
        return model_type or ""

    def submit(self, settings, callbacks, plugin_data=None):
        raise RuntimeError("Regeneration is unavailable")

    def h3_status(self):
        return {"installed": False, "problems": ["the editor is not running inside WanGP"]}
