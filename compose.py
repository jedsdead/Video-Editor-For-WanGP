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


MOTION_WINDOWS = (18, 35, 52)      # motion context: 17k frames of history + the join frame


def motion_window(window, available):
    """The motion-context size for a pin-window choice (22/39/56 -> 18/35/52) that fits in `available` frames (or 0)."""
    k = max(1, (int(window) - 5) // GRID)
    sizes = [w for w in MOTION_WINDOWS if w <= available]
    sizes = [w for w in sizes if (w - 1) // GRID <= k] or sizes[:1]
    return max(sizes) if sizes else 0


def align_before_pin(manifest, cut, frames):
    """An extend's pin: the `frames` frames ending at source frame `cut`. Latent grade needs the pin to start on the
    saved window's grid, so the cut may move earlier. Returns {"start", "cut", "grade", "shift", "reason"}."""
    exact = {"start": cut - frames, "cut": cut, "grade": "pixel", "shift": 0, "reason": ""}
    windows = (manifest or {}).get("windows") or []
    if not windows:
        exact["reason"] = "no saved latents for this clip (from the editor's add-on or Latent Carry)"
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
            best = {"start": start, "cut": start + frames, "grade": "latent", "shift": shift, "reason": "", "source": w.get("source", "editor")}
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
            best = {"start": start, "cut": start, "grade": "latent", "shift": shift, "reason": "", "source": w.get("source", "editor")}
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


# --------------------------------------------------------------------------- level lock
# A continuation opens at a slightly different level from the footage it continues (a bias of the model given that
# context, so re-rolling doesn't fix it); it lasts ~12 frames and then settles. The lock predicts where the earlier
# clip was heading, and gains the new clip's opening frames per channel onto that, ramping back to no change by frame
# 12. The same maths mirrored corrects a run's closing frames where it runs into an existing clip. Thresholds and the
# method follow comfyui-obvpm-timeline's levellock.py (MIT), measured there over 38 joins.

LOCK_FRAMES = 12
LOCK_FIT = 12
STEP_OVER_NOISE, STEP_FLOOR = 3.0, 0.6      # levels 0..255
SWING_OVER_NOISE, SWING_FLOOR = 3.0, 1.5
MAX_GAIN = 1.06


def _channel_means(path, start, count, fps, size=(160, 90)):
    w, h = size
    args = [M.ffmpeg_path(), "-v", "error", "-ss", f"{max(0.0, start):.4f}", "-i", path, "-an",
            "-vf", f"fps={fps},scale={w}:{h}:flags=area,format=rgb24", "-frames:v", str(count), "-f", "rawvideo", "-"]
    raw = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **M.popen_kwargs()).stdout
    n = len(raw) // (w * h * 3)
    return np.frombuffer(raw[:n * w * h * 3], np.uint8).reshape(n, h, w, 3).astype(np.float64).mean(axis=(1, 2))


def _line(y):
    return np.polyfit(np.arange(float(len(y))), y, 1)


def _luma(rgb):
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def level_measure(tail, head, frames=LOCK_FRAMES):
    """tail: the earlier clip's last frames (n, 3); head: the later clip's first frames. None if too short."""
    if len(tail) < 4 or len(head) < 4:
        return None
    delta = []
    for c in range(3):
        slope, icept = _line(tail[:, c])
        delta.append(float(slope * len(tail) + icept - _line(head[:, c])[1]))
    lt, lh = _luma(tail), _luma(head)
    slope, icept = _line(lt)
    pred = float(slope * len(lt) + icept)
    local = float(np.abs(np.diff(lt)).mean())
    s2, i2 = _line(lh)
    resid = lh - (s2 * np.arange(float(len(lh))) + i2)
    step = float(lh[:3].mean() - pred)
    swing = float(resid.max() - resid.min())
    return {"delta": delta, "step": step, "swing": swing, "local": local,
            "do_step": abs(step) > max(STEP_FLOOR, STEP_OVER_NOISE * local),
            "do_swing": swing > max(SWING_FLOOR, SWING_OVER_NOISE * local)}


def level_gains(m, frames, closing=False):
    """Per-frame (n, 3) gains for a clip's opening (closing=False) or closing frames, or None when nothing needs it."""
    if not m or not (m["do_step"] or m["do_swing"]):
        return None
    n = len(frames)
    if n < 2:
        return None
    ramp = (np.arange(float(n)) + 1.0) / n if closing else 1.0 - np.arange(float(n)) / n
    out = np.ones((n, 3))
    for c in range(3):
        actual = frames[:, c]
        if m["do_swing"]:
            s2, i2 = _line(actual)
            base = s2 * np.arange(float(n)) + i2
        else:
            base = actual
        shift = m["delta"][c] * ramp if m["do_step"] else 0.0
        desired = base - shift if closing else base + shift
        with np.errstate(divide="ignore", invalid="ignore"):
            g = np.where(np.abs(actual) > 1e-6, desired / actual, 1.0)
        out[:, c] = np.clip(g, 1.0 / MAX_GAIN, MAX_GAIN)
    return out


def level_lock(path_a, end_a, path_b, start_b, fps, correct="b"):
    """Gains for the join from clip A (ending at end_a seconds of its file) into clip B (starting at start_b).
    correct="b" corrects B's opening (an extend); "a" corrects A's closing (a run that arrives on B).
    Returns {"src0", "fps", "gains", "step", "swing"} with src0 the source time of the first corrected frame, or a
    dict with gains None when the join needs nothing."""
    tail = _channel_means(path_a, end_a - LOCK_FIT / fps, LOCK_FIT, fps)
    head = _channel_means(path_b, start_b, LOCK_FRAMES, fps)
    m = level_measure(tail, head)
    if correct == "b":
        gains, src0 = level_gains(m, head[:LOCK_FRAMES]), start_b
    else:
        closing = tail[-LOCK_FRAMES:]
        gains, src0 = level_gains(m, closing, closing=True), end_a - len(closing) / fps
    info = {"src0": round(src0, 6), "fps": fps, "gains": None if gains is None else np.round(gains, 5).tolist()}
    if m:
        info.update({"step": round(m["step"], 3), "swing": round(m["swing"], 3), "noise": round(m["local"], 3)})
    return info
