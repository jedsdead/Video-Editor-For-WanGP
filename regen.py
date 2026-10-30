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


_SLASH = re.compile(r"\[\s*/[^\]]*\]")


def strip_window_commands(prompt):
    """A prompt without WanGP's sliding-window commands ([/duration=...], [/loras_mult=...] ...): a final render is
    one window, and the clips' LoRAs may not be loaded."""
    return re.sub(r"\n{3,}", "\n\n", _SLASH.sub("", str(prompt or ""))).strip()


def stretch_prompt(entries, fps):
    """One prompt for a stretch of clips: the first clip's prompt around a shot list that runs through every clip,
    each clip's shots (for the part of it the timeline shows) retimed to where they fall in the stretch.
    entries: [(prompt, source_start, source_end, offset_seconds)]. Falls back to the first prompt without a shot list."""
    frame, shots, seen = None, [], set()
    for prompt, a, b, offset in entries:
        if not prompt:
            continue
        text, selected = shot_prompt(strip_window_commands(prompt), fps, a, b)
        if not selected:
            continue
        block = parse_prompt(text, fps)[0]
        if not block["shots"]:
            continue
        if frame is None:
            frame = (text[:block["shots"][0]["span"][0]], text[block["shots"][-1]["span"][1]:])
        for j, shot in enumerate(block["shots"]):
            body = _AT.sub(lambda m: f"At {fmt_time(_seconds(m) + offset)}", shot["body"].strip())
            if j == 0 and offset > 0.05:
                body = f"At {fmt_time(offset)}, " + body[:1].lower() + body[1:]
            key = re.sub(r"\s+", " ", _CAMERA_CUT.sub("", _AT.sub("", _CUT_LEAD.sub("", shot["body"])).strip())).strip().lower()
            if key in seen:
                continue     # the same shot described again (a window overlap, or a clip and its extension)
            seen.add(key)
            shots.append(body)
    if frame is None:
        first = next((p for p, *_ in entries if p), "")
        return strip_window_commands(first)
    middle = "\n".join(f"[Shot {k + 1}] {body}" for k, body in enumerate(shots))
    suffix = frame[1] if frame[1].startswith("\n") else "\n" + frame[1].lstrip(" ")
    return (frame[0] + middle + suffix).strip()


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


HANDOVER_BEFORE, HANDOVER_AFTER = 4, 5        # frames: the VAE's file-edge steps (last one / first two latents)


def masked_unavailable(settings, model_def):
    """Why a masked join can't run with these settings and model (None when it can). A masked join is a Denoise
    Control Video edit (GV) with a video mask (A): the neighbours' frames held, the rest generated."""
    model_def = model_def or {}
    choices = model_def.get("guide_custom_choices") or {}
    letters = str(choices.get("letters_filter") or "")
    values = [v for _, v in (choices.get("choices") or [])]
    if "GV" not in values and not ("G" in letters and "V" in letters):
        return "this model has no Denoise Control Video mode"
    masks = (model_def.get("mask_preprocessing") or {}).get("selection") or []
    if "A" not in masks:
        return "this model takes no video mask"
    vpt = str(settings.get("video_prompt_type") or "")
    if "V" in vpt or "U" in vpt:
        return "the settings use a reference or control video"
    if "F" in vpt:
        return "the settings inject frames"
    if "~" in vpt:
        return "phase 2 tiling is on"
    return None


def masked_task(settings, guide_path, mask_path):
    """Turn a task into the Denoise Control Video edit that holds the masked pins."""
    vpt = str(settings.get("video_prompt_type") or "")
    settings["video_prompt_type"] = "GVA" + "".join(ch for ch in vpt if ch not in "GVAN")
    settings["video_guide"] = guide_path
    settings["video_mask"] = mask_path
    settings["denoising_strength"] = 1.0
    settings["masking_strength"] = 1.0
    settings["keep_frames_video_guide"] = ""
    settings["video_guide_outpainting"] = ""
    return settings


WINDOW_JOIN_OVERLAP = 35     # frames: 17 of motion-context history + 18 held inside the next window


def write_masked_guides(folder, pins, total, fps, width, height):
    """The control video (each masked pin's frames at its place in the run, grey elsewhere) and its mask (black
    where held, white where generated), both exactly `total` frames at the run's size and frame rate."""
    import subprocess
    guide, mask = os.path.join(folder, "guide.mp4"), os.path.join(folder, "mask.mp4")
    held = sorted([p for p in pins if p["kind"] in ("masked", "both")], key=lambda p: p["place"] != "before")
    spans, inputs, filters, labels, mlabels, cursor = [], [], [], [], [], 0
    before = next((p for p in held if p["place"] == "before"), None)
    after = next((p for p in held if p["place"] == "after"), None)
    if before:
        spans.append(("pin", before))
        cursor = before["frames"]
    gap = total - cursor - (after["frames"] if after else 0)
    if gap > 0:
        spans.append(("gap", gap))
    if after:
        spans.append(("pin", after))
    for i, (kind, item) in enumerate(spans):
        if kind == "pin":
            idx = len(inputs) // 4
            inputs += ["-ss", f"{item['start_frame'] / item['fps']:.6f}", "-i", item["file"]]
            filters.append(f"[{idx}:v]fps={fps},scale={width}:{height}:flags=bicubic,format=yuv420p,trim=end_frame={item['frames']},setpts=PTS-STARTPTS[g{i}]")
            filters.append(f"color=c=black:s={width}x{height}:r={fps}:d={item['frames'] / fps + 1:.4f},format=yuv420p,trim=end_frame={item['frames']},setpts=PTS-STARTPTS[m{i}]")
        else:
            filters.append(f"color=c=0x808080:s={width}x{height}:r={fps}:d={item / fps + 1:.4f},format=yuv420p,trim=end_frame={item},setpts=PTS-STARTPTS[g{i}]")
            filters.append(f"color=c=white:s={width}x{height}:r={fps}:d={item / fps + 1:.4f},format=yuv420p,trim=end_frame={item},setpts=PTS-STARTPTS[m{i}]")
        labels.append(f"[g{i}]")
        mlabels.append(f"[m{i}]")
    n = len(spans)
    graph = ";".join(filters) + f";{''.join(labels)}concat=n={n}:v=1:a=0[gout];{''.join(mlabels)}concat=n={n}:v=1:a=0[mout]"
    ffmpeg = M.ffmpeg_path()
    common = ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-r", f"{fps}", "-frames:v", str(total)]
    run = subprocess.run([ffmpeg, "-v", "error", "-y", *inputs, "-filter_complex", graph,
                          "-map", "[gout]", "-crf", "4", *common, guide, "-map", "[mout]", "-crf", "0", *common, mask],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, **M.popen_kwargs())
    if run.returncode or not os.path.isfile(guide) or not os.path.isfile(mask):
        raise ValueError("couldn't build the masked join's control video: " + run.stderr.decode(errors="ignore")[-400:])
    return guide, mask


