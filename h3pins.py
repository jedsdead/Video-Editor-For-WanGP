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
import struct
import subprocess
import sys
import threading
import time
import traceback

import numpy as np

VERSION = "1.6"
PLUGIN_KEY = "video_editor"                 # plugin_data key the editor's tasks carry
GRID = 17                                   # pixel frames per VAE clip
LATENTS_PER_CLIP = 5
AUDIO_LATENT_FPS = 40                       # H3 audio latents per second
FP_SIZE = (18, 32)                          # fingerprint height, width
MAX_CAPTURE_BYTES = 3 * 1024 ** 3           # never hold more than this many latent bytes for one job
_MARK = "_video_editor_h3pins"

_JOB = contextvars.ContextVar("video_editor_h3_job", default=None)        # set by generate_media
_GEN = contextvars.ContextVar("video_editor_h3_generate", default=None)   # set by MiniMaxH3Pipeline.generate
_ACTIVE = contextvars.ContextVar("video_editor_h3_active", default=frozenset())   # our wrappers on the call stack
_NAMESPACE = None
_HOOKS = {}
_STATE = {"installed": False, "problems": [], "saved": 0, "pinned": 0, "last": "",
          # how far each generation got through the capture, so a missing sidecar can be traced to its step
          "trace": {"jobs": 0, "generate": 0, "decode": 0, "captured": 0, "save_video": 0, "fingerprinted": 0, "recorded": 0,
                    "finish": 0, "matched": 0}}


def _count(step):
    _STATE["trace"][step] = _STATE["trace"].get(step, 0) + 1
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


def legal_motion_frames(frames):
    return frames >= GRID + 1 and (frames - 1) % GRID == 0


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


