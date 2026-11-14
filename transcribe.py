"""Speech to captions: transcribe stretches of the timeline's sound with WanGP's own Whisper (the model set in
Configuration > Extensions, the one Deepy and the dialogue models use), with word times.

Each stretch is a part of one source file (a clip's in..out); the words come back in that file's seconds and the
editor places them on the timeline and groups them into captions. Results are cached per file, stretch, model and
language, so redoing captions after an edit is quick.
"""
import hashlib
import json
import os
import subprocess
import uuid

from . import media as M


def _engine():
    """WanGP's transcription helpers, or None (with why) outside WanGP or on an older WanGP."""
    try:
        from shared.deepy import transcription as T                  # WanGP's own (shared/deepy/transcription.py)
        return T, None
    except Exception as error:                                     # noqa: BLE001
        return None, f"WanGP's Whisper isn't available here ({error.__class__.__name__}: {error}). Update WanGP: speech transcription uses the Whisper model WanGP ships for Deepy."


def available():
    engine, why = _engine()
    return {"ok": engine is not None, "why": why}


def _key(path, a, b, model, language):
    st = os.stat(path)
    raw = json.dumps([os.path.abspath(path), st.st_size, int(st.st_mtime), round(a, 3), round(b, 3), model or "", language or ""])
    return hashlib.sha1(raw.encode()).hexdigest()[:20]


def _extract(path, a, b, out):
    args = [M.ffmpeg_path(), "-hide_banner", "-v", "error", "-y", "-ss", f"{max(0.0, a):.4f}", "-t", f"{max(0.05, b - a):.4f}",
            "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out]
    result = subprocess.run(args, capture_output=True, text=True, timeout=900)
    if result.returncode != 0 or not os.path.isfile(out):
        raise RuntimeError(f"Couldn't read the sound of {os.path.basename(path)}: {(result.stderr or '').strip()[-300:]}")


def transcribe(ranges, cache_dir, temp_dir, *, model=None, language=None, progress=lambda f, m: None, cancelled=lambda: False):
    """ranges: [{key, path, a, b}] (source seconds). Returns {key: {"words": [{w, s, e}], "language"}} in source seconds."""
    engine, why = _engine()
    if engine is None:
        raise RuntimeError(why)
    os.makedirs(cache_dir, exist_ok=True)
    os.makedirs(temp_dir, exist_ok=True)
    out, todo = {}, []
    for r in ranges:
        k = _key(r["path"], r["a"], r["b"], model, language)
        f = os.path.join(cache_dir, f"{k}.json")
        if os.path.isfile(f):
            try:
                with open(f, encoding="utf-8") as handle:
                    out[r["key"]] = json.load(handle)
                continue
            except (OSError, ValueError):
                pass
        todo.append((r, f))
    if not todo:
        return out
    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    name = model or engine.whisper_model_name()
    progress(0.02, f"Loading Whisper {name}")
    whisper_model = engine.load_whisper(name, torch.device(device))

    def stop_if_cancelled():
        if cancelled():
            raise RuntimeError("Cancelled")
    try:
        for i, (r, f) in enumerate(todo):
            if cancelled():
                raise RuntimeError("Cancelled")
            progress(0.05 + 0.9 * i / len(todo), f"Transcribing {i + 1} of {len(todo)}: {os.path.basename(r['path'])}")
            wav = os.path.join(temp_dir, f"speech_{uuid.uuid4().hex[:10]}.wav")
            try:
                _extract(r["path"], r["a"], r["b"], wav)
                result = engine.transcribe_media(wav, timestamp_type="word", device=device, model_name=name, language=language or None,
                                                 prepared_model=[whisper_model], check_cancelled=stop_if_cancelled)
            finally:
                try:
                    os.remove(wav)
                except OSError:
                    pass
            words = []
            for seg in result.get("segments") or []:
                seg_words = seg.get("words") or []
                if not seg_words and seg.get("text") and seg.get("start") is not None:   # no word times: the segment as one
                    seg_words = [{"word": seg["text"], "start": seg["start"], "end": seg["end"]}]
                for w in seg_words:
                    text = str(w.get("word") or "")
                    if not text.strip() or w.get("start") is None or w.get("end") is None:
                        continue
                    words.append({"w": text, "s": round(r["a"] + float(w["start"]), 3), "e": round(r["a"] + float(w["end"]), 3)})
            entry = {"words": words, "language": result.get("language") or ""}
            with open(f, "w", encoding="utf-8") as handle:
                json.dump(entry, handle)
            out[r["key"]] = entry
    finally:
        del whisper_model
        try:
            if device == "cuda":
                torch.cuda.empty_cache()
        except Exception:                                          # noqa: BLE001
            pass
    progress(1.0, "Done")
    return out