def apply_gen_size(task, gen):
    """The project's generation size for an editor generation: {width, height, phases, vaeX2}."""
    if not isinstance(gen, dict) or not gen.get("width") or not gen.get("height"):
        return task
    task["resolution"] = f"{int(gen['width']) // 32 * 32}x{int(gen['height']) // 32 * 32}"
    task["guidance_phases"] = 2 if int(gen.get("phases") or 1) > 1 else 1
    task["spatial_upsampling"] = "h3_vae*2" if gen.get("vaeX2") else ""
    return fit_phases(task)


# Open-H3 Regenerate 2K (WanGP's "H3 Regenerate 2K 2 Phases" preset): a phase-2-only LoRA on a fixed sigma schedule
REGEN_LORA = "open_h3_regenerate_2k_lora.safetensors"
REGEN_LORA_URL = "https://huggingface.co/DeepBeepMeep/MiniMax-H3/resolve/main/loras/" + REGEN_LORA
REGEN_SIGMAS = "; 0.909375, 0.8571428571428571, 0.6666666666666666"
REGEN_START, REGEN_STEPS = 0.909375, 3


def lora_name(lora):
    return re.split(r"[\\/]", str(lora).split("|", 1)[0])[-1].lower()


def split_loras(task):
    """(accelerators, others): the LoRAs before and after the '|' of loras_multipliers, each as [(lora, multiplier)]."""
    loras = list(task.get("activated_loras") or [])
    text = "\n".join(line.split("#", 1)[0] for line in str(task.get("loras_multipliers") or "").splitlines())
    if "|" in text:
        before, after = text.split("|", 1)
        before, after = before.split(), after.replace("|", " ").split()
    else:
        before, after = [], text.split()
    n = min(len(before), len(loras))
    acc = [(loras[i], before[i]) for i in range(n)]
    others = [(lora, after[i] if i < len(after) else "1") for i, lora in enumerate(loras[n:])]
    return acc, others


def join_loras(task, acc, others):
    task["activated_loras"] = [lora for lora, _ in acc + others]
    rest = " ".join(m for _, m in others)
    task["loras_multipliers"] = (" ".join(m for _, m in acc) + "|" + rest) if acc else rest
    return task


def has_regen_lora(settings):
    acc, others = split_loras(settings or {})
    return any(lora_name(lora) == REGEN_LORA for lora, _ in acc + others)


def fit_phases(task):
    """Keep WanGP's phase-dependent settings valid when the editor changes guidance_phases: custom_sigmas needs exactly
    one ';' slot per phase, and a LoRA multiplier can't name more phases than there are (the phase-2-only Regenerate
    LoRA is dropped on one phase)."""
    phases = max(1, int(task.get("guidance_phases") or 1))
    sigmas = str(task.get("custom_sigmas") or "")
    if sigmas.strip():
        slots = (sigmas.split(";") + [""] * phases)[:phases]
        task["custom_sigmas"] = ";".join(slots) if any(slot.strip() for slot in slots) else ""
    if task.get("activated_loras"):
        acc, others = split_loras(task)

        def fit(items):
            out = []
            for lora, mult in items:
                parts = mult.split(";")
                if len(parts) > phases:
                    if lora_name(lora) == REGEN_LORA:
                        continue
                    mult = ";".join(parts[:phases])
                out.append((lora, mult))
            return out

        fitted = fit(acc), fit(others)
        if fitted != (acc, others):
            join_loras(task, *fitted)
    return task


def set_refiner(task, refiner, settings=None):
    """A final render's phase 2: "regenerate" (Open-H3 Regenerate 2K, as WanGP's preset) or "turbo" (the automatic
    Turbo LoRA at the render's noise level and steps). Accelerators before '|' are replaced, other LoRAs stay."""
    acc, others = split_loras(task)
    acc = [(lora, m) for lora, m in acc if lora_name(lora) != REGEN_LORA]
    others = [(lora, m) for lora, m in others if lora_name(lora) != REGEN_LORA]
    if refiner == "regenerate":
        source = [lora for lora in (settings or {}).get("activated_loras") or [] if lora_name(lora) == REGEN_LORA]
        acc = [(source[0] if source else REGEN_LORA_URL, "0;1")]
        task.update(custom_sigmas=REGEN_SIGMAS, switch_threshold=REGEN_START, num_inference_steps2=REGEN_STEPS, sample_solver="euler")
    else:
        task["custom_sigmas"] = ""
    return join_loras(task, acc, others)


