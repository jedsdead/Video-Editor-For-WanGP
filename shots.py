"""Shot detection: per-frame cut scores from the picture, and the shot list a WanGP prompt asked for.

The browser picks cuts from the scores with the user's sensitivity, and snaps prompt cuts to the nearest picture cut."""

import json
import os
import subprocess

import numpy as np

from . import media as M
from .regen import parse_prompt

THUMB_W, THUMB_H = 96, 54
SCORES_VERSION = 1


def _histograms(frames):
    """Per-channel 16-bin histograms, normalised (n, 48)."""
    q = (frames >> 4).reshape(len(frames), -1, 3)
    out = np.zeros((len(frames), 48), np.float32)
    for c in range(3):
        for i in range(len(frames)):
            out[i, c * 16:(c + 1) * 16] = np.bincount(q[i, :, c], minlength=16)
    return out / (THUMB_W * THUMB_H)


def cut_scores(path, fps, duration, cancel=None):
    """Score 0..1 for each frame against the previous one (frame 0 scores 0). High peaks are cuts."""
    args = [M.ffmpeg_path(), "-v", "error", "-i", path, "-an", "-vf", f"scale={THUMB_W}:{THUMB_H}:flags=area,format=rgb24",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **M.popen_kwargs())
    size = THUMB_W * THUMB_H * 3
    scores = []
    prev_frame = prev_hist = None
    try:
        while True:
            block = proc.stdout.read(size * 64)
            if not block:
                break
            count = len(block) // size
            frames = np.frombuffer(block[: count * size], np.uint8).reshape(count, THUMB_H, THUMB_W, 3)
            hists = _histograms(frames)
            for i in range(count):
                frame = frames[i].astype(np.int16)
                if prev_frame is None:
                    scores.append(0.0)
                else:
                    hist_diff = 0.5 * float(np.abs(hists[i] - prev_hist).sum()) / 3.0
                    pixel_diff = float(np.abs(frame - prev_frame).mean()) / 255.0
                    scores.append(round(min(1.0, 0.6 * hist_diff + 1.6 * pixel_diff), 4))
                prev_frame, prev_hist = frame, hists[i]
            if cancel and cancel():
                break
    finally:
        proc.stdout.close()
        proc.kill()
        proc.wait()
    return scores


# --------------------------------------------------------------------------- prompt shot lists



def prompt_shots(meta, fps):
    """Shots requested by a WanGP prompt written as sliding windows ([/duration=..]) with [Shot N] lines, optionally
    timed with 'At mm:ss.sss'. Returns (shots, cuts): shots carry their source start time and text; cuts are the source
    times where a new shot begins with a camera cut (shot 1 of a later window continues the previous one)."""
    prompt = str((meta or {}).get("prompt") or "")
    if "[Shot" not in prompt:
        return [], []
    shots, cuts = [], []
    for block in parse_prompt(prompt, fps or 24.0, float((meta or {}).get("sliding_window_overlap") or 0)):
        for s in block["shots"]:
            start = round(s["start"], 4)
            shots.append({"window": s["window"], "shot": s["shot"], "start": start, "text": f"[Shot {s['shot']}] {s['body']}"})
            if s["shot"] > 1 or (s["window"] == 1 and s["offset"] > 0):
                cuts.append({"t": start, "window": s["window"], "shot": s["shot"]})
    shots.sort(key=lambda s: s["start"])
    for i, s in enumerate(shots):
        s["end"] = shots[i + 1]["start"] if i + 1 < len(shots) else None
    return shots, cuts


def analyse(registry, media_id):
    """Cut scores (cached) plus the prompt's shot list for a media item."""
    item = registry.get(media_id)
    if not item or item["kind"] != "video":
        raise ValueError("Shot detection works on video clips")
    folder = registry.item_dir(media_id)
    cache = os.path.join(folder, "shots.json")
    fps = float(item.get("fps") or 24.0)
    data = None
    if os.path.isfile(cache):
        try:
            with open(cache, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            if data.get("version") != SCORES_VERSION:
                data = None
        except Exception:
            data = None
    if data is None:
        source = registry.proxy_path(media_id)
        data = {"version": SCORES_VERSION, "fps": fps, "scores": cut_scores(source, fps, float(item.get("duration") or 0))}
        with open(cache, "w", encoding="utf-8") as handle:
            json.dump(data, handle, separators=(",", ":"))
    meta = None
    meta_path = registry.cached_file(media_id, "metadata.json")
    if meta_path:
        try:
            with open(meta_path, "r", encoding="utf-8") as handle:
                meta = json.load(handle)
        except Exception:
            meta = None
    shots, cuts = prompt_shots(meta, fps)
    return {"fps": data["fps"], "scores": data["scores"], "duration": item.get("duration"), "shots": shots, "promptCuts": cuts}
