"""Planning for timeline generations (extend, prepend, bridge, fill a gap, loop): pin windows, H3's 17-frame grid,
legal run lengths, and how well a join plays (the seam verdict). Pure functions; the service in regen.py uses them.

Times on the editor side are seconds; here everything is converted to frames of the source file (for pins) or of the
generation (for lengths)."""

import json
import math
import os
import subprocess

import numpy as np

from . import media as M

GRID = 17
PIN_WINDOWS = (22, 39, 56)          # H3's context ladder: 5 + 17n frames
MAX_GRID_SHIFT = GRID - 1           # a cut moves at most this many frames to reach latent grade


def legal_total(frames, minimum=107, step=GRID, offset=5):
    """The smallest legal run length (offset + step*k frames) that is >= frames and >= minimum."""
    frames = max(int(math.ceil(frames)), int(minimum))
    k = max(0, int(math.ceil((frames - offset) / step)))
    return offset + k * step


def nearest_total(frames, minimum=107, step=GRID, offset=5, at_least=0):
    """The legal run length closest to `frames` (ties go up), never below minimum or at_least."""
    floor_total = max(int(minimum), int(at_least))
    lo = offset + max(0, int((frames - offset) // step)) * step
    candidates = [c for c in (lo, lo + step) if c >= floor_total]
    if not candidates:
        return legal_total(floor_total, minimum, step, offset)
    return min(candidates, key=lambda c: (abs(c - frames), -c))


def plan_lengths(new_seconds, fps, before, after, minimum=107, nearest=True):
    """Frames of a pinned run: total (legal), and the new frames between the pins."""
    want = before + after + max(1, int(round(new_seconds * fps)))
    at_least = before + after + 1
    total = nearest_total(want, minimum, at_least=at_least) if nearest else legal_total(max(want, at_least), minimum)
    return {"total": total, "new": total - before - after, "before": before, "after": after}


def fit_window(window, available):
    """The largest pin window <= window that fits in `available` frames (or 0)."""
    sizes = [w for w in (5,) + PIN_WINDOWS if w <= available]
    sizes = [w for w in sizes if w <= window] or sizes[:1]
    return max(sizes) if sizes else 0


def align_before_pin(manifest, cut, frames):
    """An extend's pin: the `frames` frames ending at source frame `cut`. Latent grade needs the pin to start on the
    saved window's grid, so the cut may move earlier. Returns {"start", "cut", "grade", "shift", "reason"}."""
    exact = {"start": cut - frames, "cut": cut, "grade": "pixel", "shift": 0, "reason": ""}
    windows = (manifest or {}).get("windows") or []
    if not windows:
        exact["reason"] = "no saved latents for this clip"
        return exact
    best = None
    for w in windows:
        o, valid = int(w["offset"]), int(w["valid"])
        end = min(cut, o + valid)
        if end - o < frames:
            continue
        start = o + ((end - frames - o) // GRID) * GRID
        if start < o:
            continue
        shift = cut - (start + frames)
        if best is None or shift < best["shift"]:
            best = {"start": start, "cut": start + frames, "grade": "latent", "shift": shift, "reason": ""}
    if best is None:
        exact["reason"] = "the cut is not inside one saved window"
        return exact
    if best["shift"] > MAX_GRID_SHIFT:
        exact["reason"] = f"latent grade would move the cut {best['shift']} frames"
        return exact
    return best


def align_after_pin(manifest, cut, frames):
    """A prepend's pin: the `frames` frames starting at source frame `cut` (the next clip's in-point). Latent grade may
    move the cut later. Returns {"start", "cut", "grade", "shift", "reason"}."""
    exact = {"start": cut, "cut": cut, "grade": "pixel", "shift": 0, "reason": ""}
    windows = (manifest or {}).get("windows") or []
    if not windows:
        exact["reason"] = "no saved latents for this clip"
        return exact
    best = None
    for w in windows:
        o, valid = int(w["offset"]), int(w["valid"])
        start = o + math.ceil((cut - o) / GRID) * GRID if cut > o else o   # first grid frame at or after the cut
        if start + frames > o + valid:
            continue
        shift = start - cut
        if shift < 0:
            continue
        if best is None or shift < best["shift"]:
            best = {"start": start, "cut": start, "grade": "latent", "shift": shift, "reason": ""}
    if best is None:
        exact["reason"] = "the cut is not inside one saved window"
        return exact
    if best["shift"] > MAX_GRID_SHIFT:
        exact["reason"] = f"latent grade would move the cut {best['shift']} frames"
        return exact
    return best


# --------------------------------------------------------------------------- seam verdicts

def _small_frames(path, start, count, fps, size=(64, 36)):
    w, h = size
    args = [M.ffmpeg_path(), "-v", "error", "-ss", f"{max(0.0, start):.4f}", "-i", path, "-an",
            "-vf", f"fps={fps},scale={w}:{h}:flags=area,format=gray", "-frames:v", str(count), "-f", "rawvideo", "-"]
    raw = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **M.popen_kwargs()).stdout
    n = len(raw) // (w * h)
    return np.frombuffer(raw[:n * w * h], np.uint8).reshape(n, h, w).astype(np.float32) / 255.0


def seam_verdict(path_a, end_a, path_b, start_b, fps, frames=6):
    """How the join from clip A (ending at end_a seconds of its file) into clip B (starting at start_b) plays:
    the picture change across the join compared with the change between neighbouring frames on either side."""
    a = _small_frames(path_a, end_a - frames / fps, frames, fps)
    b = _small_frames(path_b, start_b, frames, fps)
    if len(a) < 2 or len(b) < 2:
        return {"verdict": "unknown", "ratio": None}
    diff = lambda x, y: float(np.abs(x - y).mean())
    inside = [diff(a[i], a[i + 1]) for i in range(len(a) - 1)] + [diff(b[i], b[i + 1]) for i in range(len(b) - 1)]
    join = diff(a[-1], b[0])
    base = max(float(np.median(inside)), 0.004)
    ratio = join / base
    verdict = "seamless" if ratio < 2.2 else "soft bump" if ratio < 4.5 else "hard cut"
    return {"verdict": verdict, "ratio": round(ratio, 2), "join": round(join, 4), "motion": round(base, 4)}