def write_draft_audio(path, parts, total, fps, sample_rate=48000):
    """The stretch's sound as the drafts carry it (each part's own file audio for its range, silence where a file has
    none), padded to `total` frames: a 16-bit stereo WAV. Phase 2 of a final render is conditioned on it, and it becomes
    the rendered file's soundtrack."""
    import wave
    import numpy as np
    from .h3pins import read_audio
    chunks = [read_audio(p["path"], float(p["start"]), p["frames"] / fps, sample_rate) for p in parts]
    audio = np.concatenate(chunks, 0) if chunks else np.zeros((0, 2), np.float32)
    want = int(round(total / fps * sample_rate))
    if len(audio) < want:
        audio = np.concatenate([audio, np.zeros((want - len(audio), 2), np.float32)], 0)
    pcm = (np.clip(audio[:want], -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())
    return path


def write_draft(path, parts, total, fps, width, height):
    """A stretch's drafts as the timeline plays them (each clip's source range, back to back), at width x height and
    fps, held on its last frame to `total` frames: the picture the final render refines."""
    import subprocess
    inputs, filters, labels = [], [], []
    for i, part in enumerate(parts):
        inputs += ["-ss", f"{part['start']:.6f}", "-i", part["path"]]
        filters.append(f"[{i}:v]fps={fps},scale={width}:{height}:flags=bicubic,format=yuv420p,trim=end_frame={part['frames']},setpts=PTS-STARTPTS[v{i}]")
        labels.append(f"[v{i}]")
    pad = max(0, total - sum(p["frames"] for p in parts))
    graph = ";".join(filters) + f";{''.join(labels)}concat=n={len(parts)}:v=1:a=0,tpad=stop_mode=clone:stop={pad}[out]"
    run = subprocess.run([M.ffmpeg_path(), "-v", "error", "-y", *inputs, "-filter_complex", graph, "-map", "[out]",
                          "-c:v", "libx264", "-preset", "veryfast", "-crf", "6", "-pix_fmt", "yuv420p", "-r", f"{fps}",
                          "-frames:v", str(total), path], stdout=subprocess.PIPE, stderr=subprocess.PIPE, **M.popen_kwargs())
    if run.returncode or not os.path.isfile(path):
        raise ValueError("couldn't build the stretch's draft video: " + run.stderr.decode(errors="ignore")[-400:])
    return path


def capabilities(model_def):
    """What a model supports for regeneration."""
    model_def = model_def or {}
    images = str(model_def.get("image_prompt_types_allowed", "") or "")
    audio_sources = ((model_def.get("audio_prompt_type_sources") or {}).get("selection")) or []
    return {"start": "S" in images, "end": "E" in images, "extend": "V" in images and bool(model_def.get("video_continuation", True)),
            "keepAudio": "AS" in audio_sources, "fps": float(model_def.get("fps", 16) or 16),
            "framesMinimum": int(model_def.get("frames_minimum", 5) or 5), "framesSteps": int(model_def.get("frames_steps", 4) or 4)}


GUIDE_LETTERS = "VGUFAN+*-1"   # video_prompt_type letters that need a control/reference video or a mask


def base_settings(settings):
    out = {k: copy.deepcopy(v) for k, v in (settings or {}).items() if k not in META_ONLY and k not in MEDIA_KEYS}
    # the original's control video and mask don't carry over (an editor join's guide.mp4 and mask.mp4, say), so neither
    # do the letters that ask for them: WanGP would refuse the task ("You must provide a Control Video")
    vpt = str(out.get("video_prompt_type") or "")
    if any(ch in vpt for ch in GUIDE_LETTERS):
        out["video_prompt_type"] = "".join(ch for ch in vpt if ch not in GUIDE_LETTERS)
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
    # Discard Last Frames only matters between sliding windows (Latent Carry's seamless joins use it there). A run that
    # fits in one window would just lose its last frames, so it keeps them.
    window = int(settings.get("sliding_window_size") or 0)
    if not video_source and (not window or frames <= window):
        settings["sliding_window_discard_last_frames"] = 0
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
        from .h3pins import open_store
        self.latents = open_store(data_root)     # the editor's sidecars, plus Latent Carry's when it is installed
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
                service._collect_partials(job_id)
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

        fit_phases(task)
        try:
            handle = self.host.submit(task, Callbacks(), plugin_data) if plugin_data else self.host.submit(task, Callbacks())
            self.handles[job_id] = handle
            result = handle.result()
            self._collect_partials(job_id)
            if getattr(result, "cancelled", False) or self.jobs.get(job_id, {}).get("status") == "cancelled":
                self._update(job_id, status="cancelled", message="Cancelled")
                return
            files = [f for f in (getattr(result, "generated_files", None) or []) if os.path.isfile(f)]
            if not getattr(result, "success", False) or not files:
                errors = getattr(result, "errors", None) or []
                message = "; ".join(str(getattr(e, "message", e)) for e in errors) or "WanGP produced no video"
                self._update(job_id, status="error", error=message, message=message)
                return
            videos = [f for f in files if os.path.splitext(f)[1].lower() in (".mp4", ".mkv", ".mov", ".webm")]
            video = videos[0] if videos else files[0]
            if len(videos) > 1 or (self.jobs.get(job_id) or {}).get("live"):
                # a sliding-window run can report an interim file (the first window's, with the Sliding Window Clips
                # plugin) besides the finished one: take the longest, the joined last window's file included
                live = ((self.jobs.get(job_id) or {}).get("live") or {}).get("path")
                candidates = videos + ([live] if live and os.path.isfile(live) else [])
                video = max(candidates, key=lambda f: float(M.probe(f).get("duration") or 0))
            draft_audio = (plugin_data or {}).get("video_editor", {}).get("draft_audio")
            if draft_audio and os.path.isfile(draft_audio):
                # a final render's own soundtrack is a placeholder (the refine only redraws the picture): give the file
                # the drafts' sound, keeping its picture and WanGP's settings untouched
                self._swap_audio(video, draft_audio)
            item = self.registry.register(video)
            ends = (self.jobs.get(job_id) or {}).get("windowEnds") or []
            if len(ends) > 1:
                # where WanGP's windows met, as it saved them: exact cut points for "one clip per window"
                self._save_window_cuts(item, ends[:-1])
            self._update(job_id, status="done", progress=1.0, message="Done", media=self.registry.public(item))
        except Exception as error:
            self._update(job_id, status="error", error=str(error), message=str(error))
        finally:
            self.handles.pop(job_id, None)

    def _collect_partials(self, job_id):
        """The windows a sliding-window run has finished so far, as one file the timeline can show: WanGP saves the
        whole video after each window (or, with the Sliding Window Clips plugin, each window on its own, which are
        joined here without re-encoding)."""
        try:
            from .h3pins import partials
            paths = partials(job_id)
        except Exception:
            return
        job = self.jobs.get(job_id)
        if job is None or len(paths) <= int(job.get("partialCount") or 0):
            return
        try:
            folder = os.path.join(self.root, job_id)
            live = job.get("live") or None
            ends = list(job.get("windowEnds") or [])     # where each window ended, in seconds of the growing video
            for path in paths[int(job.get("partialCount") or 0):]:
                duration = float(M.probe(path).get("duration") or 0)
                if live and duration < float(live["duration"]) + 0.25:
                    # only the newest window: append it to what was shown
                    joined = os.path.join(folder, f"live_{len(paths):02d}.mp4")
                    listing = os.path.join(folder, "live.txt")
                    with open(listing, "w", encoding="utf-8") as handle:
                        for part in (live["path"], path):
                            handle.write("file '" + part.replace("\\", "/").replace("'", "'\\''") + "'\n")
                    run = subprocess.run([M.ffmpeg_path(), "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listing, "-c", "copy", joined],
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, **M.popen_kwargs())
                    if run.returncode or not os.path.isfile(joined):
                        continue
                    path, duration = joined, float(M.probe(joined).get("duration") or 0)
                live = {"path": path, "duration": duration}
                ends.append(duration)
            if not live:
                return
            item = self.registry.register(live["path"])
            self._update(job_id, partialCount=len(paths), live=live, liveMedia=self.registry.public(item), liveWindows=len(paths),
                         windowEnds=ends)
        except Exception as error:
            print(f"[Video Editor] live windows: {error}")

    @staticmethod
    def _swap_audio(video, audio):
        tmp = video + ".sound" + os.path.splitext(video)[1]
        run = subprocess.run([M.ffmpeg_path(), "-v", "error", "-y", "-i", video, "-i", audio, "-map", "0:v", "-map", "1:a",
                              "-map_metadata", "0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", tmp],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, **M.popen_kwargs())
        if run.returncode == 0 and os.path.isfile(tmp) and os.path.getsize(tmp) > 0:
            os.replace(tmp, video)
        elif os.path.isfile(tmp):
            os.remove(tmp)

    # ---- timeline generations: extend / prepend / bridge / fill / loop
    def _sha(self, item):
        path = item["path"]
        st = os.stat(path)
        key = (path, st.st_mtime, st.st_size)
        if key not in self._sha_cache:
            from .h3pins import sha256_file
            self._sha_cache[key] = sha256_file(path)
        return self._sha_cache[key]

    def _pin(self, side, place, window, gen_fps, kind="pinned", size=None):
        """Plan one pin from {mediaId, cut (seconds in its file)}: which frames, at what grade, and how far the cut moves."""
        item = self._item(side["mediaId"])
        src_fps = float(item.get("fps") or gen_fps)
        file_frames = int(round(float(item.get("duration") or 0) * src_fps))
        cut = int(round(float(side["cut"]) * src_fps))
        # A file's last latent step (and first two) decode slightly differently from the same latents mid-file: the
        # VAE has nothing after (or before) them. A cut right at the file's edge would join on those frames, so pull it
        # off the edge and let the new footage cover them, as Latent Carry's Discard Last Frames 4 does between
        # windows. Masked joins do this inside the held window instead; "keep my exact cuts" leaves the cut alone.
        edge = 0
        if kind in ("motion", "pinned") and not side.get("pixel"):
            if place == "before" and cut > file_frames - HANDOVER_BEFORE:
                edge, cut = cut - (file_frames - HANDOVER_BEFORE), file_frames - HANDOVER_BEFORE
            elif place == "after" and cut < HANDOVER_AFTER:
                edge, cut = HANDOVER_AFTER - cut, HANDOVER_AFTER
        available = cut if place == "before" else max(0, file_frames - cut)
        motion = kind == "motion" and place == "before"
        kind = "pinned" if kind == "motion" and not motion else kind
        fit = C.motion_window if motion else C.fit_window
        room = int(available * gen_fps / src_fps)
        frames = int(size) if size and int(size) <= room else fit(int(window), room)
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
        if aligned["grade"] == "latent" and aligned.get("source") == "latent_carry":
            aligned["reason"] = "saved by Latent Carry"
        if side.get("pixel") and aligned["grade"] == "latent" and aligned["shift"]:
            aligned = {"start": cut - frames if place == "before" else cut, "cut": cut, "grade": "pixel", "shift": 0, "reason": "kept your cut"}
        if aligned["grade"] != "latent" and abs(src_fps - gen_fps) >= 1e-3:
            aligned["reason"] = f"the clip is {src_fps:g} fps; pins are re-encoded at {gen_fps:g} fps"
        if edge:
            note = f"cut kept {edge} frame{'s' if edge > 1 else ''} off the file's {'end' if place == 'before' else 'start'} (the VAE's edge frames)"
            aligned["reason"] = f"{aligned['reason']}; {note}" if aligned["reason"] else note
            aligned["shift"] = int(aligned["shift"]) + edge
        return {"place": place, "mediaId": item["id"], "file": item["path"], "fps": src_fps, "frames": frames,
                "start_frame": int(aligned["start"]), "cut_frame": int(aligned["cut"]), "cut": aligned["cut"] / src_fps,
                "shift": int(aligned["shift"]), "grade": aligned["grade"], "reason": aligned["reason"],
                "sha": sha if aligned["grade"] == "latent" else None, "audio": bool(side.get("audio", True)),
                "kind": kind,
                # frames of this pin that are part of the generated run (and trimmed off it)
                "inRun": 1 if motion else frames}

    def _motion_masked_pins(self, side, window, gen_fps):
        """Leaving a clip with motion context and a masked hold together: the neighbour's tail split in two, the
        earlier 17k frames as H3 history (clean, before the run: the motion carries on) and the last 22 frames held
        inside the run by the denoise mask (the cut falls inside one rendering: seamless). Planned as one block, so
        latent grade lines both parts up on the saved grid. Falls back to a plain masked hold when the clip is short."""
        k = max(1, (int(window) - 5) // C.GRID)
        held_frames = C.PIN_WINDOWS[0]
        block = None
        while k >= 1:
            try:
                block = self._pin(side, "before", held_frames + k * C.GRID, gen_fps, kind="both", size=held_frames + k * C.GRID)
            except ValueError:
                block = None
            if block and block["frames"] == held_frames + k * C.GRID:
                break
            k -= 1
            block = None
        if block is None:
            held = self._pin(side, "before", window, gen_fps, kind="both")
            held["reason"] = "too little of the clip before the cut for motion context too; masked only" + (f"; {held['reason']}" if held["reason"] else "")
            return [held]
        history_frames = k * C.GRID
        history = {**block, "kind": "history", "frames": history_frames, "inRun": 0,
                   "reason": f"{history_frames} frames of motion context before the held frames"}
        held = {**block, "frames": block["frames"] - history_frames, "start_frame": block["start_frame"] + history_frames,
                "inRun": block["frames"] - history_frames}
        return [history, held]

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
        # base_settings: without the source's own control video, mask and their letters (a clip made by a masked join
        # carries GVA, which would otherwise read as "uses a control video" and turn the next join's mask off)
        settings = base_settings(self._settings_for(source, bool(req.get("useCurrent")) or source is None))
        settings, refmods = relink_refmods(settings)
        model_type = settings.get("model_type")
        model_def = self.host.model_def(model_type) or {}
        caps = capabilities(model_def)
        gen_fps = caps["fps"]
        window = int(req.get("window") or 22)
        pins = []
        # how each side joins: motion context (leaving only), masked (held inside the run by a denoise mask),
        # both (masked + keyframe rows) or pinned (keyframe rows only, re-rendered and trimmed)
        masked_problem = masked_unavailable(settings, model_def)
        leave_mode = req.get("leaveMode") or ("pinned" if req.get("pinMode") == "pinned" else "motion_masked")
        arrive_mode = req.get("arriveMode") or "both"
        if leave_mode not in ("motion", "masked", "both", "pinned", "motion_masked"):
            leave_mode = "motion_masked"
        if arrive_mode not in ("masked", "both", "pinned"):
            arrive_mode = "both"
        fallback = {}
        for name in ("leave_mode", "arrive_mode"):
            if locals()[name] in ("masked", "both", "motion_masked") and masked_problem:
                fallback[name] = masked_problem
        leave_mode = ("motion" if leave_mode == "motion_masked" else "pinned") if "leave_mode" in fallback else leave_mode
        arrive_mode = "pinned" if "arrive_mode" in fallback else arrive_mode
        if not fresh:
            if req.get("left") and mode in ("extend", "bridge", "fill", "loop", "replace"):
                if leave_mode == "motion_masked":
                    pins.extend(self._motion_masked_pins(req["left"], window, gen_fps))
                else:
                    pins.append(self._pin(req["left"], "before", window, gen_fps, kind=leave_mode))
            if req.get("right") and mode in ("prepend", "bridge", "fill", "loop", "replace"):
                pins.append(self._pin(req["right"], "after", window, gen_fps, kind=arrive_mode))
            if not pins:
                raise ValueError("Nothing to pin: this needs a clip on the side it continues from")
            for p in pins:
                why = fallback.get("leave_mode" if p["place"] == "before" else "arrive_mode")
                if why:
                    p["reason"] = (f"{'motion context only' if p['kind'] == 'motion' else 'pinned inside the run'}: masked isn't available ({why})"
                                   + (f"; {p['reason']}" if p["reason"] else ""))
                elif p["kind"] in ("masked", "both") and p["grade"] == "latent":
                    # hand over one latent step inside the held window, where both files decode the same latents
                    # mid-file (H3's VAE draws a file's first two and last step slightly differently)
                    n = HANDOVER_BEFORE if p["place"] == "before" else HANDOVER_AFTER
                    p["handover"] = n
                    p["cut_frame"] += -n if p["place"] == "before" else n
                    p["cut"] = p["cut_frame"] / p["fps"]
                    p["trim"] = p["frames"] - n
        before = sum(p["inRun"] for p in pins if p["place"] == "before")
        after = sum(p["inRun"] for p in pins if p["place"] == "after")
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
            step_note = "H3 runs in steps of 17 frames, so the new part is the nearest legal length."
            window = self._window_frames(settings, model_def)
            if window and lengths["total"] > window:
                # longer than one window: WanGP's sliding windows run it, with the join in the first window. Arriving
                # on a clip would need the pins in the last window, so that stays within one.
                if after:
                    raise ValueError(f"that's {lengths['total']} frames in one run; arriving on a clip has to fit one window ({window} frames, {window / gen_fps:.1f}s) including the pins")
                if before + C.GRID > window:
                    raise ValueError(f"the window ({window} frames) is too short for the pinned frames")
                step_note += f" Longer than one {window / gen_fps:.1f}s window, so WanGP runs it in sliding windows; the join is in the first."
        sliding = self._window_plan(settings, model_def, lengths["total"])
        if fresh:
            prompt, shots = str(settings.get("prompt") or meta.get("prompt") or ""), []
        else:
            a, b = sorted(float(x) for x in (req.get("promptRange") or [0, 0]))
            prompt_fps = caps["fps"] if not str(meta.get("force_fps") or "").strip().isdigit() else float(meta["force_fps"])
            prompt, shots = shot_prompt(meta.get("prompt") or settings.get("prompt") or "", prompt_fps, a, b, meta.get("sliding_window_overlap") or 0) if b > a else (meta.get("prompt") or "", [])
        info = {"mode": mode, "model": {"type": model_type, "name": self.host.model_name(model_type)}, "capabilities": caps,
                "fps": gen_fps, "pins": pins, "lengths": {**lengths, "newSeconds": lengths["new"] / gen_fps, "totalSeconds": lengths["total"] / gen_fps,
                                                          "trimHead": sum(p.get("trim", p["inRun"]) for p in pins if p["place"] == "before") / gen_fps,
                                                          "trimTail": sum(p.get("trim", p["inRun"]) for p in pins if p["place"] == "after") / gen_fps,
                                                          "note": step_note},
                "windows": sliding["count"], "windowFrames": sliding["window"],
                "originalSeed": meta.get("seed"), "prompt": prompt, "shots": shots, "refmods": refmods,
                "available": ok, "reason": reason, "h3": self.host.h3_status() if hasattr(self.host, "h3_status") else {"installed": False}}
        return info, settings, model_def

    def _window_frames(self, settings, model_def):
        """The sliding-window size a run uses: as build_task does, a run that fits the model's longest window runs in one,
        and a longer one runs in windows of that size (floored to H3's frame grid, as WanGP does)."""
        window_max = int(((model_def or {}).get("sliding_window_defaults") or {}).get("window_max") or 0)
        size = window_max or int(settings.get("sliding_window_size") or 0)
        if size >= 5:
            size = 5 + (size - 5) // C.GRID * C.GRID
        return size

    def _window_plan(self, settings, model_def, total):
        """How many sliding windows WanGP will run for `total` frames."""
        window = self._window_frames(settings, model_def)
        if not window or total <= window:
            return {"count": 1, "window": window or total}
        overlap = int(settings.get("sliding_window_overlap") or 1)
        discard = int(settings.get("sliding_window_discard_last_frames") or 0)
        step = max(1, window - overlap - discard)
        return {"count": 1 + math.ceil(max(0, total - (window - discard)) / step), "window": window}

    def _save_window_cuts(self, item, seconds):
        try:
            with open(os.path.join(self.registry.item_dir(item["id"]), "windows.json"), "w", encoding="utf-8") as handle:
                json.dump({"cuts": [round(float(t), 6) for t in seconds]}, handle)
        except Exception as error:
            print(f"[Video Editor] could not keep the window cuts: {error}")

    def window_cuts(self, media_id):
        """Where a generation's sliding windows meet, in seconds of its file: from the windows the add-on saved latents
        for (exact), else from the file's WanGP settings (window size, overlap and discarded frames)."""
        item = self._item(media_id)
        fps = float(item.get("fps") or 24)
        file_frames = int(round(float(item.get("duration") or 0) * fps))
        cuts, source = [], None
        try:
            with open(os.path.join(self.registry.item_dir(item["id"]), "windows.json"), encoding="utf-8") as handle:
                saved = [float(t) for t in json.load(handle).get("cuts") or []]
            if saved:
                frames = sorted({int(round(t * fps)) for t in saved if 0 < t * fps < file_frames})
                return {"cuts": [f / fps for f in frames], "frames": frames, "windows": len(frames) + 1, "source": "run"}
        except (OSError, ValueError):
            pass
        try:
            manifest = self.latents.manifest(self._sha(item)) or {}
        except Exception:
            manifest = {}
        windows = sorted((w for w in manifest.get("windows") or [] if w.get("source") != "latent_carry"), key=lambda w: int(w["offset"]))
        if len(windows) > 1:
            cuts = [int(w["offset"]) + int(w["valid"]) for w in windows[:-1]]
            source = "latents"
            # a window whose match stops early (its overlap frames differ from the file) gives a cut that isn't one:
            # windows are seconds long, so cuts closer than a second are not to be trusted
            if any(b - a < fps for a, b in zip([0] + cuts, cuts + [file_frames])):
                cuts, source = [], None
        if not cuts:
            meta = self._meta(item) or {}
            window = int(meta.get("sliding_window_size") or 0)
            if window and file_frames > window:
                overlap = int(meta.get("sliding_window_overlap") or 1)
                discard = int(meta.get("sliding_window_discard_last_frames") or 0)
                at, step = window - discard, max(1, window - overlap - discard)
                while at < file_frames - 2:
                    cuts.append(at)
                    at += step
                source = "settings"
        cuts = sorted({c for c in cuts if 2 <= c <= file_frames - 2})
        return {"cuts": [c / fps for c in cuts], "frames": cuts, "windows": len(cuts) + 1, "source": source}

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
        apply_gen_size(task, req.get("gen"))
        # sliding windows: the length needs several, or you asked for them (a prompt's own [/duration=...] windows
        # set the real length); never for a run that arrives on a clip, whose pins must be in its only window
        sliding = (info.get("windows", 1) > 1 or bool(req.get("sliding"))) and not any(p["place"] == "after" for p in info["pins"])
        if info["pins"] and sliding:
            task["sliding_window_size"] = info["windowFrames"]   # sliding windows: the pins are in window 1
        elif info["pins"]:
            task["sliding_window_size"] = max(int(task.get("sliding_window_size") or 0), lengths["total"])   # one window: pins only apply to window 1
            # and nothing discarded in a single window: Discard Last Frames would cut the end of the run, where an
            # arriving pin sits, and shift every trim after it (between sliding windows it is Latent Carry's business)
            task["sliding_window_discard_last_frames"] = 0
        spec = {"pins": [{k: p[k] for k in ("place", "file", "fps", "frames", "start_frame", "sha", "audio", "kind")} for p in info["pins"]],
                "mode": info["mode"]}
        # Between WanGP's own sliding windows: each window takes the previous one's tail as motion-context history
        # and holds its last frames inside the run with the denoise mask, so a window's seam falls inside one
        # rendering (as a Motion + masked join). Needs the run to be a masked edit throughout, an overlap with room
        # for both parts, and the windows' last frames (the VAE's edge) discarded.
        window_join = sliding and req.get("windowJoin", True) and not masked_unavailable(settings, model_def)
        if sliding and not int(task.get("sliding_window_size") or 0):
            task["sliding_window_size"] = info["windowFrames"]      # the window size the plan assumed
        if window_join:
            spec["windowJoin"] = "motion_masked"
            overlap = int(task.get("sliding_window_overlap") or 0)
            task["sliding_window_overlap"] = max(WINDOW_JOIN_OVERLAP, 1 + max(0, overlap - 1) // C.GRID * C.GRID)
            if int(task.get("sliding_window_discard_last_frames") or 0) < 4:
                task["sliding_window_discard_last_frames"] = 4
        job_id = uuid.uuid4().hex[:12]
        folder = os.path.join(self.root, job_id)
        os.makedirs(folder, exist_ok=True)
        # the add-on copies each window's interim file here, so the timeline can show the run as it goes
        spec.update(jobId=job_id, partialDir=folder)
        if any(p["kind"] in ("masked", "both") for p in info["pins"]) or window_join:
            try:
                width, height = (int(v) for v in str(task.get("resolution") or "").lower().split("x"))
            except ValueError:
                raise ValueError("the settings have no resolution for the masked join's control video")
            guide, mask = write_masked_guides(folder, info["pins"], lengths["total"], info["fps"], width, height)
            masked_task(task, guide, mask)
        with open(os.path.join(folder, "task.json"), "w", encoding="utf-8") as handle:
            json.dump({"settings": task, "plugin_data": {"video_editor": spec}}, handle, indent=1, default=str)
        job = {"id": job_id, "status": "queued", "progress": 0.0, "message": "Queued in WanGP…", "created": time.time(),
               "project": req.get("project"), "kind": "compose", "mode": info["mode"], "seed": seed,
               "clipId": req.get("clipId"), "trackId": req.get("trackId"), "place": req.get("place"),
               "left": {**(req.get("left") or {}), "cut": next((p["cut"] for p in info["pins"] if p["place"] == "before" and p["kind"] != "history"), None)} if req.get("left") else None,
               "right": {**(req.get("right") or {}), "cut": next((p["cut"] for p in info["pins"] if p["place"] == "after"), None)} if req.get("right") else None,
               "pins": [{**{k: p[k] for k in ("place", "grade", "frames", "shift", "reason", "kind")}, "handover": p.get("handover", 0)} for p in info["pins"]],
               "trimHead": lengths["trimHead"], "trimTail": lengths["trimTail"], "newSeconds": lengths["newSeconds"],
               "prompt": prompt, "model": info["model"]["name"], "audio": "new", "media": None, "error": None,
               "request": {k: v for k, v in req.items() if k not in ("prompt",)}}
        with self.lock:
            self.jobs[job_id] = job
            self._save()
        threading.Thread(target=self._run, args=(job_id, task, {"video_editor": spec}), daemon=True, name=f"video_editor_gen_{job_id}").start()
        return job

    # ---- final render: the drafts of a stretch refined as one piece, at twice the size (and the VAE's x2 on decode)
    def _render_plan(self, req):
        clips = req.get("clips") or []
        if not clips:
            raise ValueError("Nothing to render")
        first = self._item(req.get("settingsFrom") or clips[0]["mediaId"])
        meta = self._meta(first) or {}
        if not meta.get("model_type"):
            raise ValueError("The stretch's first clip has no WanGP settings to render with")
        settings, refmods = relink_refmods(dict(meta))
        model_def = self.host.model_def(settings.get("model_type")) or {}
        if "minimax_h3" not in str(settings.get("model_type") or ""):
            raise ValueError("Final renders need a MiniMax H3 model")
        caps = capabilities(model_def)
        fps = caps["fps"]
        frames = 0
        parts = []
        pins = []

        def context(side):
            # the neighbouring final's frames at the join: rendered again and held to what that final shows, so the
            # new render continues out of it (or into it) instead of meeting it at a cut
            nonlocal frames
            ctx = req.get(side)
            if not ctx:
                return
            item = self._item(ctx["mediaId"])
            a, b = sorted((float(ctx["in"]), float(ctx["out"])))
            n = int(round((b - a) * fps))
            if n < 9:
                return
            parts.append({"clipId": None, "context": side, "path": item["path"], "start": a, "frames": n, "offset": frames,
                          "prompt": "", "end": b})
            pins.append({"frame0": frames, "frame1": frames + n, "side": side})
            frames += n

        context("contextBefore")
        for c in clips:
            item = self._item(c["mediaId"])
            a, b = sorted((float(c["in"]), float(c["out"])))
            n = int(round((b - a) * fps))
            if n <= 0:
                continue
            parts.append({"clipId": c.get("clipId"), "path": item["path"], "start": a, "frames": n, "offset": frames,
                          "prompt": (self._meta(item) or {}).get("prompt") or "", "end": b})
            frames += n
        if not any(p["clipId"] is not None for p in parts):
            raise ValueError("The stretch is too short to render")
        context("contextAfter")
        total = C.legal_total(frames, minimum=caps["framesMinimum"])
        width, height = (int(v) for v in req.get("size") or (0, 0))
        if width < 64 or height < 64:
            raise ValueError("Choose the final size")
        width, height = width // 32 * 32, height // 32 * 32
        regen_ok = model_def.get("custom_sigmas", True) is not False
        refiner = req.get("refiner") or ("regenerate" if has_regen_lora(settings) else "turbo")
        refiner = "regenerate" if refiner == "regenerate" and regen_ok else "turbo"
        strength = float(req.get("strength") if req.get("strength") is not None else (meta.get("switch_threshold") or 0.6))
        steps2 = int(req.get("steps") or meta.get("num_inference_steps2") or 3)
        if has_regen_lora(settings) and refiner == "turbo" and req.get("strength") is None:
            strength = 0.9035   # the clip's start belongs to the Regenerate schedule; WanGP's Original 2 Phases start
        if refiner == "regenerate":
            strength, steps2 = REGEN_START, REGEN_STEPS
        prompt = strip_window_commands(req.get("prompt")) or stretch_prompt(
            [(p["prompt"], p["start"], p["end"], p["offset"] / fps) for p in parts if p["clipId"] is not None], fps)
        window = max(3.0, float(req.get("window") or 10.0))
        return {"settings": settings, "model_def": model_def, "fps": fps, "parts": parts, "frames": frames, "total": total, "pins": pins,
                "window": window, "overlap": max(1.0, min(window / 3, float(req.get("overlap") or 2.0))),
                "width": width, "height": height, "strength": max(0.05, min(1.0, strength)), "steps": max(1, steps2),
                "vae_x2": bool(req.get("vaeX2")), "prompt": prompt, "refmods": refmods, "meta": meta,
                "refiner": refiner, "regen_ok": regen_ok}

    def render_prepare(self, req):
        plan = self._render_plan(req)
        meta = plan["meta"]
        ok, reason = self.host.available()
        return {"available": ok, "reason": reason, "frames": plan["frames"], "total": plan["total"], "fps": plan["fps"],
                "context": [p["side"] for p in plan["pins"]],
                "windows": max(1, math.ceil((plan["total"] / plan["fps"] - plan["overlap"]) / (plan["window"] - plan["overlap"]))),
                "seconds": plan["frames"] / plan["fps"], "size": [plan["width"], plan["height"]],
                "phase1": [max(32, round(plan["height"] / 2 / 32) * 32), max(32, round(plan["width"] / 2 / 32) * 32)][::-1],
                "output": [plan["width"] * (2 if plan["vae_x2"] else 1), plan["height"] * (2 if plan["vae_x2"] else 1)],
                "strength": plan["strength"], "steps": plan["steps"], "prompt": plan["prompt"], "refmods": plan["refmods"],
                "model": self.host.model_name(plan["settings"].get("model_type")),
                "refiner": plan["refiner"], "regenAvailable": plan["regen_ok"],
                "loras": [l for l in meta.get("activated_loras") or [] if lora_name(l) != REGEN_LORA], "h3": self.host.h3_status() if hasattr(self.host, "h3_status") else {"installed": False}}

    def render_submit(self, req):
        plan = self._render_plan(req)
        ok, reason = self.host.available()
        if not ok:
            raise ValueError(reason)
        if not (self.host.h3_status() if hasattr(self.host, "h3_status") else {}).get("installed"):
            raise ValueError("The editor's H3 add-on isn't active in WanGP, so final renders can't run")
        seed = req.get("seed")
        if seed in (None, "", "new") or int(seed) < 0:
            seed = random.randint(0, 2 ** 31 - 1)
        seed = int(seed)
        job_id = uuid.uuid4().hex[:12]
        folder = os.path.join(self.root, job_id)
        os.makedirs(folder, exist_ok=True)
        # the stretch as the timeline shows it, at the first phase's size: what phase 2 will refine
        p1w, p1h = max(32, round(plan["width"] / 2 / 32) * 32), max(32, round(plan["height"] / 2 / 32) * 32)
        draft = os.path.join(folder, "draft.mp4")
        write_draft(draft, plan["parts"], plan["total"], plan["fps"], p1w, p1h)
        task = build_task(plan["settings"], prompt=plan["prompt"], seed=seed, frames=plan["total"], fps=plan["fps"], model_def=plan["model_def"])
        task.update({"resolution": f"{plan['width']}x{plan['height']}", "guidance_phases": 2, "num_inference_steps": 1,
                     "switch_threshold": plan["strength"], "num_inference_steps2": plan["steps"],
                     "spatial_upsampling": "h3_vae*2" if plan["vae_x2"] else "",
                     "sliding_window_size": plan["total"], "sliding_window_discard_last_frames": 0,
                     "image_prompt_type": "",
                     # step skipping (Spectrum, first-block cache) expects every step to run the model in one piece; the
                     # render skips phase 1's throwaway pass and runs phase 2 in windows, and phase 2 is only a few steps
                     "skip_steps_cache_type": ""})
        vpt = str(task.get("video_prompt_type") or "")
        task["video_prompt_type"] = "".join(ch for ch in vpt if ch not in "VGUFAN+*-1~")
        if not req.get("keepLoras"):
            # the drafts already carry the action and style; the refine only redraws detail. RefMods (custom settings)
            # and references stay; WanGP's phase-2 Turbo is automatic, and plugin settings such as its multiplier stay.
            task["activated_loras"] = []
            task["loras_multipliers"] = ""
        set_refiner(task, plan["refiner"], plan["settings"])
        fit_phases(task)
        draft_audio = os.path.join(folder, "draft.wav")
        try:
            write_draft_audio(draft_audio, plan["parts"], plan["total"], plan["fps"])
        except Exception:
            draft_audio = None
        spec = {"mode": "render", "draft": draft, "draft_audio": draft_audio, "frames": plan["frames"], "size": [plan["width"], plan["height"]],
                "window_seconds": plan["window"], "overlap_seconds": plan["overlap"], "pins": [], "holds": plan["pins"],
                "refiner": plan["refiner"]}
        if plan["pins"]:
            # the same stretch at the refine size, for encoding the held frames at full detail
            spec["pinvideo"] = os.path.join(folder, "pins.mp4")
            write_draft(spec["pinvideo"], plan["parts"], plan["total"], plan["fps"], plan["width"], plan["height"])
        with open(os.path.join(folder, "task.json"), "w", encoding="utf-8") as handle:
            json.dump({"settings": task, "plugin_data": {"video_editor": spec}}, handle, indent=1, default=str)
        job = {"id": job_id, "status": "queued", "progress": 0.0, "message": "Queued in WanGP…", "created": time.time(),
               "project": req.get("project"), "kind": "render", "seed": seed, "mode": "render",
               "parts": [{"clipId": p["clipId"], "offset": p["offset"], "frames": p["frames"]} for p in plan["parts"] if p["clipId"] is not None],
               "fps": plan["fps"], "frames": plan["frames"], "strength": plan["strength"],
               "size": [plan["width"], plan["height"]], "vaeX2": plan["vae_x2"], "draftSig": req.get("draftSig"),
               "prompt": plan["prompt"], "model": self.host.model_name(plan["settings"].get("model_type")), "media": None, "error": None,
               "request": {k: v for k, v in req.items() if k not in ("prompt",)}}
        with self.lock:
            self.jobs[job_id] = job
            self._save()
        threading.Thread(target=self._run, args=(job_id, task, {"video_editor": spec}), daemon=True, name=f"video_editor_render_{job_id}").start()
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

    def join_match(self, req):
        """Join-match gains for a join; req: {a: {mediaId, end}, b: {mediaId, start}, correct: "a" | "b"}."""
        a, b = self._item(req["a"]["mediaId"]), self._item(req["b"]["mediaId"])
        fps = float((a if req.get("correct") == "a" else b).get("fps") or 24)
        return C.join_match(a["path"], float(req["a"]["end"]), b["path"], float(req["b"]["start"]), fps,
                            correct="a" if req.get("correct") == "a" else "b")

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
