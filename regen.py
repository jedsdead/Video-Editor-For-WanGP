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
        return {"available": ok, "reason": reason,
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
        model_type = settings.get("model_type")
        model_def = self.host.model_def(model_type) or {}
        caps = capabilities(model_def)
        source_fps = float(item.get("fps") or meta.get("force_fps") or caps["fps"] or 24)
        prompt_fps = caps["fps"] if not str(meta.get("force_fps") or "").strip().isdigit() else float(meta["force_fps"])
        prompt, shots = shot_prompt(meta.get("prompt") or settings.get("prompt") or "", prompt_fps, a, b, meta.get("sliding_window_overlap") or 0)
        return {"model": {"type": model_type, "name": self.host.model_name(model_type)}, "capabilities": caps,
                "originalSeed": meta.get("seed"), "prompt": prompt, "shots": shots, "range": [a, b], "sourceFps": source_fps,
                "minSeconds": caps["framesMinimum"] / caps["fps"]}

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

    def _run(self, job_id, task):
        service = self

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

        try:
            handle = self.host.submit(task, Callbacks())
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

    def submit(self, settings, callbacks):
        raise RuntimeError("Regeneration is unavailable")
