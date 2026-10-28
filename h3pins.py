"""Latent-grade clip composition for MiniMax H3 inside WanGP: the editor's add-on to WanGP's own H3 code.

Two jobs, both opt-in per generation and inert for everything else:

1. Sidecars. Every H3 generation's final latents are kept, window by window, and saved after WanGP writes the video,
   keyed by the file's SHA-256 (renaming or moving the file keeps the link; editing or re-encoding breaks it).
   Each window's latents are located in the file by matching low-resolution fingerprints of the frames they decode to,
   so multi-window generations, discarded frames and spatial upsampling are all handled without re-implementing
   WanGP's window assembly.

2. Pins. A generation started by the editor can carry "pins" in its task's plugin_data: windows of other clips held as
   fixed context, placed at the START of the new clip (extend: it continues out of them), at the END (prepend: it runs
   toward them) or both (bridge). Pinned windows come from a sidecar when the file has one (latent grade: no VAE
   round trip) and are otherwise decoded from the file and encoded (pixel grade). They are re-rendered as part of the
   take and the editor trims them off, so the take holds only new material.

   H3 compresses time periodically: every 17 pixel frames are 5 latents covering (1, 4, 4, 4, 4) frames, and the
   packed layout walks that pattern from latent 0. A block of latents is laid out correctly only when it starts on a
   17-frame boundary, so pins are 5 + 17n frames long and start on that grid, and the new clip's length is chosen so
   an end pin also lands on it (the editor does that arithmetic).

   H3 already conditions on keyframe blocks anchored at the target's start ("first", which handles several latents)
   but its "last" anchor puts every latent at the same time. End pins use a "tail" anchor added here: the layout is
   built as for "first" and the block's time coordinates are then moved onto the target's last positions. Audio pins
   use "first" for the start and "tail@<latent index>" for the end in the same way.

Every binding is patched by wrapping whatever is installed at the time (so other plugins that patch the same
functions, such as H3 Latent Carry and RefMods, keep working) and every wrapper hands back to the original on any
problem. Nothing here raises into a normal generation; a pinned generation that cannot be honoured fails with a
clear message instead of silently producing an unpinned clip.
"""

import contextvars
import functools
import hashlib
import inspect
import json
import math
import os
import subprocess
import sys
import threading
import time
import traceback

import numpy as np

VERSION = "1.0"
PLUGIN_KEY = "video_editor"                 # plugin_data key the editor's tasks carry
GRID = 17                                   # pixel frames per VAE clip
LATENTS_PER_CLIP = 5
FP_SIZE = (18, 32)                          # fingerprint height, width
MAX_CAPTURE_BYTES = 3 * 1024 ** 3           # never hold more than this many latent bytes for one job
_MARK = "_video_editor_h3pins"

_JOB = contextvars.ContextVar("video_editor_h3_job", default=None)        # set by generate_media
_GEN = contextvars.ContextVar("video_editor_h3_generate", default=None)   # set by MiniMaxH3Pipeline.generate
_ACTIVE = contextvars.ContextVar("video_editor_h3_active", default=frozenset())   # our wrappers on the call stack
_NAMESPACE = None
_HOOKS = {}
_STATE = {"installed": False, "problems": [], "saved": 0, "pinned": 0, "last": ""}
_LOCK = threading.Lock()
STORE = None


def _log(message):
    _STATE["last"] = message
    print(f"[Video Editor] {message}")


# --------------------------------------------------------------------------- frame grid maths (pure, tested)

