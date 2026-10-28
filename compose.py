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


# --------------------------------------------------------------------------- join match
# A generated clip that continues another often opens at a slightly different exposure or colour balance, which then
# drifts back over its first half second; one arriving on a clip can drift away just before it. Join match measures
# that offset and corrects it with a per-channel gain that is strongest at the join and decays away from it.
#
# Everything is measured in log space (where an exposure change is a constant offset) on small, area-averaged frames:
#   * the reference: where the footage on the other side of the join is heading at the join - its value at the join
#     frame plus a robust trend (the median frame-to-frame change), so a shot walking into shade isn't undone;
#   * the new clip at the join, the same way from its own side;
#   * the noise: how much the reference side wobbles around its own trend (a robust spread of its frame steps).
# An offset larger than JM_NOISE_K times the noise (and JM_FLOOR, and visible: JM_LEVELS) is corrected with gain exp(offset * w(d)), where d is
# the distance in frames from the join and w(d) = exp(-d / JM_TAU), cut off once below 1%. Gains are limited to
# +-JM_MAX. Small wobble in the corrected frames is smoothed toward a 3-frame median with the same decaying weight.

JM_FRAMES = 18           # frames corrected at most (w falls below 1% after ~4.6 * JM_TAU)
JM_TAU = 4.0             # decay constant, frames
JM_REF = 8               # frames used for the reference side
JM_NOISE_K = 2.5
JM_FLOOR = 0.006         # log units: ~0.6% exposure
JM_MAX = 0.08            # gains within 0.92 .. 1.08
JM_LEVELS = 0.75         # smallest difference worth correcting, in 8-bit levels


def _log_means(path, start, count, fps, size=(96, 54)):
    w, h = size
    args = [M.ffmpeg_path(), "-v", "error", "-ss", f"{max(0.0, start):.4f}", "-i", path, "-an",
            "-vf", f"fps={fps},scale={w}:{h}:flags=area,format=rgb24", "-frames:v", str(count), "-f", "rawvideo", "-"]
    raw = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **M.popen_kwargs()).stdout
    n = len(raw) // (w * h * 3)
    rgb = np.frombuffer(raw[:n * w * h * 3], np.uint8).reshape(n, h, w, 3).astype(np.float64)
    return np.log(rgb.mean(axis=(1, 2)) / 255.0 + 1e-3)


def _value_at_edge(series, at_end, beyond=0):
    """A (frames, 3) log series' value at its edge frame (at_end: its last, else its first), or `beyond` frames past
    that edge along its robust trend (the median frame-to-frame change). The median of the three edge frames stands in
    for the frame one in from the edge, which keeps a single odd frame from deciding the result."""
    steps = np.diff(series, axis=0)
    trend = np.median(steps, axis=0) if len(steps) else np.zeros(series.shape[1])
    if at_end:
        return np.median(series[-3:], axis=0) + trend * (1 + beyond)
    return np.median(series[:3], axis=0) - trend * (1 + beyond)


def join_offset(reference, new, new_after_ref=True):
    """Per-channel log offset (reference - new) at the join, and whether it is worth correcting.
    reference/new: (frames, 3) log series, each in time order. new_after_ref: the new clip starts where the reference
    ends (an extend), else it ends where the reference starts (a prepend). The reference is projected one frame across
    the join, onto the new clip's edge frame, and compared with that frame."""
    if len(reference) < 4 or len(new) < 4:
        return None
    if new_after_ref:
        ref_edge = _value_at_edge(reference, at_end=True, beyond=1)
        new_edge = _value_at_edge(new, at_end=False)
    else:
        ref_edge = _value_at_edge(reference, at_end=False, beyond=1)
        new_edge = _value_at_edge(new, at_end=True)
    offset = ref_edge - new_edge
    # noise: how much the reference wobbles around its own trend (a scene steadily brightening isn't noise)
    steps = np.diff(reference.mean(axis=1))
    noise = float(1.4826 * np.median(np.abs(steps - np.median(steps)))) if len(steps) else 0.0
    bar = max(JM_FLOOR, JM_NOISE_K * noise)
    # and the difference must be visible: at least JM_LEVELS of 255 on some channel (dark scenes are noisy in log terms)
    visible = float(np.abs(np.exp(ref_edge) - np.exp(new_edge)).max()) * 255 >= JM_LEVELS
    return {"offset": offset, "noise": noise, "bar": bar, "correct": bool(np.abs(offset).max() > bar and visible)}


def join_gains(m, new, new_after_ref=True):
    """(frames, 3) multiplicative gains for the new clip's frames nearest the join (its first frames when it follows
    the reference, its last when it precedes it), or None when the join needs nothing."""
    if not m or not m["correct"]:
        return None
    n = min(len(new), JM_FRAMES)
    frames = new[:n] if new_after_ref else new[-n:]
    distance = np.arange(n, dtype=np.float64) if new_after_ref else np.arange(n - 1, -1, -1, dtype=np.float64)
    weight = np.exp(-distance / JM_TAU)
    weight[weight < 0.01] = 0.0
    log_gain = np.clip(m["offset"][None, :] * weight[:, None], -JM_MAX, JM_MAX)
    # settle wobble: pull each corrected frame toward the median of itself and its neighbours, by the same weight
    padded = np.concatenate([frames[:1], frames, frames[-1:]])
    smooth = np.median(np.stack([padded[:-2], padded[1:-1], padded[2:]]), axis=0)
    log_gain += np.clip((smooth - frames) * weight[:, None], -JM_MAX, JM_MAX)
    return np.exp(np.clip(log_gain, -JM_MAX, JM_MAX))


def join_match(path_a, end_a, path_b, start_b, fps, correct="b"):
    """Join-match gains for the join from clip A (ending at end_a seconds of its file) into clip B (starting at
    start_b). correct="b" corrects B's opening (B continues A); "a" corrects A's closing (A runs into B).
    Returns {"src0", "fps", "gains", "offset", "noise"}: src0 is the source time of the first corrected frame; gains is
    None when the join needs nothing."""
    span = max(JM_FRAMES, JM_REF)
    a = _log_means(path_a, end_a - span / fps, span, fps)
    b = _log_means(path_b, start_b, span, fps)
    if correct == "b":
        m = join_offset(a[-JM_REF:], b, new_after_ref=True)
        gains, src0 = join_gains(m, b, new_after_ref=True), start_b
    else:
        m = join_offset(b[:JM_REF], a, new_after_ref=False)
        gains = join_gains(m, a, new_after_ref=False)
        src0 = end_a - (len(gains) if gains is not None else 0) / fps
    info = {"src0": round(src0, 6), "fps": fps, "gains": None if gains is None else np.round(gains, 5).tolist()}
    if m:
        # reported as an exposure-style percentage on the average of the channels
        info.update({"offset": round(float(np.expm1(m["offset"].mean())) * 100, 2), "noise": round(float(np.expm1(m["noise"])) * 100, 2)})
    return info