def file_fingerprints(path):
    """The same fingerprints as `fingerprints`, read from a video file: the mean of R, G and B, area-averaged to
    FP_SIZE, in 0..1."""
    h, w = FP_SIZE
    args = [_ffmpeg(), "-v", "error", "-i", path, "-an", "-vf", f"scale={w}:{h}:flags=area,format=rgb24",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    raw = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
    n = len(raw) // (w * h * 3)
    if n == 0:
        raise RuntimeError("no frames")
    rgb = np.frombuffer(raw[:n * w * h * 3], np.uint8).reshape(n, h, w, 3).astype(np.float32) / 255.0
    return rgb.mean(axis=3).reshape(n, -1)


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


# --------------------------------------------------------------------------- Latent Carry's saved latents

CARRY_FORMAT = "wan2gp.h3-latent-carry"
CARRY_VERSION = "1"


def find_carry_root(plugins_dir=None):
    """The latents folder of an installed H3 Latent Carry plugin (found by its store format, not its folder name)."""
    plugins_dir = plugins_dir or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        names = sorted(os.listdir(plugins_dir))
    except OSError:
        return None
    for name in names:
        store_py = os.path.join(plugins_dir, name, "store.py")
        try:
            with open(store_py, "r", encoding="utf-8", errors="ignore") as handle:
                if CARRY_FORMAT in handle.read():
                    return os.path.join(plugins_dir, name, "latents")
        except OSError:
            continue
    return None


def read_safetensors_header(path):
    with open(path, "rb") as handle:
        size = struct.unpack("<Q", handle.read(8))[0]
        if size > 16 * 1024 ** 2:
            raise ValueError("implausible safetensors header")
        return json.loads(handle.read(size))


def carry_window(header):
    """Where a Latent Carry entry's latents sit in its video, as one of this add-on's manifest windows, or (None, reason).

    An entry holds the last T latents of the job's final window (phase-aligned, so the slice starts on H3's 17-frame
    grid) and the last A audio latents, both ending where the file ends."""
    meta = header.get("__metadata__") or {}
    if meta.get("format") != CARRY_FORMAT or meta.get("version") != CARRY_VERSION:
        return None, "unsupported Latent Carry entry"
    info = json.loads(meta.get("manifest") or "{}")
    if "differ from the decoded window" in str(info.get("exported_differs") or ""):
        return None, "the saved file's frames differ from its latents"
    video = (header.get("video") or {}).get("shape") or []
    if len(video) != 5:
        return None, "unexpected latent shape"
    total, count = int(info.get("total_latents") or 0), int(video[2])
    file_frames, discard = int(info.get("frames") or 0), int(info.get("discard_last_frames") or 0)
    if total < count or (total - count) % LATENTS_PER_CLIP or (count - 2) % LATENTS_PER_CLIP or (total - 2) % LATENTS_PER_CLIP:
        return None, "the saved latents are not on H3's grid"
    window_frames = 5 + GRID * ((total - 2) // LATENTS_PER_CLIP)
    slice_start = (total - count) // LATENTS_PER_CLIP * GRID
    offset = file_frames + discard - window_frames + slice_start
    valid = window_frames - slice_start - discard
    if offset < 0 or valid < 5:
        return None, "the saved latents don't line up with the file"
    fps = float(info.get("fps") or 24)
    audio = (header.get("audio") or {}).get("shape")
    p1 = (header.get("video_p1") or {}).get("shape")
    window = {"offset": offset, "valid": valid, "frames": valid, "latents": count, "latent_hw": list(video[-2:]),
              "p1_hw": list(p1[-2:]) if p1 else None, "audio_ok": bool(audio), "source": "latent_carry",
              # the saved audio ends where the file ends; its first latent sits this many frames after `offset`
              "audio_origin": (file_frames - int(audio[-1]) * fps / AUDIO_LATENT_FPS - offset) if audio else 0.0}
    return window, ""


class CarryStore:
    """Read-only view of H3 Latent Carry's store (<root>/<sha>.safetensors)."""

    def __init__(self, root):
        self.root = root
        self._cache = {}

    def path(self, sha):
        return os.path.join(self.root, f"{sha}.safetensors")

    def manifest(self, sha):
        path = self.path(sha)
        try:
            stamp = os.path.getmtime(path)
        except OSError:
            return None
        hit = self._cache.get(sha)
        if hit and hit[0] == stamp:
            return hit[1]
        try:
            window, reason = carry_window(read_safetensors_header(path))
        except Exception as error:
            window, reason = None, repr(error)
        result = {"windows": [window]} if window else None
        if not window:
            _log(f"Latent Carry entry {sha[:12]} not usable: {reason}")
        self._cache[sha] = (stamp, result)
        return result

    def load(self, sha):
        manifest = self.manifest(sha)
        if not manifest:
            return None
        from safetensors.torch import load_file
        tensors = load_file(self.path(sha))
        w = manifest["windows"][0]
        return {"windows": [{"video": tensors["video"][0], "p1": tensors["video_p1"][0] if "video_p1" in tensors else None,
                             "audio": tensors["audio"][0] if "audio" in tensors else None, "audio_ok": w["audio_ok"],
                             "audio_origin": w["audio_origin"]}]}


class CombinedStore:
    """The editor's own sidecars first, then Latent Carry's (when it is installed): windows from both, in that order."""

    def __init__(self, own, carry=None):
        self.own, self.carry = own, carry

    def manifest(self, sha):
        mine = self.own.manifest(sha)
        theirs = self.carry.manifest(sha) if self.carry else None
        if not mine and not theirs:
            return None
        out = dict(mine or {})
        out["windows"] = list((mine or {}).get("windows") or []) + list((theirs or {}).get("windows") or [])
        return out

    def load(self, sha):
        mine = self.own.load(sha) if self.own.manifest(sha) else None
        theirs = self.carry.load(sha) if self.carry and self.carry.manifest(sha) else None
        if mine is None and theirs is None:
            return None
        return {"windows": list((mine or {}).get("windows") or []) + list((theirs or {}).get("windows") or [])}

    def has(self, sha):
        return bool(self.manifest(sha))

    def save(self, *args, **kwargs):
        return self.own.save(*args, **kwargs)

    def stats(self):
        stats = dict(self.own.stats())
        stats["latent_carry"] = self.carry.root if self.carry else None
        return stats


def open_store(data_root):
    carry_root = find_carry_root()
    return CombinedStore(LatentStore(os.path.join(data_root, "latents")), CarryStore(carry_root) if carry_root and os.path.isdir(carry_root) else None)


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
        self.masked = {}          # stage index -> [(place, latents)] held by WanGP's mask (latent grade only)
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
    alf = float(getattr(pm, "AUDIO_LATENT_FPS", AUDIO_LATENT_FPS))
    sr = int(getattr(pm, "AUDIO_SAMPLE_RATE", 32000))
    for pin in pins:
        frames = int(pin["frames"])
        kind = pin.get("kind") or "pinned"
        motion = kind == "motion" and pin["place"] == "before"
        history_only = kind == "history" and pin["place"] == "before"   # motion context ahead of a held window
        held = kind in ("masked", "both")      # WanGP's Denoise Control Video mask holds this window
        rows = kind != "masked"                # keyframe rows too (pinned, both, motion)
        if motion:
            # H3's native continuation: 17k frames of history (motion context, before the run on H3's timeline) plus
            # the join frame pinned as the run's first frame, exactly as Wan2GP lays out a sliding-window overlap
            if not legal_motion_frames(frames):
                raise ValueError(f"motion context must be 17k + 1 frames long (got {frames})")
            history_latents = (frames - 1) // GRID * LATENTS_PER_CLIP
            n = history_latents + 1
            used += 1
        elif history_only:
            if frames < GRID or frames % GRID:
                raise ValueError(f"motion context ahead of a held window must be 17k frames long (got {frames})")
            n = frames // GRID * LATENTS_PER_CLIP     # before the run on H3's timeline: none of the run's latents
        else:
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
        window = None
        if pin.get("sha") and STORE is not None and abs(src_fps - fps) < 1e-3:
            window, reason = find_window(STORE.manifest(pin["sha"]), start, frames)
            if window is None:
                plan.notes.append(f"{pin['place']} pin: pixel grade ({reason})")
            else:
                saved = STORE.load(pin["sha"])
        entry = None
        if saved is not None:
            entry = saved["windows"][window["index"]]
            lat0 = window["rel"] // GRID * LATENTS_PER_CLIP
            full = entry["video"][:, lat0:lat0 + n].float()            # stored [C, T, h, w]
            per_stage = []
            for si, (lh, lw) in enumerate(plan.stages):
                if tuple(full.shape[-2:]) == (lh, lw):
                    per_stage.append(full.unsqueeze(0))
                elif entry.get("p1") is not None and tuple(entry["p1"].shape[-2:]) == (lh, lw):
                    per_stage.append(entry["p1"][:, lat0:lat0 + n].float().unsqueeze(0))
                else:
                    per_stage.append(None)   # this stage is encoded from pixels below
            if any(lat is not None and lat.shape[2] != n for lat in per_stage):
                per_stage = [None] * len(plan.stages)
                plan.notes.append(f"{pin['place']} pin: pixel grade (the saved window is shorter than the pin)")
            else:
                latents = per_stage
                plan.notes.append(f"{pin['place']} pin: latent grade ({frames} frames{' of motion context' if motion or history_only else ''}"
                                  f"{', from Latent Carry' if window.get('source') == 'latent_carry' else ''})")
        pixels = None
        if held:
            # WanGP encodes the held window from the control video's pixels; latent grade swaps in the saved latents
            for si in range(len(stages)):
                if latents is not None and latents[si] is not None:
                    plan.masked.setdefault(si, []).append((pin["place"], latents[si]))
        for si, (h, w) in enumerate(stages):
            if not rows:
                break
            if latents is not None and latents[si] is not None:
                lat = latents[si]
            else:
                if pixels is None:
                    pixels = read_frames(path, start / src_fps, frames, fps, target_w, target_h)
                video = pixels if (h, w) == (target_h, target_w) else pm._resize_video(pixels, h, w)
                if motion:
                    lat = torch.cat([pipeline._encode_video(video[:, :frames - 1], keep_all_latents=True),
                                     pipeline._encode_video(video[:, frames - 1:])], dim=2)
                elif history_only:
                    lat = pipeline._encode_video(video, keep_all_latents=True)
                else:
                    lat = pipeline._encode_video(video, keep_all_latents=True)
            if lat.shape[2] != n:
                raise ValueError(f"a {frames}-frame pin encoded to {lat.shape[2]} latents instead of {n}")
            if motion:
                plan.video.setdefault(si, []).append(("history", lat[:, :, :n - 1]))
                plan.video[si].append(("before", lat[:, :, n - 1:]))
            elif history_only:
                plan.video.setdefault(si, []).append(("history", lat))
            else:
                plan.video.setdefault(si, []).append((pin["place"], lat))
        if latents is None and not any("pixel" in note for note in plan.notes if note.startswith(pin["place"])):
            plan.notes.append(f"{pin['place']} pin: pixel grade ({frames} frames{' of motion context' if motion or history_only else ''})")
        if held:
            plan.notes.append(f"{pin['place']} pin: held by the mask ({kind})")
        # audio: the pinned seconds of the clip's soundtrack, held at the same place
        if pin.get("audio", True) and not keep_audio:
            audio_latents = None
            count = int(round(frames / fps * alf))
            if entry is not None and entry.get("audio") is not None and entry.get("audio_ok"):
                a0 = int(round((window["rel"] - float(entry.get("audio_origin") or 0.0)) / fps * alf))
                if 0 <= a0 and a0 + count <= int(entry["audio"].shape[-1]):
                    audio_latents = entry["audio"][..., a0:a0 + count].float().unsqueeze(0)   # stored without the batch axis
            if audio_latents is None:
                wave = read_audio(path, start / src_fps, frames / fps, sr)
                audio_latents = pipeline._encode_audio(pipeline._waveform(wave, sr))
            count = int(audio_latents.shape[-1])
            if motion:
                # as Wan2GP does: the join frame's share of audio is pinned at the run's start, the rest is history
                boundary = min(count, max(1, round(alf / fps)))
                if count > boundary:
                    plan.audio.append(({"anchor": "history", "latent_frame_count": count - boundary}, audio_latents[..., :count - boundary]))
                plan.audio.append(({"anchor": "first", "latent_frame_count": boundary}, audio_latents[..., count - boundary:]))
            elif history_only:
                plan.audio.append(({"anchor": "history", "latent_frame_count": count}, audio_latents))
            elif pin["place"] == "before":
                plan.audio.append(({"anchor": "first", "latent_frame_count": count}, audio_latents))
            else:
                start_index = int(round((frame_num - frames) / fps * alf))
                plan.audio.append(({"anchor": f"tail@{start_index}", "latent_frame_count": count}, audio_latents))
    return plan


# --------------------------------------------------------------------------- patched pipeline methods

def _impl_generate(self, original, *args, **kwargs):
    if args or kwargs.get("refinement_mode") or kwargs.get("image_mode"):
        return original(self, *args, **kwargs)
    ensure_on_top()
    job = _JOB.get()
    _count("generate")
    window_no = kwargs.get("window_no")
    record = {"window_no": window_no, "fps": float(kwargs.get("fps") or 24), "video": None, "audio": None, "p1": None,
              "fp": None, "continuation": kwargs.get("input_video") is not None and int(kwargs.get("prefix_frames_count") or 0) > 0,
              "plan": None, "pipeline": self, "frame_num": int(kwargs.get("frame_num") or 0)}
    spec = (job or {}).get("spec")
    if spec and spec.get("mode") == "render":
        # a final render: phase 1 is a token single step, and the latent upscaler is handed the stretch's drafts
        record["render"] = spec
        _count("render")
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
    restore = None
    if spec and spec.get("windowJoin") == "motion_masked" and window_no is not None and int(window_no) > 1:
        try:
            restore = _window_join(self, kwargs)
        except Exception as error:
            _log(f"window {window_no}: left as WanGP joins it ({error!r})")
    token = _GEN.set(record)
    try:
        result = original(self, *args, **kwargs)
    finally:
        _GEN.reset(token)
        if restore:
            restore()
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


WINDOW_HELD_FRAMES = 18      # the previous window's last frames held inside the next one (the rest of the overlap is history)


def _window_join(pipeline, kwargs):
    """A sliding window joined to the one before it as a Motion + masked join. WanGP hands H3 the previous window's
    last R frames: natively R-1 of them become history and only the last is pinned. Here the earlier R-18 become
    history and the last 18 start the window, where WanGP's control video already has them, held by the mask; their
    sound is held there too. WanGP still trims R frames off the window, so the seam lands after the held frames,
    inside this window's single rendering. Returns a function that undoes the audio hook."""
    video = kwargs.get("input_video")
    R = int(kwargs.get("prefix_frames_count") or 0)
    if video is None or kwargs.get("input_masks") is None or kwargs.get("input_frames") is None:
        raise ValueError("not a masked run")
    A = R - WINDOW_HELD_FRAMES
    if A < GRID or A % GRID or video.shape[1] < R:
        raise ValueError(f"an overlap of {R} frames leaves no room for history and held frames")
    kwargs["input_video"] = video[:, :A + 1]
    kwargs["prefix_frames_count"] = A + 1
    _count("window_join")
    restore = None
    waveform, rate = kwargs.get("input_waveform"), kwargs.get("input_waveform_sample_rate")
    if waveform is not None and rate:
        # hold the held frames' sound: H3 pins only the first frame's share after the history, so swap in all 18
        pm = _pipeline_module()
        sr = int(getattr(pm, "AUDIO_SAMPLE_RATE", 32000))
        fps = float(kwargs.get("fps") or 24)
        wave = pipeline._waveform(waveform, rate)
        a0, a1 = round(A / fps * sr), round(R / fps * sr)
        held = pipeline._encode_audio(wave[0][..., a0:a1][None]) if wave[0].shape[-1] >= a1 else None
        if held is not None:
            inner = pipeline._add_audio_condition
            state = {"history": False, "done": False}

            def add_audio_condition(latents, anchor, *rest, **kw):
                if anchor == "history":
                    state["history"] = True
                elif anchor == "first" and state["history"] and not state["done"]:
                    state["done"] = True
                    latents = held.to(device=latents.device, dtype=latents.dtype)
                return inner(latents, anchor, *rest, **kw)

            pipeline._add_audio_condition = add_audio_condition

            def restore():
                try:
                    del pipeline._add_audio_condition
                except AttributeError:
                    pass
    _log(f"window joined as Motion + masked: {A} frames of history, {WINDOW_HELD_FRAMES} held")
    return restore


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
            history_at = 0
            for place, lat in pins:
                if tuple(lat.shape[-2:]) != (lh, lw):
                    raise ValueError(f"Video Editor pins: a pin is {tuple(lat.shape[-2:])} latents but this stage is {(lh, lw)}")
                if place == "history":
                    # motion context goes first, where Wan2GP puts a sliding window's history
                    visual_latents.insert(history_at, lat)
                    keyframes.insert(history_at, {"anchor": "history", "latent_frame_count": int(lat.shape[2])})
                    history_at += 1
                    insert_at += 1
                    continue
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


def _impl_encode_source(vae, inner, source, *args, **kwargs):
    """WanGP's encode of a Denoise Control Video source (once per sampling phase): put the saved latents of the masked
    pins over the windows they hold, so the held frames are the neighbour's own latents, not a re-encode."""
    latents = inner(vae, source, *args, **kwargs)
    record = _GEN.get()
    plan = record.get("plan") if record else None
    if plan is None or not plan.masked or not hasattr(latents, "shape"):
        return latents
    hw = tuple(latents.shape[-2:])
    stage = next((si for si, dims in enumerate(plan.stages) if tuple(dims) == hw), None)
    if stage is None:
        _log(f"masked pins: no stage of {hw} latents; held windows stay pixel grade")
        return latents
    total = int(latents.shape[2])
    for place, lat in plan.masked.get(stage, []):
        n = int(lat.shape[2])
        if n > total:
            continue
        window = slice(0, n) if place == "before" else slice(total - n, total)
        latents[:, :, window] = lat.to(device=latents.device, dtype=latents.dtype)
    _STATE["held"] = _STATE.get("held", 0) + 1
    return latents


def render_windows(latent_t, window_latents, overlap_latents):
    """Overlapping windows over `latent_t` latents for a final render: each starts on H3's 5-latent cycle (a window that
    starts mid-cycle paints a flicker every 17 frames) and is 2 + 5n latents long, like a real video; the last one
    ends on the last latent. Returns [(start, end)]."""
    if latent_t <= window_latents:
        return [(0, latent_t)]
    stride = max(LATENTS_PER_CLIP, (window_latents - overlap_latents) // LATENTS_PER_CLIP * LATENTS_PER_CLIP)
    last = latent_t - window_latents
    last -= last % LATENTS_PER_CLIP          # latent_t is 2 + 5k, so the last window is 2 + 5n long too
    regular = list(range(0, last, stride))
    if (len(regular) > 1 and last - regular[-1] < stride // 2
            and regular[-2] + window_latents - last >= LATENTS_PER_CLIP):
        regular.pop()                        # the end window already covers most of it
    starts = sorted(set(regular + [last]))
    return [(a, a + window_latents) for a in starts[:-1]] + [(last, latent_t)]


def window_weights(start, end, latent_t, ramp):
    """Blend weights for a window's latents: 1 inside, ramping up from its left edge and down to its right edge over
    `ramp` latents, except where the window meets the start or end of the whole latent."""
    import numpy as np
    n = end - start
    w = np.ones(n, dtype=np.float32)
    ramp = max(1, int(ramp))
    if start > 0:
        w[:ramp] = np.minimum(w[:ramp], (np.arange(ramp, dtype=np.float32)[:n] + 1) / (ramp + 1))
    if end < latent_t:
        w[n - ramp:] = np.minimum(w[n - ramp:], (np.arange(ramp, 0, -1, dtype=np.float32)[-min(n, ramp):]) / (ramp + 1))
    return w


def _impl_transformer_forward(self, inner, video_x, audio_x, sigma_video, sigma_audio, context, payload, *args, **kwargs):
    """A final render's long latent, sampled in overlapping windows (each with its neighbours in view, nothing
    committed ahead of them) and the windows' predictions blended at every step: no seams, and memory for one window."""
    record = _GEN.get()
    spec = (record or {}).get("render") if record else None
    if not spec or not isinstance(payload, dict) or video_x.dim() != 5 or payload.get("target_video_order") is not None:
        return inner(self, video_x, audio_x, sigma_video, sigma_audio, context, payload, *args, **kwargs)
    import torch
    if any(v is not None for v in list(args) + list(kwargs.values())):
        # a step-skipping cache is on (Spectrum or first-block): it needs every step's full pass, so no skipping and
        # no windows here (the editor turns it off for final renders; this is a safety net)
        if not record.get("render_cache_noted"):
            record["render_cache_noted"] = True
            _log("final render: step skipping is on, so the render runs in one piece without windows")
        if record.get("render_phase2"):
            audio_x = _render_audio(record, audio_x)
        video_v, audio_v = inner(self, video_x, audio_x, sigma_video, sigma_audio, context, payload, *args, **kwargs)
        return (_hold_pins(record, video_x, video_v, sigma_video) if record.get("render_phase2") else video_v), audio_v
    if not record.get("render_phase2"):
        # phase 1's result is replaced by the drafts before phase 2: don't spend a pass of the model on it
        _count("render_phase1_skipped")
        return torch.zeros_like(video_x), torch.zeros_like(audio_x)
    audio_x = _render_audio(record, audio_x)
    fps = float(record.get("fps") or 24)
    latent_t = int(video_x.shape[2])
    window_frames = float(spec.get("window_seconds") or 10.0) * fps
    window_latents = 2 + max(1, int(round((window_frames - 5) / GRID))) * LATENTS_PER_CLIP
    overlap_latents = max(LATENTS_PER_CLIP, int(round(float(spec.get("overlap_seconds") or 2.0) * fps / GRID * LATENTS_PER_CLIP)))
    windows = render_windows(latent_t, window_latents, overlap_latents)
    if "render_pins" not in record:
        record["render_pins"] = _render_pins(record, latent_t, int(video_x.shape[-2]), int(video_x.shape[-1])) if spec.get("holds") else []
    if len(windows) == 1:
        video_v, audio_v = inner(self, video_x, audio_x, sigma_video, sigma_audio, context, payload, *args, **kwargs)
        return _hold_pins(record, video_x, video_v, sigma_video), audio_v
    alf = AUDIO_LATENT_FPS
    tail = int(getattr(_pipeline_module(), "H3_AUDIO_TAIL_LATENTS", 5))
    audio_total = int(audio_x.shape[-1])
    per_frame = sigma_video.numel() == latent_t
    out = torch.zeros_like(video_x, dtype=torch.float32)
    weight_sum = torch.zeros(latent_t, dtype=torch.float32, device=video_x.device)
    for start, end in windows:
        n = end - start
        frames = 5 + (n - 2) // LATENTS_PER_CLIP * GRID
        frame0 = start // LATENTS_PER_CLIP * GRID
        a0 = min(audio_total - 1, int(round(frame0 / fps * alf)))
        a1 = min(audio_total, a0 + int(round(frames / fps * alf)) + tail)
        window_payload = dict(payload)
        # a fresh layout and rope for the window's length; keyframes belong to the whole clip's timeline
        for key in ("layout_signature", "layout", "rope", "graph_input_indices", "keyframes", "audio_keyframes"):
            window_payload.pop(key, None)
        window_payload.update(frame_count=frames, target_audio_condition_latents=a1 - a0)
        sigma = sigma_video.reshape(-1)[start:end] if per_frame else sigma_video
        # step caches (spectrum, first-block) would mix the windows up: each window runs the model in full
        video_v, _ = inner(self, video_x[:, :, start:end].contiguous(), audio_x[..., a0:a1].contiguous(), sigma, sigma_audio,
                           context, window_payload)
        w = torch.from_numpy(window_weights(start, end, latent_t, overlap_latents)).to(video_x.device)
        out[:, :, start:end] += video_v.float() * w.view(1, 1, -1, 1, 1)
        weight_sum[start:end] += w
        _count("render_window")
    out /= weight_sum.clamp(min=1e-6).view(1, 1, -1, 1, 1)
    # the soundtrack is frozen in phase 2 (and phase 1's is thrown away): no audio prediction is needed
    return _hold_pins(record, video_x, out.to(video_x.dtype), sigma_video), torch.zeros_like(audio_x)


def _render_audio(record, audio_x):
    """Phase 2 keeps phase 1's soundtrack as fixed context; in a final render phase 1 is skipped, so hand it the
    drafts' own sound instead (encoded once). Anything unexpected keeps WanGP's."""
    spec = record.get("render") or {}
    if "render_audio" not in record:
        record["render_audio"] = None
        path = spec.get("draft_audio")
        if path and os.path.isfile(path):
            try:
                pm = _pipeline_module()
                pipeline = record["pipeline"]
                sr = int(getattr(pm, "AUDIO_SAMPLE_RATE", 32000))
                fps = float(record.get("fps") or 24)
                seconds = int(audio_x.shape[-1]) / float(getattr(pm, "AUDIO_LATENT_FPS", AUDIO_LATENT_FPS)) + 1.0
                wave = read_audio(path, 0.0, seconds, sr)
                record["render_audio"] = pipeline._encode_audio(pipeline._waveform(wave, sr))
                _log("final render: phase 2 hears the drafts' soundtrack")
            except Exception as error:
                _log(f"final render: couldn't use the drafts' soundtrack ({error!r}); keeping WanGP's")
    audio = record.get("render_audio")
    if audio is None:
        return audio_x
    try:
        import torch
        audio = audio.to(device=audio_x.device, dtype=audio_x.dtype)
        while audio.dim() < audio_x.dim():
            audio = audio.unsqueeze(0)
        if tuple(audio.shape[:-1]) != tuple(audio_x.shape[:-1]):
            raise ValueError(f"{tuple(audio.shape)} vs {tuple(audio_x.shape)}")
        n = int(audio_x.shape[-1])
        if audio.shape[-1] < n:
            audio = torch.cat([audio, audio[..., -1:].expand(*audio.shape[:-1], n - audio.shape[-1])], -1)
        return audio[..., :n].contiguous()
    except Exception as error:
        record["render_audio"] = None
        _log(f"final render: the drafts' soundtrack doesn't fit ({error!r}); keeping WanGP's")
        return audio_x


def _hold_pins(record, video_x, video_v, sigma_video):
    """Steer the pinned latents to their known values: the sampler's denoised estimate is x + sigma * v, so
    v = (target - x) / sigma lands them there exactly while the model still sees them as part of the shot."""
    pins = record.get("render_pins") or []
    if not pins:
        return video_v
    sigma = float(sigma_video.reshape(-1).max())
    if sigma <= 1e-5:
        return video_v
    video_v = video_v.clone()
    for first, end, target in pins:
        x = video_x[:, :, first:end].float()
        video_v[:, :, first:end] = ((target.to(x.device) - x) / sigma).to(video_v.dtype)
    _count("render_pinned")
    return video_v


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
    _count("decode")
    if record is not None and _JOB.get() is not None:
        try:
            record["video"] = latents.detach().to("cpu", copy=True).to(dtype=_half())[0]
            frames = decoded[0] if hasattr(decoded, "dim") and decoded.dim() == 5 else decoded
            record["fp"] = fingerprints(frames)
            _count("captured")
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


def _render_source(record, normalized):
    """The final render's replacement for phase 1's latent: the stretch's draft frames at phase 1's size, encoded by
    the model's VAE (as WanGP encodes a control video) and normalised as the upscaler expects."""
    import torch
    pm = _pipeline_module()
    pipeline = record["pipeline"]
    spec = record["render"]
    latent_t, (lh, lw) = int(normalized.shape[2]), normalized.shape[-2:]
    frames = read_frames(spec["draft"], 0.0, int(record["frame_num"]) or latent_t, float(record["fps"]), lw * 16, lh * 16)
    latents = pm._encode_video_source(pipeline.vae, frames, pipeline.device, None)
    latents = latents.to(device=normalized.device, dtype=torch.float32)[:, :, :latent_t]
    if latents.shape[2] < latent_t:
        latents = torch.cat([latents, latents[:, :, -1:].expand(-1, -1, latent_t - latents.shape[2], -1, -1)], dim=2)
    if tuple(latents.shape[-2:]) != (lh, lw):
        raise ValueError(f"the draft encoded to {tuple(latents.shape[-2:])} latents, phase 1 is {(lh, lw)}")
    mean = normalized.new_tensor(pm.LATENTS_MEAN, dtype=torch.bfloat16).view(1, -1, 1, 1, 1)
    std = normalized.new_tensor(pm.LATENTS_STD, dtype=torch.bfloat16).view(1, -1, 1, 1, 1)
    return ((latents.to(torch.bfloat16) - mean) / std).to(normalized.dtype)


PIN_LEAD_LATENTS = 8    # latents of lead-in encoded ahead of a pinned stretch, so the causal VAE's state settles


def pin_latents(frame0, frame1):
    """The latents lying wholly inside frames [frame0, frame1): latent 0 is frame 0, latent i (i >= 1) is frames
    4i-3 .. 4i. Returns (first, end) with end exclusive."""
    first = 0 if frame0 <= 0 else (frame0 + 3 + 3) // 4
    end = (frame1 - 1) // 4 + 1
    return first, max(first, end)


def _render_pins(record, latent_t, lh, lw):
    """Encoded latents (at the refine size) of the stretches a final render must reproduce exactly: the neighbouring
    finals' frames either side, so the new render picks up where they leave off and hands over where they begin."""
    import torch
    pm = _pipeline_module()
    pipeline = record["pipeline"]
    spec = record["render"]
    fps = float(record["fps"])
    pins = []
    for pin in spec.get("holds") or []:
        first, end = pin_latents(int(pin["frame0"]), int(pin["frame1"]))
        end = min(end, latent_t)
        if end <= first:
            continue
        lead = max(0, first - PIN_LEAD_LATENTS)
        frame_start = 0 if lead == 0 else 4 * lead      # a latent's last frame: encoding from it keeps the grid
        count = 4 * (end - 1) - frame_start + 1
        frames = read_frames(spec["pinvideo"], frame_start / fps, count, fps, lw * 16, lh * 16)
        latents = pm._encode_video_source(pipeline.vae, frames, pipeline.device, None)
        latents = latents.to(device=pipeline.device, dtype=torch.float32)
        got = latents[:, :, first - lead:end - lead]
        if got.shape[2] != end - first or tuple(got.shape[-2:]) != (lh, lw):
            raise ValueError(f"pinned frames encoded to {tuple(got.shape)}, expected {end - first} latents at {(lh, lw)}")
        pins.append((first, end, got))
        _log(f"final render: latents {first}-{end} held to the neighbouring final")
    return pins


def _capture_phase_1(module, args):
    record = _GEN.get()
    if record is None or _JOB.get() is None or not args:
        return None
    if record.get("render"):
        try:
            replaced = _render_source(record, args[0])
            spec = record["render"]
            if spec.get("holds") and spec.get("size"):
                width, height = (int(v) for v in spec["size"])
                record["render_pins"] = _render_pins(record, int(replaced.shape[2]), -(-height // 16), -(-width // 16))
            record["render_phase2"] = True
            _count("render_source")
            _log(f"final render: phase 2 refines the drafts ({replaced.shape[2]} latents at {tuple(replaced.shape[-2:])})")
            return (replaced,) + tuple(args[1:])
        except Exception as error:
            traceback.print_exc()
            raise RuntimeError(f"Video Editor final render could not load the drafts: {error!r}")
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
        _count("jobs")
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
        _count("save_video")
        if job is None:
            _count("save_video_no_job")
        elif not job["windows"]:
            _count("save_video_before_generation")
        if job is not None and job["windows"]:
            try:
                values = _bind(original, args, kwargs)
                tensor = values.get("tensor")
                # WanGP passes the frames as one tensor, or as the list of per-window chunks it has gathered
                # (CFHW each, joined along frames): fingerprint each piece and join the fingerprints
                parts = tensor if isinstance(tensor, (list, tuple)) else [tensor]
                parts = [t for t in parts if t is not None and hasattr(t, "dim") and t.dim() in (4, 5)]
                if parts:
                    job["final_fp"] = np.concatenate([fingerprints(t) for t in parts], 0)
                    _count("fingerprinted")
                else:
                    _log(f"could not fingerprint the saved video: unexpected frames ({type(tensor).__name__})")
            except Exception as error:
                job["final_fp"] = None
                _log(f"could not fingerprint the saved video: {error!r}")
        return original(*args, **kwargs)
    return save_video


_PARTIALS = {}           # editor job id -> copies of the files WanGP saved after each sliding window, in order


def _keep_partial(job, path):
    """Copy a file WanGP has just saved (after a window) into the editor job's folder: the timeline shows the run as
    it goes, and keeps the finished windows if it is stopped. WanGP may delete or overwrite its interim files."""
    spec = job.get("spec") or {}
    folder, job_id = spec.get("partialDir"), spec.get("jobId")
    if not folder or not job_id or not os.path.isfile(path):
        return
    try:
        import shutil
        with _LOCK:
            n = len(_PARTIALS.setdefault(job_id, [])) + 1
        target = os.path.join(folder, f"window_{n:02d}{os.path.splitext(path)[1] or '.mp4'}")
        shutil.copy2(path, target)
        with _LOCK:
            _PARTIALS[job_id].append(target)
    except Exception as error:
        _log(f"could not keep the window's file: {error!r}")


def partials(job_id):
    with _LOCK:
        return list(_PARTIALS.get(job_id, []))


def _wrap_record_file_metadata(original):
    @functools.wraps(original)
    def record_file_metadata(*args, **kwargs):
        result = original(*args, **kwargs)
        job = _JOB.get()
        if job is not None:
            try:
                values = _bind(original, args, kwargs)
                if not values.get("is_image") and not values.get("audio_only"):
                    path = values.get("video_path")
                    path = path[-1] if isinstance(path, list) and path else path
                    if isinstance(path, str) and path:
                        job["saves"].append((os.path.abspath(path), job["final_fp"], values.get("configs") or {}))
                        _count("recorded")
                        _keep_partial(job, path)
            except Exception as error:
                _log(f"latents not saved: {error!r}")
        return result
    return record_file_metadata


def _finish(job):
    """Write the sidecar for the job's final file (the last one recorded)."""
    _count("finish")
    if not job["saves"] or not job["windows"] or STORE is None:
        if job["windows"] and not job["saves"]:
            _log("latents not saved: the generation's video file was not seen being recorded")
        return
    path, file_fp, configs = job["saves"][-1]
    if not os.path.isfile(path):
        return
    if file_fp is None:
        # the frames weren't seen on their way to the file: read the file's own frames instead
        try:
            file_fp = file_fingerprints(path)
            _count("fingerprinted_from_file")
        except Exception as error:
            _log(f"latents not saved for {os.path.basename(path)}: could not read its frames ({error!r})")
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
        _count("matched")
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
                   "video_decode": _impl_video_decode, "audio_decode": _impl_audio_decode, "layout": _impl_layout,
                   "encode_source": _impl_encode_source, "transformer_forward": _impl_transformer_forward})
    if transformer_class is not None and "forward" in transformer_class.__dict__:
        owners["transformer_forward"] = (transformer_class, "forward")
    if hasattr(pm, "_encode_video_source"):
        owners["encode_source"] = (pm, "_encode_video_source")
    else:
        _log("this WanGP has no _encode_video_source: masked joins will be pixel grade")
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
    STORE = open_store(data_root)
    if STORE.carry:
        _log(f"using H3 Latent Carry's saved latents too ({STORE.carry.root})")
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


def _hook_report():
    """For each binding we patch: is our wrapper the outermost (True), somewhere in the chain ("inner"), or gone (False)."""
    out = {}
    try:
        for key, (owner, attr) in _OWNERS.items():
            current = getattr(owner, attr, None)
            out[key] = True if getattr(current, _MARK, False) else ("inner" if _is_ours(current) else False)
        for name in _HOOKS:
            current = (_NAMESPACE or {}).get(name)
            out[name] = True if getattr(current, _MARK, False) else ("inner" if _is_ours(current) else False)
    except Exception as error:
        out["error"] = repr(error)
    return out


def status():
    return {"installed": _STATE["installed"], "problems": list(_STATE["problems"]), "saved": _STATE["saved"],
            "pinned": _STATE["pinned"], "last": _STATE["last"], "trace": dict(_STATE["trace"]), "hooks": _hook_report(), "store": STORE.stats() if STORE else None}