def latent_count(frames):
    """Latents that hold `frames` pixel frames on H3's grid (5 + 17n frames -> 2 + 5n latents)."""
    frames = int(frames)
    if frames <= 1:
        return 1
    return (frames // GRID) * LATENTS_PER_CLIP + (0 if frames % GRID == 0 else 1 + (frames % GRID - 1 + 3) // 4)


def legal_pin_frames(frames):
    return frames >= 5 and (frames - 5) % GRID == 0


def on_grid(frame):
    return int(frame) % GRID == 0


# --------------------------------------------------------------------------- fingerprints

def fingerprints(frames):
    """Low-resolution greyscale fingerprints, (F, 18*32) float32 in 0..1, of a CFHW (or BCFHW) video tensor that is
    uint8 or float in [-1, 1]."""
    import torch
    import torch.nn.functional as F
    if frames.dim() == 5:
        frames = frames[0]
    out = []
    with torch.no_grad():
        for start in range(0, frames.shape[1], 16):
            chunk = frames[:, start:start + 16]
            chunk = chunk.float() / 255.0 if chunk.dtype == torch.uint8 else (chunk.float() + 1.0) / 2.0
            grey = chunk.mean(0, keepdim=True).permute(1, 0, 2, 3)   # F,1,H,W
            small = F.adaptive_avg_pool2d(grey.to("cpu"), FP_SIZE)
            out.append(small.reshape(small.shape[0], -1).clamp(0, 1).numpy())
    return np.concatenate(out, 0).astype(np.float32) if out else np.zeros((0, FP_SIZE[0] * FP_SIZE[1]), np.float32)


def locate(window_fp, file_fp, probe=8, accept=0.035, keep=0.05):
    """Where a window's frames sit in the file: (offset, valid_frames) or None. valid_frames counts the leading frames
    that still match (a window's last frames may have been replaced by the next window's)."""
    n, total = len(window_fp), len(file_fp)
    if n == 0 or total == 0:
        return None
    k = min(probe, n)
    best, best_err = None, None
    head = window_fp[:k]
    for offset in range(0, total - k + 1):
        err = float(np.abs(file_fp[offset:offset + k] - head).mean())
        if best_err is None or err < best_err:
            best, best_err = offset, err
    if best is None or best_err > accept:
        return None
    valid = 0
    for i in range(min(n, total - best)):
        if float(np.abs(file_fp[best + i] - window_fp[i]).mean()) > keep:
            break
        valid += 1
    return best, valid


# --------------------------------------------------------------------------- sidecar store

def sha256_file(path, chunk=4 * 1024 * 1024):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


class LatentStore:
    """<root>/<sha>.pt (tensors) + <sha>.json (manifest). Oldest entries go first past the size limit."""

    def __init__(self, root, limit_gb=20.0):
        self.root = root
        self.limit = int(limit_gb * 1024 ** 3)
        os.makedirs(root, exist_ok=True)

    def paths(self, sha):
        return os.path.join(self.root, f"{sha}.pt"), os.path.join(self.root, f"{sha}.json")

    def has(self, sha):
        return all(os.path.isfile(p) for p in self.paths(sha))

    def manifest(self, sha):
        try:
            with open(self.paths(sha)[1], "r", encoding="utf-8") as handle:
                return json.load(handle)
        except Exception:
            return None

    def save(self, sha, tensors, manifest):
        import torch
        data_path, meta_path = self.paths(sha)
        tmp = data_path + ".tmp"
        torch.save(tensors, tmp)
        os.replace(tmp, data_path)
        with open(meta_path + ".tmp", "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, indent=1)
        os.replace(meta_path + ".tmp", meta_path)
        self.enforce_limit(keep={sha})

    def load(self, sha):
        import torch
        data_path, _ = self.paths(sha)
        if not os.path.isfile(data_path):
            return None
        os.utime(data_path, None)
        return torch.load(data_path, map_location="cpu", weights_only=True)

    def enforce_limit(self, keep=()):
        entries = []
        for name in os.listdir(self.root):
            if name.endswith(".pt"):
                path = os.path.join(self.root, name)
                entries.append((os.path.getmtime(path), os.path.getsize(path), name[:-3]))
        total = sum(e[1] for e in entries)
        for _, size, sha in sorted(entries):
            if total <= self.limit:
                break
            if sha in keep:
                continue
            for p in self.paths(sha):
                try:
                    os.remove(p)
                except OSError:
                    pass
            total -= size

    def stats(self):
        files = [n for n in os.listdir(self.root) if n.endswith(".pt")]
        return {"count": len(files), "bytes": sum(os.path.getsize(os.path.join(self.root, n)) for n in files)}


# --------------------------------------------------------------------------- pin resolution

def find_window(manifest, start, frames):
    """The sidecar window that holds file frames [start, start+frames) on its own latent grid, or None with a reason."""
    if not manifest:
        return None, "no saved latents for this file"
    for index, w in enumerate(manifest.get("windows") or []):
        rel = start - int(w["offset"])
        if rel < 0 or rel + frames > int(w["valid"]):
            continue
        if rel % GRID:
            return None, f"the pin starts {rel % GRID} frame(s) off H3's 17-frame grid for the saved latents"
        return {"index": index, "rel": rel, **w}, ""
    return None, "the pinned frames are not inside one saved window"


def _ffmpeg():
    try:
        from shared.utils.utils import get_ffmpeg_path  # type: ignore
        return get_ffmpeg_path()
    except Exception:
        pass
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


def read_frames(path, start_time, frames, fps, width, height):
    """`frames` frames from `start_time` at `fps`, scaled to width x height: a CFHW float tensor in [-1, 1]."""
    import torch
    args = [_ffmpeg(), "-v", "error", "-ss", f"{max(0.0, start_time):.6f}", "-i", path, "-an",
            "-vf", f"fps={fps},scale={width}:{height}:flags=bicubic,format=rgb24", "-frames:v", str(frames),
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    raw = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
    size = width * height * 3
    count = len(raw) // size
    if count == 0:
        raise RuntimeError(f"could not read frames from {os.path.basename(path)}")
    array = np.frombuffer(raw[:count * size], np.uint8).reshape(count, height, width, 3)
    if count < frames:   # past the end: hold the last frame
        array = np.concatenate([array, np.repeat(array[-1:], frames - count, 0)], 0)
    video = torch.from_numpy(array.copy()).permute(3, 0, 1, 2).float().div_(127.5).sub_(1.0)
    return video


def read_audio(path, start_time, duration, sample_rate=32000):
    """Stereo float32 samples (S, 2) from start_time for duration seconds (silence when the file has no audio)."""
    args = [_ffmpeg(), "-v", "error", "-ss", f"{max(0.0, start_time):.6f}", "-t", f"{max(0.01, duration):.6f}", "-i", path,
            "-vn", "-ac", "2", "-ar", str(sample_rate), "-f", "f32le", "-"]
    raw = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
    samples = np.frombuffer(raw, np.float32)
    want = int(round(duration * sample_rate))
    if samples.size < 2:
        return np.zeros((want, 2), np.float32)
    samples = samples[: (samples.size // 2) * 2].reshape(-1, 2)
    if len(samples) < want:
        samples = np.concatenate([samples, np.zeros((want - len(samples), 2), np.float32)], 0)
    return samples[:want].copy()


# --------------------------------------------------------------------------- generation context

class PinPlan:
    """The pins of one generation, resolved to latents for each sampling stage."""

    def __init__(self, spec):
        self.spec = spec
        self.stages = []          # [(latent_h, latent_w)] in _prepare_condition_rows call order
        self.video = {}           # stage index -> [(place, latents)]
        self.audio = []           # [(anchor dict, latents)]
        self.calls = 0
        self.audio_rows = None    # id of the cond_audio_rows tensor that holds our audio pins
        self.notes = []


def _pipeline_module():
    return sys.modules.get("models.minimax_h3.pipeline")


def _plan_pins(pipeline, spec, kwargs):
    """Resolve the editor's pins for this generate() call. Raises ValueError with a readable reason."""
    import torch
    pm = _pipeline_module()
    pins = [p for p in spec.get("pins") or [] if p.get("place") in ("before", "after")]
    plan = PinPlan(spec)
    if not pins:
        return plan
    fps = float(kwargs.get("fps") or 24)
    frame_num = int(kwargs.get("frame_num") or 0)
    if frame_num < 5 or (frame_num - 5) % GRID:
        raise ValueError(f"pinned generations need a length of 5 + 17n frames (got {frame_num})")
    target_h, target_w = int(kwargs.get("height")), int(kwargs.get("width"))
    phases = int(kwargs.get("guide_phases") or 1)
    tiling_flag = getattr(pm, "H3_PHASE_2_TILING_FLAG", "~")
    if phases > 1 and tiling_flag in str(kwargs.get("video_prompt_type") or ""):
        raise ValueError("pins can't be used with tiled phase 2; turn off phase 2 tiling for this generation")
    stages = []
    if phases > 1:
        scale = float(getattr(pm, "H3_TWO_PHASE_SCALE", 2.0))
        stages.append((max(32, round(target_h / scale / 32) * 32), max(32, round(target_w / scale / 32) * 32)))
    stages.append((target_h, target_w))
    plan.stages = [(math.ceil(h / 16), math.ceil(w / 16)) for h, w in stages]
    total_latents = latent_count(frame_num)
    used = 0
    keep_audio = "S" in str(kwargs.get("audio_prompt_type") or "")
    pipeline._use_shared_components()
    for pin in pins:
        frames = int(pin["frames"])
        if not legal_pin_frames(frames):
            raise ValueError(f"a pin must be 5 + 17n frames long (got {frames})")
        n = latent_count(frames)
        used += n
        if used > total_latents:
            raise ValueError("the pins are longer than the clip being generated")
        path, start = pin["file"], int(pin["start_frame"])
        src_fps = float(pin.get("fps") or fps)
        latents = None
        saved = None
        if pin.get("sha") and STORE is not None and abs(src_fps - fps) < 1e-3:
            window, reason = find_window(STORE.manifest(pin["sha"]), start, frames)
            if window is None:
                plan.notes.append(f"{pin['place']} pin: pixel grade ({reason})")
            else:
                saved = STORE.load(pin["sha"])
        if saved is not None:
            entry = saved["windows"][window["index"]]
            lat0 = window["rel"] // GRID * LATENTS_PER_CLIP
            full = entry["video"][:, :, lat0:lat0 + n].float()
            per_stage = []
            for si, (lh, lw) in enumerate(plan.stages):
                if tuple(full.shape[-2:]) == (lh, lw):
                    per_stage.append(full.unsqueeze(0))
                elif entry.get("p1") is not None and tuple(entry["p1"].shape[-2:]) == (lh, lw):
                    per_stage.append(entry["p1"][:, :, lat0:lat0 + n].float().unsqueeze(0))
                else:
                    per_stage.append(None)   # this stage is encoded from pixels below
            latents = per_stage
            plan.notes.append(f"{pin['place']} pin: latent grade ({frames} frames)")
        pixels = None
        stage_latents = []
        for si, (h, w) in enumerate(stages):
            if latents is not None and latents[si] is not None:
                stage_latents.append(latents[si])
                continue
            if pixels is None:
                pixels = read_frames(path, start / src_fps, frames, fps, target_w, target_h)
            video = pixels if (h, w) == (target_h, target_w) else pm._resize_video(pixels, h, w)
            stage_latents.append(pipeline._encode_video(video, keep_all_latents=True))
        for si, lat in enumerate(stage_latents):
            if lat.shape[2] != n:
                raise ValueError(f"a {frames}-frame pin encoded to {lat.shape[2]} latents instead of {n}")
            plan.video.setdefault(si, []).append((pin["place"], lat))
        if latents is None and not any("pixel" in note for note in plan.notes if note.startswith(pin["place"])):
            plan.notes.append(f"{pin['place']} pin: pixel grade ({frames} frames)")
        # audio: the pinned seconds of the clip's soundtrack, held at the same place
        if pin.get("audio", True) and not keep_audio:
            alf = float(getattr(pm, "AUDIO_LATENT_FPS", 40))
            sr = int(getattr(pm, "AUDIO_SAMPLE_RATE", 32000))
            audio_latents = None
            if saved is not None and entry.get("audio") is not None and entry.get("audio_ok"):
                a0 = int(round(window["rel"] / fps * alf))
                count = int(round(frames / fps * alf))
                audio_latents = entry["audio"][..., a0:a0 + count].float().unsqueeze(0)   # stored without the batch axis
            if audio_latents is None:
                wave = read_audio(path, start / src_fps, frames / fps, sr)
                audio_latents = pipeline._encode_audio(pipeline._waveform(wave, sr))
            count = int(audio_latents.shape[-1])
            if pin["place"] == "before":
                anchor = {"anchor": "first", "latent_frame_count": count}
            else:
                start_index = int(round((frame_num - frames) / fps * alf))
                anchor = {"anchor": f"tail@{start_index}", "latent_frame_count": count}
            plan.audio.append((anchor, audio_latents))
    return plan


# --------------------------------------------------------------------------- patched pipeline methods

def _impl_generate(self, original, *args, **kwargs):
    if args or kwargs.get("refinement_mode") or kwargs.get("image_mode"):
        return original(self, *args, **kwargs)
    ensure_on_top()
    job = _JOB.get()
    window_no = kwargs.get("window_no")
    record = {"window_no": window_no, "fps": float(kwargs.get("fps") or 24), "video": None, "audio": None, "p1": None,
              "fp": None, "continuation": kwargs.get("input_video") is not None and int(kwargs.get("prefix_frames_count") or 0) > 0,
              "plan": None}
    spec = (job or {}).get("spec")
    if spec and (window_no is None or int(window_no) <= 1):
        try:
            record["plan"] = _plan_pins(self, spec, kwargs)
        except ValueError as error:
            raise ValueError(f"Video Editor pins: {error}")
        except Exception as error:
            traceback.print_exc()
            raise RuntimeError(f"Video Editor pins could not be prepared: {error!r}")
        if record["plan"].notes:
            _log("; ".join(record["plan"].notes))
        _STATE["pinned"] += 1
    _hook_upscaler(self)
    token = _GEN.set(record)
    try:
        result = original(self, *args, **kwargs)
    finally:
        _GEN.reset(token)
    if job is not None and record["video"] is not None:
        with _LOCK:
            size = sum(t.numel() * t.element_size() for t in (record["video"], record["audio"], record["p1"]) if t is not None)
            if job["bytes"] + size <= MAX_CAPTURE_BYTES:
                job["bytes"] += size
                job["windows"].append(record)
            elif not job.get("overflow"):
                job["overflow"] = True
                _log("this generation is too long to keep all its latents; later windows are not saved")
    record["plan"] = None
    return result


def _impl_prepare_condition_rows(self, inner, visual_latents, audio_latents, generator, keyframes=(), *args, **kwargs):
    record = _GEN.get()
    plan = record.get("plan") if record else None
    if plan is not None and plan.video and isinstance(keyframes, list) and isinstance(visual_latents, list):
        stage = plan.calls
        plan.calls += 1
        pins = plan.video.get(stage)
        if pins:
            lh, lw = plan.stages[stage]
            insert_at = len(keyframes)
            for place, lat in pins:
                if tuple(lat.shape[-2:]) != (lh, lw):
                    raise ValueError(f"Video Editor pins: a pin is {tuple(lat.shape[-2:])} latents but this stage is {(lh, lw)}")
                visual_latents.insert(insert_at, lat)
                keyframes.append({"anchor": "first" if place == "before" else "tail", "latent_frame_count": int(lat.shape[2])})
                insert_at += 1
        if stage == 0 and plan.audio and isinstance(audio_latents, list):
            for i, (_, lat) in enumerate(plan.audio):
                audio_latents.insert(i, lat)
            result = inner(self, visual_latents, audio_latents, generator, keyframes, *args, **kwargs)
            if isinstance(result, tuple) and len(result) > 1 and result[1] is not None:
                plan.audio_rows = id(result[1])
            return result
    return inner(self, visual_latents, audio_latents, generator, keyframes, *args, **kwargs)


def _impl_layout(self, inner, text_tags, latent_t, latent_h, latent_w, audio_t, payload, *args, **kwargs):
    record = _GEN.get()
    plan = record.get("plan") if record else None
    if plan is not None and plan.audio and plan.audio_rows is not None and isinstance(payload, dict) \
            and id(payload.get("cond_audio_rows")) == plan.audio_rows and not payload.get("_video_editor_audio"):
        ours = [dict(anchor) for anchor, _ in plan.audio]
        payload["audio_keyframes"] = ours + list(payload.get("audio_keyframes") or [])
        payload["_video_editor_audio"] = True
        for key in ("layout_signature", "layout", "rope"):
            payload.pop(key, None)
    return inner(self, text_tags, latent_t, latent_h, latent_w, audio_t, payload, *args, **kwargs)


def _tail_fix(original):
    """Wrap a packed-sequence builder so 'tail' (video) and 'tail@N' (audio) anchors are laid out on the target's last
    positions / at audio latent N."""
    signature = inspect.signature(original)

    @functools.wraps(original)
    def builder(*args, **kwargs):
        try:
            bound = signature.bind(*args, **kwargs)
        except TypeError:
            return original(*args, **kwargs)
        values = bound.arguments
        anchors = tuple(values.get("keyframe_anchors") or ())
        audio_anchors = tuple(values.get("audio_condition_anchors") or ())
        video_tails = [i for i, a in enumerate(anchors) if (a[0] if isinstance(a, tuple) else a) == "tail"]
        audio_tails = [(i, int(str(a[0] if isinstance(a, tuple) else a).split("@", 1)[1])) for i, a in enumerate(audio_anchors)
                       if str(a[0] if isinstance(a, tuple) else a).startswith("tail@")]
        if not video_tails and not audio_tails:
            return original(*args, **kwargs)
        values["keyframe_anchors"] = tuple(("first",) + tuple(a[1:]) if i in video_tails else a for i, a in enumerate(anchors))
        values["audio_condition_anchors"] = tuple(("first",) + tuple(a[1:]) if any(i == j for j, _ in audio_tails) else a
                                                  for i, a in enumerate(audio_anchors))
        layout = original(*bound.args, **bound.kwargs)
        fix_tail_positions(layout, values, anchors, audio_anchors, video_tails, audio_tails)
        return layout

    return builder


def _anchor_frames(entry):
    if not isinstance(entry, tuple):
        return 1
    return int(entry[1])


def fix_tail_positions(layout, values, anchors, audio_anchors, video_tails, audio_tails):
    """Move tail anchors' time coordinates (position_ids[:, 0]) onto the target's last latent positions (video) or onto
    audio latent N of the target (audio). Pure index arithmetic on the layout the builder returned."""
    pos = layout.position_ids
    text_len = int(values["text_token_tags"].shape[0])
    patch = values["patch_size"]
    rpf = (int(values["latent_height"]) // int(patch[1])) * (int(values["latent_width"]) // int(patch[2]))
    t = int(values["num_latent_frames"])
    seq = int(layout.sequence_length)
    target_rows = t * rpf
    target_times = pos[seq - target_rows:seq:rpf, 0].clone()        # one time per target latent frame
    cursor = text_len
    for i, entry in enumerate(anchors):
        n = _anchor_frames(entry)
        if i in video_tails:
            times = target_times[t - n:t]
            pos[cursor:cursor + n * rpf, 0] = times.repeat_interleave(rpf)
        cursor += n * rpf
    # audio keyframes follow the video keyframes in both layouts
    audio_cursor = text_len + sum(_anchor_frames(e) for e in anchors) * rpf
    tails = dict(audio_tails)
    for i, entry in enumerate(audio_anchors):
        n = _anchor_frames(entry)
        rows = n * 2
        if i in tails:
            pos[audio_cursor:audio_cursor + rows, 0] += float(tails[i])
        audio_cursor += rows


def _impl_video_decode(self, inner, latents, *args, **kwargs):
    decoded = inner(self, latents, *args, **kwargs)
    record = _GEN.get()
    if record is not None and _JOB.get() is not None:
        try:
            record["video"] = latents.detach().to("cpu", copy=True).to(dtype=_half())[0]
            frames = decoded[0] if hasattr(decoded, "dim") and decoded.dim() == 5 else decoded
            record["fp"] = fingerprints(frames)
        except Exception as error:
            record["video"] = None
            _log(f"latents not kept for this window: {error!r}")
    return decoded


def _impl_audio_decode(self, inner, latents, *args, **kwargs):
    decoded = inner(self, latents, *args, **kwargs)
    record = _GEN.get()
    if record is not None and _JOB.get() is not None:
        try:
            record["audio"] = latents.detach().to("cpu", copy=True).to(dtype=_half())[0]
        except Exception:
            record["audio"] = None
    return decoded


def _half():
    import torch
    return torch.float16


def _capture_phase_1(module, args):
    record = _GEN.get()
    if record is None or _JOB.get() is None or not args:
        return None
    try:
        import torch
        pm = _pipeline_module()
        normalized = args[0]
        mean = normalized.new_tensor(pm.LATENTS_MEAN, dtype=torch.float32).view(1, -1, 1, 1, 1)
        std = normalized.new_tensor(pm.LATENTS_STD, dtype=torch.float32).view(1, -1, 1, 1, 1)
        record["p1"] = (normalized.float() * std + mean).detach().to("cpu").to(torch.float16)[0]
    except Exception:
        record["p1"] = None
    return None


def _hook_upscaler(pipeline):
    upscaler = getattr(pipeline, "latent_upscaler", None)
    if upscaler is None or getattr(upscaler, "_video_editor_hooked", False):
        return
    try:
        upscaler.register_forward_pre_hook(_capture_phase_1)
        upscaler._video_editor_hooked = True
    except Exception:
        pass


# --------------------------------------------------------------------------- WanGP job hooks

def _bind(function, args, kwargs):
    try:
        return inspect.signature(function).bind_partial(*args, **kwargs).arguments
    except Exception:
        return dict(kwargs)


def _wrap_generate_media(original):
    @functools.wraps(original)
    def generate_media(*args, **kwargs):
        plugin_data = kwargs.get("plugin_data")
        spec = plugin_data.get(PLUGIN_KEY) if isinstance(plugin_data, dict) else None
        job = {"spec": spec if isinstance(spec, dict) else None, "windows": [], "bytes": 0, "final_fp": None, "saves": []}
        token = _JOB.set(job)
        try:
            return original(*args, **kwargs)
        finally:
            _JOB.reset(token)
            _finish(job)
    return generate_media


def _wrap_save_video(original):
    @functools.wraps(original)
    def save_video(*args, **kwargs):
        job = _JOB.get()
        if job is not None and job["windows"]:
            try:
                values = _bind(original, args, kwargs)
                tensor = values.get("tensor")
                if tensor is not None and hasattr(tensor, "dim") and tensor.dim() in (4, 5):
                    job["final_fp"] = fingerprints(tensor)
            except Exception as error:
                job["final_fp"] = None
                _log(f"could not fingerprint the saved video: {error!r}")
        return original(*args, **kwargs)
    return save_video


def _wrap_record_file_metadata(original):
    @functools.wraps(original)
    def record_file_metadata(*args, **kwargs):
        result = original(*args, **kwargs)
        job = _JOB.get()
        if job is not None and job["windows"] and job.get("final_fp") is not None:
            try:
                values = _bind(original, args, kwargs)
                if not values.get("is_image") and not values.get("audio_only"):
                    path = values.get("video_path")
                    path = path[-1] if isinstance(path, list) and path else path
                    if isinstance(path, str) and path:
                        job["saves"].append((os.path.abspath(path), job["final_fp"], values.get("configs") or {}))
            except Exception as error:
                _log(f"latents not saved: {error!r}")
        return result
    return record_file_metadata


def _finish(job):
    """Write the sidecar for the job's final file (the last one recorded)."""
    if not job["saves"] or not job["windows"] or STORE is None:
        return
    path, file_fp, configs = job["saves"][-1]
    if not os.path.isfile(path):
        return
    try:
        windows, tensors = [], []
        for w in job["windows"]:
            if w["fp"] is None or w["video"] is None:
                continue
            found = locate(w["fp"], file_fp)
            if found is None:
                continue
            offset, valid = found
            windows.append({"offset": int(offset), "valid": int(valid), "frames": int(len(w["fp"])),
                            "latents": int(w["video"].shape[1]), "latent_hw": list(w["video"].shape[-2:]),
                            "p1_hw": list(w["p1"].shape[-2:]) if w["p1"] is not None else None,
                            "audio_ok": bool(w["audio"] is not None and not w["continuation"] and (w["window_no"] or 1) <= 1)})
            tensors.append({"video": w["video"], "audio": w["audio"], "p1": w["p1"], "audio_ok": windows[-1]["audio_ok"]})
        if not windows:
            _log(f"latents not saved for {os.path.basename(path)}: its frames could not be matched to the generation")
            return
        sha = sha256_file(path)
        manifest = {"format": "video_editor_h3_v1", "sha": sha, "video_path": path, "video_name": os.path.basename(path),
                    "fps": job["windows"][0]["fps"], "file_frames": int(len(file_fp)), "windows": windows,
                    "model_type": configs.get("model_type"), "pins": (job.get("spec") or {}).get("pins") or [],
                    "created": time.time(), "version": VERSION}
        STORE.save(sha, {"windows": tensors}, manifest)
        _STATE["saved"] += 1
        _log(f"saved latents for {os.path.basename(path)} ({len(windows)} window{'s' if len(windows) > 1 else ''})")
    except Exception as error:
        traceback.print_exc()
        _log(f"latents not saved for {os.path.basename(path)}: {error!r}")
    finally:
        job["windows"].clear()


# --------------------------------------------------------------------------- install

def _is_ours(function):
    for _ in range(64):
        if function is None:
            return False
        if getattr(function, _MARK, False):
            return True
        function = getattr(function, "__wrapped__", None)
    return False


def _wrap_global(name):
    current = _NAMESPACE.get(name) if _NAMESPACE is not None else None
    if not callable(current) or _is_ours(current):
        return False
    wrapper = _HOOKS[name](current)
    setattr(wrapper, _MARK, True)
    _NAMESPACE[name] = wrapper
    return True


def ensure_installed():
    """Re-wrap WanGP's job functions if another plugin replaced them after us (called before each generation)."""
    if _NAMESPACE is None:
        return
    for name in _HOOKS:
        _wrap_global(name)


_OWNERS = {}       # key -> (owner, attribute)
_IMPLS = {}        # key -> our implementation (self, inner, *args, **kwargs)


def _make_wrapper(key, inner):
    """Our wrapper for one binding. When it ends up in a chain twice (re-wrapped on top of another plugin), only the
    outermost copy acts; inner copies pass straight through."""
    if key.startswith("build_"):
        fixed = _tail_fix(inner)

        @functools.wraps(inner)
        def wrapper(*args, **kwargs):
            active = _ACTIVE.get()
            if key in active:
                return inner(*args, **kwargs)
            token = _ACTIVE.set(active | {key})
            try:
                return fixed(*args, **kwargs)
            finally:
                _ACTIVE.reset(token)
    else:
        impl = _IMPLS[key]

        @functools.wraps(inner)
        def wrapper(self, *args, **kwargs):
            active = _ACTIVE.get()
            if key in active:
                return inner(self, *args, **kwargs)
            token = _ACTIVE.set(active | {key})
            try:
                return impl(self, inner, *args, **kwargs)
            finally:
                _ACTIVE.reset(token)
    setattr(wrapper, _MARK, True)
    return wrapper


def _patch_models():
    """Wrap H3's pipeline, VAEs and layout builders (on top of whatever is installed now)."""
    if _OWNERS:
        return True
    try:
        import importlib
        pm = importlib.import_module("models.minimax_h3.pipeline")
        tm = importlib.import_module("models.minimax_h3.transformer")
        vm = importlib.import_module("models.minimax_h3.video_vae")
        am = importlib.import_module("models.minimax_h3.audio_vae")
    except Exception as error:
        _STATE["problems"].append(f"MiniMax H3 is not available ({error!r})")
        return False
    transformer_class = next((getattr(tm, n) for n in dir(tm)
                              if isinstance(getattr(tm, n), type) and "_layout" in getattr(tm, n).__dict__), None)
    owners = {"generate": (pm.MiniMaxH3Pipeline, "generate"),
              "prepare_condition_rows": (pm.MiniMaxH3Pipeline, "_prepare_condition_rows"),
              "video_decode": (vm.MiniMaxH3VideoVAE, "decode"), "audio_decode": (am.MiniMaxH3AudioVAE, "decode"),
              "build_packed_sequence": (tm, "build_packed_sequence"),
              "build_ref2va_packed_sequence": (tm, "build_ref2va_packed_sequence"),
              "layout": (transformer_class, "_layout")}
    missing = [f"{key}" for key, (owner, attr) in owners.items() if owner is None or not hasattr(owner, attr)]
    if missing:
        _STATE["problems"].append("this WanGP build's H3 code is not what the editor expects (" + ", ".join(missing) + ")")
        return False
    _IMPLS.update({"generate": _impl_generate, "prepare_condition_rows": _impl_prepare_condition_rows,
                   "video_decode": _impl_video_decode, "audio_decode": _impl_audio_decode, "layout": _impl_layout})
    applied = []
    try:
        for key, (owner, attr) in owners.items():
            inner = getattr(owner, attr)
            setattr(owner, attr, _make_wrapper(key, inner))
            applied.append((owner, attr, inner))
    except Exception as error:
        for owner, attr, inner in reversed(applied):
            setattr(owner, attr, inner)
        _STATE["problems"].append(f"could not patch H3: {error!r}")
        return False
    _OWNERS.update(owners)
    return True


def ensure_on_top():
    """Plugins that patch the same H3 functions after us (H3 Latent Carry wraps the VAE decode and the layout
    builders) would hide our wrappers' view of the original arguments. Wrap again on top when that happened; an older
    wrapper of ours further down the chain then only repeats work the outer one overwrites."""
    for key, (owner, attr) in _OWNERS.items():
        current = getattr(owner, attr, None)
        if current is not None and not getattr(current, _MARK, False):
            setattr(owner, attr, _make_wrapper(key, current))
    ensure_installed()


def install(plugin, data_root):
    """Called once WanGP's globals are injected. Returns a list of problems (empty when everything is in place)."""
    global _NAMESPACE, STORE
    if _STATE["installed"]:
        return _STATE["problems"]
    _STATE["problems"] = []
    STORE = LatentStore(os.path.join(data_root, "latents"))
    setter = getattr(plugin, "_set_wgp_global_func", None)
    namespace = getattr(setter, "__globals__", None)
    _HOOKS.update({"generate_media": _wrap_generate_media, "save_video": _wrap_save_video,
                   "record_file_metadata": _wrap_record_file_metadata})
    if isinstance(namespace, dict):
        _NAMESPACE = namespace
        for name in _HOOKS:
            if not callable(namespace.get(name)):
                _STATE["problems"].append(f"WanGP has no {name}")
            else:
                _wrap_global(name)
    else:
        _STATE["problems"].append("cannot reach WanGP's job functions; latents won't be saved and pins won't apply")
    if not _patch_models():
        _log("H3 add-on inactive: " + "; ".join(_STATE["problems"]))
    else:
        _STATE["installed"] = True
        _log(f"H3 latent add-on {VERSION} installed")
    return _STATE["problems"]


def status():
    return {"installed": _STATE["installed"], "problems": list(_STATE["problems"]), "saved": _STATE["saved"],
            "pinned": _STATE["pinned"], "last": _STATE["last"], "store": STORE.stats() if STORE else None}
