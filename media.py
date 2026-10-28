"""Media handling: probing, the media registry, preview proxies, thumbnail strips, waveforms and WanGP metadata."""

import hashlib
import json
import math
import os
import shutil
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor

VIDEO_EXT = (".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v", ".mpg", ".mpeg", ".gif")
AUDIO_EXT = (".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma")
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff")
MEDIA_EXT = VIDEO_EXT + AUDIO_EXT + IMAGE_EXT

THUMB_HEIGHT = 72
MAX_THUMBS = 60
PEAKS_PER_SECOND = 100
PROXY_HEIGHT = 540


# --------------------------------------------------------------------------- binaries

def _binary(name):
    try:
        from shared.utils.video_decode import resolve_media_binary
        path = resolve_media_binary(name)
        if path:
            return path
    except Exception:
        pass
    return shutil.which(name + (".exe" if os.name == "nt" else "")) or shutil.which(name) or name


def ffmpeg_path():
    return _binary("ffmpeg")


def ffprobe_path():
    return _binary("ffprobe")


def popen_kwargs():
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return kwargs


def run(args, timeout=600, text=True):
    return subprocess.run(args, capture_output=True, text=text, timeout=timeout, **popen_kwargs())


# --------------------------------------------------------------------------- probing

def _fraction(value):
    try:
        if isinstance(value, str) and "/" in value:
            num, den = value.split("/", 1)
            num, den = float(num), float(den)
            return num / den if den else 0.0
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def media_kind(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in IMAGE_EXT:
        return "image"
    if ext in AUDIO_EXT:
        return "audio"
    if ext in VIDEO_EXT:
        return "video"
    return None


PROBE_VERSION = 2      # 2: a video's duration is its picture stream's


def probe(path):
    result = run([ffprobe_path(), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], timeout=60)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe could not read {os.path.basename(path)}: {result.stderr.strip()[:300]}")
    data = json.loads(result.stdout or "{}")
    streams = data.get("streams", [])
    fmt = data.get("format", {})
    video = next((s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    kind = media_kind(path)
    if kind == "video" and video is None and audio is not None:
        kind = "audio"
    if kind is None:
        kind = "video" if video is not None else ("audio" if audio is not None else None)
    if kind is None:
        raise RuntimeError(f"{os.path.basename(path)} has no video or audio stream")
    duration = _fraction(fmt.get("duration")) or _fraction((video or audio or {}).get("duration"))
    info = {
        "kind": kind,
        "duration": round(duration, 4) if kind != "image" else 0,
        "has_audio": audio is not None and kind != "image",
        "width": 0, "height": 0, "fps": 0,
        "vcodec": (video or {}).get("codec_name", ""),
        "acodec": (audio or {}).get("codec_name", ""),
        "sample_rate": int((audio or {}).get("sample_rate") or 0),
        "channels": int((audio or {}).get("channels") or 0),
    }
    if video is not None:
        width, height = int(video.get("width") or 0), int(video.get("height") or 0)
        rotation = 0
        for side in video.get("side_data_list") or []:
            if "rotation" in side:
                rotation = int(abs(_fraction(side.get("rotation"))))
        if rotation in (90, 270):
            width, height = height, width
        info["width"], info["height"] = width, height
        fps = _fraction(video.get("avg_frame_rate")) or _fraction(video.get("r_frame_rate"))
        info["fps"] = round(fps, 4) if fps and fps < 1000 else 0
        # a video's length is its picture's: WanGP's outputs can carry a soundtrack a few frames longer than the frames
        # (Discard Last Frames trims the picture only), and frames past the picture's end can't be shown
        frames = int(video.get("nb_frames") or 0)
        picture = _fraction(video.get("duration")) or (frames / info["fps"] if frames and info["fps"] else 0)
        if kind == "video" and picture and (not duration or picture < duration - 1e-3):
            info["duration"] = round(picture, 4)
    info["probe"] = PROBE_VERSION
    return info


def read_wangp_metadata(path):
    """Generation settings WanGP embeds in its outputs (prompt, model, seed...), or None."""
    try:
        from shared.utils.video_metadata import read_metadata_from_video
        meta = read_metadata_from_video(path)
    except Exception:
        meta = None
    if meta is None and path.lower().endswith(".png"):
        try:
            from PIL import Image
            with Image.open(path) as img:
                raw = img.info.get("comment") or img.info.get("parameters")
            meta = json.loads(raw) if raw else None
        except Exception:
            meta = None
    return meta if isinstance(meta, dict) else None


# --------------------------------------------------------------------------- registry

class MediaRegistry:
    """Every imported file, keyed by a stable id. Files are referenced in place; derived files live in the cache."""

    def __init__(self, data_root):
        self.data_root = data_root
        self.cache_dir = os.path.join(data_root, "cache")
        self.upload_dir = os.path.join(data_root, "media")
        os.makedirs(self.cache_dir, exist_ok=True)
        os.makedirs(self.upload_dir, exist_ok=True)
        self.index_path = os.path.join(data_root, "media_index.json")
        self.lock = threading.RLock()
        self.items = {}
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="video_editor_media")
        self._load()

    def _load(self):
        try:
            with open(self.index_path, "r", encoding="utf-8") as handle:
                stored = json.load(handle)
            for item in stored.values():
                if not os.path.isfile(item.get("path", "")):
                    item["missing"] = True
                else:
                    item.pop("missing", None)
                for key in ("proxy", "thumbs", "wave"):
                    if item.get(key) == "pending":
                        item[key] = "stale"
            self.items = stored
            # older entries took a video's duration from the container (the longer of picture and sound): measure again
            remeasured = False
            for media_id, item in stored.items():
                if item.get("kind") == "video" and item.get("probe") != PROBE_VERSION and not item.get("missing"):
                    try:
                        fresh = probe(item["path"])
                        item["duration"], item["probe"] = fresh["duration"], PROBE_VERSION
                        remeasured = True
                    except Exception:
                        pass
            if remeasured:
                try:
                    self._save()
                except Exception:
                    pass
        except FileNotFoundError:
            self.items = {}
        except Exception as error:
            print(f"[Video Editor] could not read media index: {error}")
            self.items = {}

    def _save(self):
        tmp = self.index_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(self.items, handle, indent=1)
        os.replace(tmp, self.index_path)

    @staticmethod
    def make_id(path):
        stat = os.stat(path)
        key = f"{os.path.abspath(path).lower() if os.name == 'nt' else os.path.abspath(path)}|{stat.st_size}|{int(stat.st_mtime)}"
        return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]

    def item_dir(self, media_id):
        folder = os.path.join(self.cache_dir, media_id)
        os.makedirs(folder, exist_ok=True)
        return folder

    def public(self, item):
        keys = ("id", "name", "path", "kind", "duration", "has_audio", "width", "height", "fps", "vcodec", "acodec",
                "proxy", "proxy_rev", "thumbs", "wave", "thumb_count", "thumb_width", "thumb_interval", "has_metadata", "missing", "error")
        return {key: item.get(key) for key in keys if key in item}

    def get(self, media_id):
        with self.lock:
            return self.items.get(media_id)

    def register(self, path):
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
        media_id = self.make_id(path)
        with self.lock:
            existing = self.items.get(media_id)
            if existing and not existing.get("missing") and all(existing.get(k) in ("ready", "none") for k in ("proxy", "thumbs", "wave")):
                return existing
        info = probe(path)
        meta = read_wangp_metadata(path) if info["kind"] in ("video", "image") else None
        item = {"id": media_id, "name": os.path.basename(path), "path": path, **info,
                "proxy": "none", "thumbs": "none", "wave": "none", "has_metadata": bool(meta)}
        if info["kind"] == "video":
            item["proxy"] = "pending"
            item["thumbs"] = "pending"
        if info["has_audio"] or info["kind"] == "audio":
            item["wave"] = "pending"
        if info["kind"] == "audio":
            item["proxy"] = "pending"
        with self.lock:
            self.items[media_id] = item
            self._save()
        if meta:
            try:
                with open(os.path.join(self.item_dir(media_id), "metadata.json"), "w", encoding="utf-8") as handle:
                    json.dump(meta, handle, indent=1, default=str)
            except Exception as error:
                print(f"[Video Editor] could not cache metadata: {error}")
        self.pool.submit(self._process, media_id)
        return item

    def _set(self, media_id, **values):
        with self.lock:
            item = self.items.get(media_id)
            if item is not None:
                item.update(values)
                self._save()

    def _process(self, media_id):
        item = dict(self.get(media_id) or {})
        if not item:
            return
        folder = self.item_dir(media_id)
        if item.get("proxy") == "pending":
            try:
                self._make_proxy(item, folder)
                self._set(media_id, proxy="ready")
            except Exception as error:
                print(f"[Video Editor] proxy failed for {item['name']}: {error}")
                self._set(media_id, proxy="error", error=str(error)[:300])
        if item.get("thumbs") == "pending":
            try:
                count, width, interval = self._make_thumbs(item, folder)
                self._set(media_id, thumbs="ready", thumb_count=count, thumb_width=width, thumb_interval=interval)
            except Exception as error:
                print(f"[Video Editor] thumbnails failed for {item['name']}: {error}")
                self._set(media_id, thumbs="error")
        if item.get("wave") == "pending":
            try:
                self._make_wave(item, folder)
                self._set(media_id, wave="ready")
            except Exception as error:
                print(f"[Video Editor] waveform failed for {item['name']}: {error}")
                self._set(media_id, wave="error")

    def _make_proxy(self, item, folder):
        if item["kind"] == "audio":
            out = os.path.join(folder, "proxy.m4a")
            args = [ffmpeg_path(), "-y", "-v", "error", "-i", item["path"], "-vn", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", out]
        else:
            out = os.path.join(folder, "proxy.mp4")
            vf = f"scale=-2:'trunc(min({PROXY_HEIGHT},ih)/2)*2':flags=bicubic,format=yuv420p"
            args = [ffmpeg_path(), "-y", "-v", "error", "-i", item["path"], "-map", "0:v:0", "-map", "0:a:0?",
                    "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-g", "12", "-bf", "0",
                    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", out]
        tmp = out + ".part" + os.path.splitext(out)[1]
        args[-1] = tmp
        result = run(args, timeout=3600)
        if result.returncode != 0 or not os.path.isfile(tmp):
            raise RuntimeError(result.stderr.strip()[-400:])
        os.replace(tmp, out)

    def _make_thumbs(self, item, folder):
        duration = max(item.get("duration") or 0, 0.04)
        count = int(max(1, min(MAX_THUMBS, math.ceil(duration / 0.5))))
        interval = duration / count
        aspect = (item.get("width") or 16) / max(1, item.get("height") or 9)
        width = int(round(THUMB_HEIGHT * aspect / 2) * 2)
        out = os.path.join(folder, "thumbs.jpg")
        vf = f"fps={count / duration:.6f},scale={width}:{THUMB_HEIGHT},tile={count}x1"
        result = run([ffmpeg_path(), "-y", "-v", "error", "-i", item["path"], "-an", "-vf", vf, "-frames:v", "1", "-q:v", "5", out], timeout=900)
        if result.returncode != 0 or not os.path.isfile(out):
            raise RuntimeError(result.stderr.strip()[-400:])
        return count, width, interval

    def _make_wave(self, item, folder):
        import numpy as np
        rate = 8000
        proc = subprocess.run([ffmpeg_path(), "-v", "error", "-i", item["path"], "-vn", "-ac", "1", "-ar", str(rate), "-f", "s16le", "-"],
                              capture_output=True, timeout=1800, **popen_kwargs())
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.decode("utf-8", "ignore")[-400:])
        samples = np.frombuffer(proc.stdout, dtype=np.int16)
        hop = rate // PEAKS_PER_SECOND
        n = len(samples) // hop
        if n == 0:
            peaks = []
        else:
            block = np.abs(samples[: n * hop].astype(np.int32)).reshape(n, hop).max(axis=1)
            peaks = np.clip(np.round(block / 32768.0 * 255.0), 0, 255).astype(int).tolist()
        with open(os.path.join(folder, "wave.json"), "w", encoding="utf-8") as handle:
            json.dump({"rate": PEAKS_PER_SECOND, "peaks": peaks}, handle, separators=(",", ":"))

    def refresh(self, media_id):
        """Re-queue derived files that a restart interrupted."""
        with self.lock:
            item = self.items.get(media_id)
            if item is None:
                return None
            requeue = False
            for key in ("proxy", "thumbs", "wave"):
                if item.get(key) == "stale":
                    item[key] = "pending"
                    requeue = True
            if requeue:
                self._save()
        if requeue:
            self.pool.submit(self._process, media_id)
        return item

    def make_reverse(self, media_id, chunk=4.0):
        """Build a reversed preview proxy (video and audio played backwards) in short chunks, so memory stays small."""
        item = self.get(media_id)
        if not item or item["kind"] not in ("video", "audio"):
            return item
        folder = self.item_dir(media_id)
        audio_only = item["kind"] == "audio"
        out = os.path.join(folder, "proxy_rev.m4a" if audio_only else "proxy_rev.mp4")
        if item.get("proxy_rev") == "ready" and os.path.isfile(out):
            return item
        with self.lock:
            self.items[media_id]["proxy_rev"] = "pending"
        source = self.proxy_path(media_id)
        duration = max(0.04, float(item.get("duration") or 0))
        count = max(1, int(math.ceil(duration / chunk)))
        parts = []
        try:
            for i in range(count):
                start = i * chunk
                part = os.path.join(folder, f"rev_{i:04d}{'.m4a' if audio_only else '.mp4'}")
                args = [ffmpeg_path(), "-y", "-v", "error", "-ss", f"{start:.4f}", "-t", f"{min(chunk, duration - start):.4f}", "-i", source]
                if audio_only:
                    args += ["-vn", "-af", "areverse", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", part]
                else:
                    args += ["-map", "0:v:0", "-map", "0:a:0?", "-vf", "reverse,format=yuv420p", "-af", "areverse",
                             "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-g", "12", "-bf", "0",
                             "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", part]
                result = run(args, timeout=1800)
                if result.returncode != 0 or not os.path.isfile(part):
                    raise RuntimeError(result.stderr.strip()[-300:])
                parts.append(part)
            listing = os.path.join(folder, "rev_list.txt")
            with open(listing, "w", encoding="utf-8") as handle:
                for part in reversed(parts):
                    handle.write("file '" + part.replace("\\", "/").replace("'", "'\\''") + "'\n")
            tmp = out + ".part" + os.path.splitext(out)[1]
            result = run([ffmpeg_path(), "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listing, "-c", "copy", "-movflags", "+faststart", tmp], timeout=1800)
            if result.returncode != 0 or not os.path.isfile(tmp):
                raise RuntimeError(result.stderr.strip()[-300:])
            os.replace(tmp, out)
            self._set(media_id, proxy_rev="ready")
        except Exception as error:
            print(f"[Video Editor] reverse proxy failed for {item['name']}: {error}")
            self._set(media_id, proxy_rev="error")
        finally:
            for part in parts + [os.path.join(folder, "rev_list.txt")]:
                try:
                    os.remove(part)
                except OSError:
                    pass
        return self.get(media_id)

    def reverse_path(self, media_id):
        item = self.get(media_id)
        if not item or item.get("proxy_rev") != "ready":
            return None
        path = os.path.join(self.cache_dir, media_id, "proxy_rev.m4a" if item["kind"] == "audio" else "proxy_rev.mp4")
        return path if os.path.isfile(path) else None

    def proxy_path(self, media_id):
        item = self.get(media_id)
        if not item:
            return None
        if item.get("proxy") == "ready":
            name = "proxy.m4a" if item["kind"] == "audio" else "proxy.mp4"
            path = os.path.join(self.cache_dir, media_id, name)
            if os.path.isfile(path):
                return path
        return item["path"]

    def cached_file(self, media_id, name):
        path = os.path.join(self.cache_dir, media_id, name)
        return path if os.path.isfile(path) else None
