"""Export engine. Video is composited frame by frame with torch (GPU when available) using the same formulas as the
WebGL preview; audio is mixed with numpy; ffmpeg decodes the sources and encodes the result."""

import math
import os
import subprocess
import tempfile
import threading
import time
import wave

import numpy as np

from . import media as M
from . import timeline_math as T

CODECS = {
    "h264": {"label": "H.264 (MP4)", "ext": ".mp4", "video": ["-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p"], "crf": True, "audio": ["-c:a", "aac", "-b:a", "192k"]},
    "h265": {"label": "H.265 (MP4)", "ext": ".mp4", "video": ["-c:v", "libx265", "-preset", "medium", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"], "crf": True, "audio": ["-c:a", "aac", "-b:a", "192k"]},
    "h264_nvenc": {"label": "H.264 NVENC (MP4, fast)", "ext": ".mp4", "video": ["-c:v", "h264_nvenc", "-preset", "p5", "-pix_fmt", "yuv420p"], "cq": True, "audio": ["-c:a", "aac", "-b:a", "192k"]},
    "prores": {"label": "ProRes 422 HQ (MOV)", "ext": ".mov", "video": ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"], "audio": ["-c:a", "pcm_s16le"]},
}
SAMPLE_RATE = 48000


class Cancelled(Exception):
    pass


# --------------------------------------------------------------------------- helpers

def even(value):
    return max(2, int(round(value / 2.0)) * 2)


def fit_size(src_w, src_h, canvas_w, canvas_h, scale=1.0):
    factor = min(canvas_w / max(1, src_w), canvas_h / max(1, src_h)) * max(0.01, scale)
    return even(src_w * factor), even(src_h * factor)


class Timeline:
    """Read-only view of a project with lookups the renderer needs."""

    def __init__(self, project, registry):
        self.project = project
        self.registry = registry
        settings = project.get("settings", {})
        self.width = even(settings.get("width") or 1280)
        self.height = even(settings.get("height") or 720)
        self.fps = float(settings.get("fps") or 24)
        self.media = {}
        for clip in project.get("clips", []):
            item = registry.get(clip["mediaId"]) or (project.get("media") or {}).get(clip["mediaId"])
            if item is None:
                raise RuntimeError(f"Media for clip '{clip.get('name', clip['id'])}' is not available")
            if not os.path.isfile(item.get("path", "")):
                raise RuntimeError(f"Missing file: {item.get('path')}")
            self.media[clip["mediaId"]] = item
        self.tracks = {track["id"]: track for track in project.get("tracks", [])}
        self.video_tracks = [t for t in project.get("tracks", []) if t["kind"] == "video"]
        self.audio_tracks = [t for t in project.get("tracks", []) if t["kind"] == "audio"]
        self.clips = {clip["id"]: clip for clip in project.get("clips", [])}
        self.durations = {cid: T.clip_duration(c, self.kind(c)) for cid, c in self.clips.items()}
        self.transitions = []
        for tr in project.get("transitions", []):
            tr = T.normalize_transition(tr)
            a, b = self.clips.get(tr.get("a")), self.clips.get(tr.get("b"))
            if a is None or b is None or a["trackId"] != b["trackId"]:
                continue
            cut = float(a["start"]) + self.durations[a["id"]]
            if abs(cut - float(b["start"])) > 0.5 / self.fps:
                continue
            duration = max(1.0 / self.fps, float(tr.get("duration") or 1.0))
            self.transitions.append({**tr, "cut": cut, "duration": duration, "trackId": a["trackId"]})

    def kind(self, clip):
        return (self.media.get(clip["mediaId"]) or {}).get("kind")

    def clip_window(self, clip):
        """Time span a clip is rendered, including transition handles."""
        start = float(clip["start"])
        end = start + self.durations[clip["id"]]
        for tr in self.transitions:
            if tr["a"] == clip["id"]:
                end = max(end, tr["cut"] + tr["duration"] / 2)
            if tr["b"] == clip["id"]:
                start = min(start, tr["cut"] - tr["duration"] / 2)
        return start, end

    def end_time(self):
        end = 0.0
        for clip in self.clips.values():
            end = max(end, float(clip["start"]) + self.durations[clip["id"]])
        return end


# --------------------------------------------------------------------------- video sources

class VideoReader:
    """Sequential ffmpeg decoder for one clip at its on-canvas size, with re-seek on jumps."""

    def __init__(self, path, src_fps, width, height, duration):
        self.path, self.width, self.height = path, width, height
        self.fps = src_fps if src_fps and src_fps > 0 else 24.0
        self.dt = 1.0 / self.fps
        self.duration = duration
        self.proc = None
        self.frame_bytes = width * height * 3
        self.base, self.index, self.eof = 0.0, -1, False
        self.cur = self.nxt = None

    def _open(self, at):
        self.close()
        at = max(0.0, min(at, max(0.0, self.duration - self.dt)))
        vf = f"scale={self.width}:{self.height}:flags=lanczos,format=rgb24"
        args = [M.ffmpeg_path(), "-v", "error", "-ss", f"{at:.4f}", "-i", self.path, "-an", "-vf", vf,
                "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        self.proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=self.frame_bytes * 2, **M.popen_kwargs())
        self.base = at
        self.index = -1
        self.cur = self.nxt = None
        self.eof = False
        self.cur = self._read()
        self.nxt = self._read()

    def _read(self):
        if self.eof or self.proc is None:
            return None
        buf = bytearray()
        while len(buf) < self.frame_bytes:
            chunk = self.proc.stdout.read(self.frame_bytes - len(buf))
            if not chunk:
                self.eof = True
                return None
            buf.extend(chunk)
        self.index += 1
        return np.frombuffer(buf, dtype=np.uint8).reshape(self.height, self.width, 3)

    def _time(self, index):
        return self.base + index * self.dt

    def get(self, src):
        """(frame0, frame1, weight) bracketing source time src; frame1 is None when holding."""
        src = max(0.0, src)
        if self.proc is None:
            self._open(src)
        elif src < self._time(self.index - 1) - self.dt * 0.5 or (src > self._time(self.index) + 2.0 and not self.eof):
            self._open(src)
        while self.nxt is not None and self._time(self.index) <= src + 1e-6:
            self.cur, self.nxt = self.nxt, self._read()
        if self.cur is None:
            return None, None, 0.0
        cur_time = self._time(self.index - 1) if self.nxt is not None else self._time(self.index)
        if self.nxt is None:
            return self.cur, None, 0.0
        weight = min(1.0, max(0.0, (src - cur_time) / self.dt))
        return self.cur, self.nxt, weight

    def close(self):
        if self.proc is not None:
            try:
                self.proc.stdout.close()
            except Exception:
                pass
            try:
                self.proc.kill()
                self.proc.wait(timeout=5)
            except Exception:
                pass
        self.proc = None


class StillSource:
    def __init__(self, path, width, height):
        from PIL import Image
        with Image.open(path) as img:
            img = img.convert("RGBA").resize((width, height), Image.LANCZOS)
            self.frame = np.asarray(img).copy()

    def get(self, _src):
        return self.frame, None, 0.0

    def close(self):
        pass


class RifeInterpolator:
    """Optical-flow in-betweens with WanGP's RIFE v4.26 model."""

    def __init__(self, device):
        from shared.utils.files_locator import locate_file
        path = locate_file("rife4.26.pkl", error_if_none=False)
        if not path:
            raise RuntimeError("RIFE model rife4.26.pkl not found (it downloads the first time you use RIFE Temporal Upsampling in WanGP)")
        from postprocessing.rife.RIFE_V4 import Model
        self.model = Model()
        self.model.load_model(path, -1, device=device)
        self.model.eval()
        self.device = device

    def __call__(self, img0, img1, t):
        import torch
        import torch.nn.functional as F
        _, h, w = img0.shape
        pad = (0, (-w) % self.model.pad_mod, 0, (-h) % self.model.pad_mod)
        with torch.inference_mode():
            a = F.pad(img0.unsqueeze(0), pad)
            b = F.pad(img1.unsqueeze(0), pad)
            out = self.model.inference(a, b, timestep=float(t))
        return out[0, :, :h, :w].clamp(0, 1)


# --------------------------------------------------------------------------- torch compositing

class Compositor:
    def __init__(self, width, height, device):
        import torch
        self.torch = torch
        self.width, self.height, self.device = width, height, device
        ys = (torch.arange(height, device=device, dtype=torch.float32) + 0.5) / height
        xs = (torch.arange(width, device=device, dtype=torch.float32) + 0.5) / width
        self.Y, self.X = torch.meshgrid(ys, xs, indexing="ij")
        aspect = width / height
        self.D = torch.sqrt(((self.X - 0.5) * aspect) ** 2 + (self.Y - 0.5) ** 2) / math.sqrt((aspect * 0.5) ** 2 + 0.25)
        self.luma = torch.tensor([0.2126, 0.7152, 0.0722], device=device).view(3, 1, 1)

    def to_tensor(self, frame):
        return self.torch.from_numpy(frame).to(self.device).permute(2, 0, 1).float().div_(255.0)

    def grade(self, img, params):
        if params is None:
            return img
        torch = self.torch
        v = lambda values: torch.tensor(values, device=self.device, dtype=torch.float32).view(3, 1, 1)
        c = img * (params["exposure"]) * v(params["wb"])
        c = c * v(params["gain"]) + v(params["lift"]) * (1.0 - c)
        c = torch.clamp(c, min=0.0) ** (1.0 / v(params["gamma"]))
        c = (c - 0.5) * params["contrast"] + 0.5
        luma = (c * self.luma).sum(0, keepdim=True)
        c = luma + (c - luma) * params["saturation"]
        return c.clamp(0.0, 1.0)

    def layer(self, img, x, y, alpha):
        """Place an image on a transparent canvas; returns premultiplied RGBA (4, H, W)."""
        torch = self.torch
        out = torch.zeros(4, self.height, self.width, device=self.device)
        _, h, w = img.shape
        left = int(round(self.width / 2 + x - w / 2))
        top = int(round(self.height / 2 + y - h / 2))
        x0, y0 = max(0, left), max(0, top)
        x1, y1 = min(self.width, left + w), min(self.height, top + h)
        if x1 <= x0 or y1 <= y0 or alpha <= 0:
            return out
        crop = img[:, y0 - top:y1 - top, x0 - left:x1 - left]
        if crop.shape[0] == 4:
            a = crop[3:4] * alpha
            out[:3, y0:y1, x0:x1] = crop[:3] * a
            out[3:4, y0:y1, x0:x1] = a
        else:
            out[:3, y0:y1, x0:x1] = crop * alpha
            out[3, y0:y1, x0:x1] = alpha
        return out

    def shift(self, layer, dx):
        dx = int(round(dx))
        if dx == 0:
            return layer
        out = self.torch.zeros_like(layer)
        if abs(dx) >= self.width:
            return out
        if dx > 0:
            out[:, :, dx:] = layer[:, :, :-dx]
        else:
            out[:, :, :dx] = layer[:, :, -dx:]
        return out

    @staticmethod
    def _smooth(e0, e1, x):
        t = ((x - e0) / (e1 - e0)).clamp(0, 1)
        return t * t * (3 - 2 * t)

    def sample(self, layer, qx, qy, clamp_edges=False):
        """Nearest-neighbour sample of a layer at image coordinates (0..1, y down); zero outside unless clamped."""
        torch = self.torch
        ix = (qx * self.width - 0.5).round().long() if hasattr(qx, "long") else (qx * self.width - 0.5).round().astype(int)
        iy = (qy * self.height - 0.5).round().long() if hasattr(qy, "long") else (qy * self.height - 0.5).round().astype(int)
        cx, cy = ix.clamp(0, self.width - 1), iy.clamp(0, self.height - 1)
        out = layer[:, cy, cx]
        if not clamp_edges:
            inside = ((qx >= 0) & (qx <= 1) & (qy >= 0) & (qy <= 1)).float().unsqueeze(0)
            out = out * inside
        return out

    def transition(self, tr, a, b, p):
        """Composite outgoing layer a and incoming layer b at progress p (0..1). Same maths as TRANSITION_GLSL."""
        torch = self.torch
        kind = tr["type"]
        prm = tr.get("params") or {}
        aa = 0.0015
        sm = self._smooth
        if kind == "dissolve":
            style = prm.get("style", "cross")
            if style == "film":
                la, lb = a[:3].clamp(min=0) ** 2.2, b[:3].clamp(min=0) ** 2.2
                rgb = (la * (1 - p) + lb * p).clamp(min=0) ** (1 / 2.2)
                return torch.cat([rgb, a[3:4] * (1 - p) + b[3:4] * p], 0)
            if style == "additive":
                return (a * min(1.0, 2 * (1 - p)) + b * min(1.0, 2 * p)).clamp(max=1.0)
            if style == "nonadditive":
                return torch.maximum(a * min(1.0, 2 * (1 - p)), b * min(1.0, 2 * p))
            if style == "dip":
                solid = torch.zeros_like(a)
                for i, v in enumerate(T.hex_to_rgb(prm.get("color", "#000000"))):
                    solid[i] = v
                solid[3] = 1.0
                return a * (1 - 2 * p) + solid * (2 * p) if p < 0.5 else solid * (2 - 2 * p) + b * (2 * p - 1)
            return a * (1 - p) + b * p

        feather = bool(tr.get("feather"))
        border = min(T.MAX_BORDER, max(0.0, float(tr.get("border") or 0)))
        bcol = T.hex_to_rgb(tr.get("borderColor"))
        s = max(border * 0.5, aa) if feather else aa
        bw = 0.0 if feather else border
        pad = s + bw * 0.5
        inc = -pad + p * (1 + 2 * pad)
        dec = (1 + pad) - p * (1 + 2 * pad)
        ang = math.radians(float(prm.get("angle") or 0))
        dx, dy = math.cos(ang), -math.sin(ang)
        aspect = self.width / self.height
        x, y = self.X - 0.5, self.Y - 0.5
        X, Y = x * aspect, y

        def solid_border():
            out = torch.zeros_like(a)
            for i in range(3):
                out[i] = bcol[i]
            out[3] = 1.0
            return out

        if kind == "slide":
            L = 1.0 / max(abs(dx), abs(dy))
            tx, ty = dx * L, dy * L
            pad_s = 2 * s + bw
            qx, qy = self.X + (1 - p) * tx * (1 + pad_s), self.Y + (1 - p) * ty * (1 + pad_s)
            e = 1e-3
            big = -1e9
            ox = qx - 1 if dx > e else (-qx if dx < -e else qx * 0 + big)
            oy = qy - 1 if dy > e else (-qy if dy < -e else qy * 0 + big)
            outd = torch.maximum(ox, oy)
            in_x = (qx >= 0) if dx > e else ((qx <= 1) if dx < -e else ((qx >= 0) & (qx <= 1)))
            in_y = (qy >= 0) if dy > e else ((qy <= 1) if dy < -e else ((qy >= 0) & (qy <= 1)))
            inside = (in_x & in_y).float()
            alpha_b = inside * torch.where(outd <= 0, outd * 0 + 1, 1 - sm(0.0, 2 * s, outd))
            base = a
            if prm.get("push"):
                base = self.sample(a, self.X - p * tx * (1 + pad_s), self.Y - p * ty * (1 + pad_s))
            bs = self.sample(b, qx.clamp(0, 1), qy.clamp(0, 1), clamp_edges=True) * alpha_b.unsqueeze(0)
            out = bs + base * (1 - bs[3:4])
            if bw > 0:
                bm = (inside * sm(-aa, aa, outd) * (1 - sm(bw - aa, bw + aa, outd))).unsqueeze(0)
                out = out * (1 - bm) + solid_border() * bm
            return out

        dir_r = 0.5 * aspect * abs(dx) + 0.5 * abs(dy)
        proj = X * dx + Y * dy
        reverse = bool(prm.get("reverse"))
        if kind == "wipe":
            v, e, keep_b_below = proj / (2 * dir_r) + 0.5, inc, True
        elif kind == "blinds":
            w = (proj / (2 * dir_r) + 0.5) * max(1, int(round(float(prm.get("count") or 8))))
            v, e, keep_b_below = w - torch.floor(w), inc, True
        elif kind == "clock":
            v = torch.atan2(X, -Y) / (2 * math.pi)
            v = torch.where(v < 0, v + 1, v)
            if reverse:
                v = 1 - v
            e, keep_b_below = inc, True
        else:
            if kind == "barn":
                v = proj.abs() / dir_r
            else:
                shape = prm.get("shape", "circle")
                ax, ay = x.abs(), y.abs()
                if shape == "oval":
                    v = torch.sqrt(x * x + y * y) / math.sqrt(0.5)
                elif shape == "diamond":
                    v = ax + ay
                elif shape == "square":
                    v = 2 * torch.maximum(ax, ay)
                elif shape == "cross":
                    v = 2 * torch.minimum(ax, ay)
                elif shape == "x":
                    v = torch.minimum((x + y).abs(), (x - y).abs()) / 0.5
                elif shape == "triangle":
                    v = torch.maximum(ax * 0.8660254 + y * 0.5, -y) / 0.6830127
                else:
                    v = torch.sqrt(X * X + Y * Y) / math.sqrt((aspect * 0.5) ** 2 + 0.25)
            e, keep_b_below = (dec, False) if reverse else (inc, True)
        m = sm(e - s, e + s, v)
        if keep_b_below:
            m = 1 - m
        m = m.unsqueeze(0)
        out = a * (1 - m) + b * m
        if bw > 0:
            bm = (1 - sm(bw / 2 - aa, bw / 2 + aa, (v - e).abs())).unsqueeze(0)
            out = out * (1 - bm) + solid_border() * bm
        return out


# --------------------------------------------------------------------------- export job

class ExportJob:
    def __init__(self, job_id, project, options, registry, out_path, temp_dir):
        self.id = job_id
        self.project = project
        self.options = options
        self.registry = registry
        self.out_path = out_path
        self.temp_dir = temp_dir
        self.status = "queued"
        self.progress = 0.0
        self.message = "Waiting..."
        self.error = None
        self.warnings = []
        self.cancel_event = threading.Event()
        self.started = time.time()
        self.finished = None

    def public(self):
        return {"id": self.id, "status": self.status, "progress": round(self.progress, 4), "message": self.message,
                "error": self.error, "warnings": self.warnings, "output": self.out_path if self.status == "done" else None,
                "name": os.path.basename(self.out_path), "elapsed": round((self.finished or time.time()) - self.started, 1)}

    def check(self):
        if self.cancel_event.is_set():
            raise Cancelled()

    def run(self):
        self.status = "running"
        try:
            self._run()
            self.status = "done"
            self.progress = 1.0
            self.message = "Export finished"
        except Cancelled:
            self.status = "cancelled"
            self.message = "Export cancelled"
            self._remove(self.out_path)
        except Exception as error:
            import traceback
            traceback.print_exc()
            self.status = "error"
            self.error = str(error)
            self.message = "Export failed"
            self._remove(self.out_path)
        finally:
            self.finished = time.time()

    @staticmethod
    def _remove(path):
        try:
            if path and os.path.isfile(path):
                os.remove(path)
        except Exception:
            pass

    # ----------------------------------------------------------------- main
    def _run(self):
        tl = Timeline(self.project, self.registry)
        opts = self.options
        if opts.get("width") and opts.get("height"):
            tl.width, tl.height = even(opts["width"]), even(opts["height"])
        if opts.get("fps"):
            tl.fps = float(opts["fps"])
        start = max(0.0, float(opts.get("start") or 0.0))
        end = float(opts.get("end") or 0.0) or tl.end_time()
        if end - start < 1.0 / tl.fps:
            raise RuntimeError("Nothing to export: the timeline (or the selected range) is empty")
        frames = int(round((end - start) * tl.fps))
        codec = CODECS.get(opts.get("codec") or "h264", CODECS["h264"])

        has_audio = any(tl.kind(c) in ("audio", "video") and tl.tracks.get(c["trackId"], {}).get("kind") == "audio" for c in tl.clips.values())
        audio_path = None
        if has_audio:
            self.message = "Mixing audio..."
            audio_path = os.path.join(self.temp_dir, f"{self.id}_mix.wav")
            self._mix_audio(tl, start, end, audio_path)
        self.check()

        args = [M.ffmpeg_path(), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{tl.width}x{tl.height}",
                "-framerate", f"{tl.fps}", "-i", "-"]
        if audio_path:
            args += ["-i", audio_path, "-map", "0:v:0", "-map", "1:a:0"]
        args += codec["video"]
        quality = int(opts.get("quality") or 18)
        if codec.get("crf"):
            args += ["-crf", str(quality)]
        if codec.get("cq"):
            args += ["-rc", "vbr", "-cq", str(quality), "-b:v", "0"]
        if audio_path:
            args += codec["audio"]
        args += ["-t", f"{frames / tl.fps:.6f}", "-movflags", "+faststart", self.out_path]
        if codec["ext"] == ".mov":
            args.remove("-movflags")
            args.remove("+faststart")
        encoder = subprocess.Popen(args, stdin=subprocess.PIPE, stderr=subprocess.PIPE, **M.popen_kwargs())
        stderr_chunks = []
        reader_thread = threading.Thread(target=lambda: stderr_chunks.append(encoder.stderr.read()), daemon=True)
        reader_thread.start()
        try:
            self._render_video(tl, start, frames, encoder, opts)
            encoder.stdin.close()
            encoder.wait()
        except Exception:
            try:
                encoder.kill()
            except Exception:
                pass
            raise
        finally:
            reader_thread.join(timeout=5)
            if audio_path:
                self._remove(audio_path)
        if encoder.returncode != 0:
            message = (stderr_chunks[0] if stderr_chunks else b"").decode("utf-8", "ignore").strip()
            raise RuntimeError(f"Encoder failed: {message[-500:]}")

    # ----------------------------------------------------------------- video
    def _render_video(self, tl, start, frames, encoder, opts):
        import torch
        device = "cuda" if torch.cuda.is_available() else "cpu"
        comp = Compositor(tl.width, tl.height, device)
        default_interp = opts.get("interpolation") or "blend"
        sources = {}
        rife = {"model": None, "failed": False}
        grades = {cid: T.grade_params(c.get("grade")) for cid, c in tl.clips.items()}

        def source_for(clip):
            src = sources.get(clip["id"])
            if src is None:
                item = tl.media[clip["mediaId"]]
                w, h = fit_size(item.get("width") or tl.width, item.get("height") or tl.height, tl.width, tl.height, float(clip.get("scale") or 1))
                if item["kind"] == "image":
                    src = StillSource(item["path"], w, h)
                else:
                    src = VideoReader(item["path"], item.get("fps") or tl.fps, w, h, float(item.get("duration") or 0))
                sources[clip["id"]] = src
            return src

        def frame_for(clip, tau):
            src = source_for(clip)
            kind = tl.kind(clip)
            f0, f1, weight = src.get(T.source_time(clip, tau, kind))
            if f0 is None:
                return None
            img = comp.to_tensor(f0)
            if f1 is None or weight < 1e-3:
                return img
            mode = clip.get("interp") or "default"
            mode = default_interp if mode == "default" else mode
            if mode == "nearest":
                return comp.to_tensor(f1) if weight >= 0.5 else img
            other = comp.to_tensor(f1)
            if mode == "rife" and not rife["failed"]:
                try:
                    if rife["model"] is None:
                        self.message = "Loading RIFE optical flow..."
                        rife["model"] = RifeInterpolator(device)
                    return rife["model"](img, other, weight)
                except Exception as error:
                    rife["failed"] = True
                    self.warnings.append(f"Optical flow unavailable, used frame blending instead: {error}")
            return img * (1 - weight) + other * weight

        def clip_layer(clip, t):
            tau = t - float(clip["start"])
            img = frame_for(clip, tau)
            if img is None:
                return None
            if img.shape[0] == 4:
                img = self._cat(comp.grade(img[:3], grades[clip["id"]]), img[3:4])
            else:
                img = comp.grade(img, grades[clip["id"]])
            duration = tl.durations[clip["id"]]
            alpha = float(clip.get("opacity") if clip.get("opacity") is not None else 1.0)
            alpha *= T.fade_factor(clip, min(max(tau, 0.0), duration), duration)
            return comp.layer(img, float(clip.get("x") or 0) * tl.width / max(1, self._project_w(tl)),
                              float(clip.get("y") or 0) * tl.height / max(1, self._project_h(tl)), alpha)

        track_clips = {t["id"]: sorted([c for c in tl.clips.values() if c["trackId"] == t["id"]], key=lambda c: float(c["start"]))
                       for t in tl.video_tracks}
        track_transitions = {t["id"]: [tr for tr in tl.transitions if tr["trackId"] == t["id"] and tr["type"] in T.VIDEO_TRANSITIONS]
                             for t in tl.video_tracks}
        windows = {cid: tl.clip_window(c) for cid, c in tl.clips.items()}
        last_report = 0
        for index in range(frames):
            self.check()
            t = start + index / tl.fps
            canvas = torch.zeros(3, tl.height, tl.width, device=device)
            for track in tl.video_tracks:
                if track.get("hidden"):
                    continue
                active_tr = next((tr for tr in track_transitions[track["id"]]
                                  if tr["cut"] - tr["duration"] / 2 <= t < tr["cut"] + tr["duration"] / 2), None)
                if active_tr is not None:
                    a = clip_layer(tl.clips[active_tr["a"]], t)
                    b = clip_layer(tl.clips[active_tr["b"]], t)
                    if a is None or b is None:
                        layer = a if b is None else b
                    else:
                        p = (t - (active_tr["cut"] - active_tr["duration"] / 2)) / active_tr["duration"]
                        layer = comp.transition(active_tr, a, b, p)
                    layers = [layer] if layer is not None else []
                else:
                    layers = []
                    for clip in track_clips[track["id"]]:
                        s = float(clip["start"])
                        if s <= t < s + tl.durations[clip["id"]]:
                            layer = clip_layer(clip, t)
                            if layer is not None:
                                layers.append(layer)
                for layer in layers:
                    canvas = layer[:3] + canvas * (1 - layer[3:4])
            frame = canvas.clamp(0, 1).mul(255).round().to(torch.uint8).permute(1, 2, 0).contiguous().cpu().numpy()
            try:
                encoder.stdin.write(frame.tobytes())
            except (BrokenPipeError, OSError):
                raise RuntimeError("The encoder stopped unexpectedly")
            # free readers whose clips are finished
            for cid in list(sources):
                if windows[cid][1] < t - 1.0:
                    sources.pop(cid).close()
            now = time.time()
            if now - last_report > 0.25 or index == frames - 1:
                last_report = now
                self.progress = 0.05 + 0.95 * (index + 1) / frames
                rate = (index + 1) / max(1e-3, now - self.started)
                self.message = f"Rendering frame {index + 1}/{frames} ({rate:.1f} fps)"
        for src in sources.values():
            src.close()

    @staticmethod
    def _cat(rgb, alpha):
        import torch
        return torch.cat([rgb, alpha], 0)

    def _project_w(self, tl):
        return (self.project.get("settings") or {}).get("width") or tl.width

    def _project_h(self, tl):
        return (self.project.get("settings") or {}).get("height") or tl.height

    # ----------------------------------------------------------------- audio
    def _decode_audio(self, path, src_start, src_end, tempo=1.0):
        """Stereo float32 samples (2, n) of [src_start, src_end) at SAMPLE_RATE, zero-padded outside the file."""
        length = src_end - src_start
        if length <= 0:
            return np.zeros((2, 0), dtype=np.float32)
        lead = max(0.0, -src_start)
        seek = max(0.0, src_start)
        filters = []
        t = tempo
        while t > 2.0:
            filters.append("atempo=2.0")
            t /= 2.0
        while t < 0.5:
            filters.append("atempo=0.5")
            t /= 0.5
        if abs(t - 1.0) > 1e-6:
            filters.append(f"atempo={t:.6f}")
        args = [M.ffmpeg_path(), "-v", "error", "-ss", f"{seek:.6f}", "-t", f"{max(0.0, length - lead):.6f}", "-i", path, "-vn"]
        if filters:
            args += ["-af", ",".join(filters)]
        args += ["-ac", "2", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"]
        proc = subprocess.run(args, capture_output=True, timeout=3600, **M.popen_kwargs())
        data = np.frombuffer(proc.stdout, dtype=np.float32)
        data = data[: (len(data) // 2) * 2].reshape(-1, 2).T
        lead_samples = int(round(lead / tempo * SAMPLE_RATE))
        if lead_samples:
            data = np.concatenate([np.zeros((2, lead_samples), dtype=np.float32), data], axis=1)
        return data

    def _mix_audio(self, tl, start, end, out_path):
        total = int(round((end - start) * SAMPLE_RATE))
        mix = np.zeros((2, total), dtype=np.float32)
        soloed = any(t.get("solo") for t in tl.audio_tracks)
        audio_transitions = [tr for tr in tl.transitions if tr["type"] in T.AUDIO_TRANSITIONS]
        clips = [c for c in tl.clips.values() if tl.tracks.get(c["trackId"], {}).get("kind") == "audio"]
        for n, track in enumerate(tl.audio_tracks):
            self.check()
            if track.get("mute") or (soloed and not track.get("solo")):
                continue
            buffer = np.zeros((2, total), dtype=np.float32)
            for clip in [c for c in clips if c["trackId"] == track["id"]]:
                item = tl.media[clip["mediaId"]]
                if not (item.get("has_audio") or item["kind"] == "audio"):
                    continue
                w0, w1 = tl.clip_window(clip)
                s, e = max(w0, start), min(w1, end)
                if e - s <= 1.0 / SAMPLE_RATE:
                    continue
                cs = float(clip["start"])
                duration = tl.durations[clip["id"]]
                i0 = int(round((s - start) * SAMPLE_RATE))
                count = min(total - i0, int(round((e - s) * SAMPLE_RATE)))
                if count <= 0:
                    continue
                s0, s1 = T.clip_speeds(clip)
                src_a, src_b = T.source_time(clip, s - cs), T.source_time(clip, e - cs)
                if abs(s1 - s0) < 1e-9:
                    seg = self._decode_audio(item["path"], src_a, src_b, tempo=s0)
                    seg = seg[:, :count]
                    if seg.shape[1] < count:
                        seg = np.pad(seg, ((0, 0), (0, count - seg.shape[1])))
                else:
                    raw = self._decode_audio(item["path"], src_a, src_b, tempo=1.0)
                    taus = (s - cs) + np.arange(count, dtype=np.float64) / SAMPLE_RATE
                    d = duration
                    src_times = np.where(taus < 0, float(clip["in"]) + s0 * taus,
                                np.where(taus > d, float(clip["out"]) + s1 * (taus - d),
                                         float(clip["in"]) + s0 * taus + (s1 - s0) * taus * taus / (2 * d)))
                    pos = (src_times - src_a) * SAMPLE_RATE
                    idx = np.arange(raw.shape[1])
                    seg = np.stack([np.interp(pos, idx, raw[ch], left=0.0, right=0.0) for ch in range(2)]).astype(np.float32) if raw.shape[1] else np.zeros((2, count), np.float32)
                taus = (s - cs) + np.arange(count, dtype=np.float64) / SAMPLE_RATE
                gain = np.full(count, T.db_to_gain(clip.get("volume")), dtype=np.float64)
                fade_in, fade_out = float(clip.get("fadeIn") or 0), float(clip.get("fadeOut") or 0)
                inside = np.clip(taus, 0, duration)
                if fade_in > 0:
                    gain *= np.clip(inside / fade_in, 0, 1)
                if fade_out > 0:
                    gain *= np.clip((duration - inside) / fade_out, 0, 1)
                for tr in audio_transitions:
                    times = s + np.arange(count) / SAMPLE_RATE
                    lo, hi = tr["cut"] - tr["duration"] / 2, tr["cut"] + tr["duration"] / 2
                    if tr["a"] == clip["id"] or tr["b"] == clip["id"]:
                        p = np.clip((times - lo) / tr["duration"], 0, 1)
                        within = (times >= lo) & (times < hi)
                        if tr["type"] == "a_linear":
                            curve = (1 - p) if tr["a"] == clip["id"] else p
                        elif tr["type"] == "a_dip":
                            curve = np.clip(1 - 2 * p, 0, 1) if tr["a"] == clip["id"] else np.clip(2 * p - 1, 0, 1)
                        else:
                            curve = np.cos(p * np.pi / 2) if tr["a"] == clip["id"] else np.sin(p * np.pi / 2)
                        gain = np.where(within, gain * curve, gain)
                buffer[:, i0:i0 + count] += seg * gain.astype(np.float32)
            buffer *= T.db_to_gain(track.get("volume"))
            pan = float(track.get("pan") or 0)
            if abs(pan) > 1e-6:
                left, right = buffer[0].copy(), buffer[1].copy()
                x = pan + 1 if pan <= 0 else pan
                gl, gr = math.cos(x * math.pi / 2), math.sin(x * math.pi / 2)
                if pan <= 0:
                    buffer[0], buffer[1] = left + right * gl, right * gr
                else:
                    buffer[0], buffer[1] = left * gl, right + left * gr
            mix += buffer
            self.progress = 0.05 * (n + 1) / max(1, len(tl.audio_tracks))
        mix *= T.db_to_gain((self.project.get("master") or {}).get("volume"))
        pcm = (np.clip(mix, -1.0, 1.0).T * 32767.0).round().astype(np.int16)
        with wave.open(out_path, "wb") as handle:
            handle.setnchannels(2)
            handle.setsampwidth(2)
            handle.setframerate(SAMPLE_RATE)
            handle.writeframes(pcm.tobytes())
