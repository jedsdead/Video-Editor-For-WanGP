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

from . import luts as L
from . import media as M
from . import timeline_math as T
from . import titles as TT
from . import fx as FX

CODECS = {
    "h264": {"label": "H.264 (MP4)", "ext": ".mp4", "video": ["-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p"], "crf": True, "audio": ["-c:a", "aac", "-b:a", "192k"]},
    "h265": {"label": "H.265 (MP4)", "ext": ".mp4", "video": ["-c:v", "libx265", "-preset", "medium", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"], "crf": True, "audio": ["-c:a", "aac", "-b:a", "192k"]},
    "h264_nvenc": {"label": "H.264 NVENC (MP4, fast)", "ext": ".mp4", "video": ["-c:v", "h264_nvenc", "-preset", "p5", "-pix_fmt", "yuv420p"], "cq": True, "audio": ["-c:a", "aac", "-b:a", "192k"]},
    "prores": {"label": "ProRes 422 HQ (MOV)", "ext": ".mov", "video": ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"], "audio": ["-c:a", "pcm_s16le"]},
    "wav": {"label": "Audio only: WAV", "ext": ".wav", "kind": "audio", "audio": ["-c:a", "pcm_s16le"]},
    "mp3": {"label": "Audio only: MP3 320 kbps", "ext": ".mp3", "kind": "audio", "audio": ["-c:a", "libmp3lame", "-b:a", "320k"]},
    "m4a": {"label": "Audio only: AAC (M4A)", "ext": ".m4a", "kind": "audio", "audio": ["-c:a", "aac", "-b:a", "256k"]},
    "png": {"label": "Still frame: PNG (at the playhead)", "ext": ".png", "kind": "still"},
    "jpg": {"label": "Still frame: JPEG (at the playhead)", "ext": ".jpg", "kind": "still"},
}
SAMPLE_RATE = 48000



DECLICK_SAMPLES = int(round(0.005 * SAMPLE_RATE))      # 5 ms: 10 ms across a cut is below an audible gap
DECLICK_RAMP = (np.cos(np.linspace(0.0, np.pi / 2.0, DECLICK_SAMPLES)) ** 2) if DECLICK_SAMPLES > 1 else np.ones(1)

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
            if item.get("kind") not in FX.GENERATOR_KINDS and not os.path.isfile(item.get("path", "")):
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
            before = duration * {"end": 1.0, "start": 0.0}.get(tr.get("align"), 0.5)
            self.transitions.append({**tr, "cut": cut, "duration": duration, "trackId": a["trackId"],
                                     "lo": cut - before, "hi": cut - before + duration})

    def kind(self, clip):
        return (self.media.get(clip["mediaId"]) or {}).get("kind")

    def clip_window(self, clip):
        """Time span a clip is rendered, including transition handles."""
        start = float(clip["start"])
        end = start + self.durations[clip["id"]]
        for tr in self.transitions:
            if tr["a"] == clip["id"]:
                end = max(end, tr["hi"])
            if tr["b"] == clip["id"]:
                start = min(start, tr["lo"])
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


class WindowReader:
    """Random-access reader for reversed clips: decodes a short window of frames around the requested time."""

    def __init__(self, path, src_fps, width, height, duration):
        self.path, self.width, self.height = path, width, height
        self.fps = src_fps if src_fps and src_fps > 0 else 24.0
        self.dt = 1.0 / self.fps
        self.duration = duration
        frame_bytes = width * height * 3
        self.count = int(max(4, min(48, (200 * 1024 * 1024) // max(1, frame_bytes))))
        self.base = None
        self.frames = []

    def _load(self, src):
        # window ending just after src, so a backwards walk reuses it for count-1 more frames
        start = max(0.0, src - (self.count - 2) * self.dt)
        vf = f"scale={self.width}:{self.height}:flags=lanczos,format=rgb24"
        args = [M.ffmpeg_path(), "-v", "error", "-ss", f"{start:.4f}", "-i", self.path, "-an", "-vf", vf,
                "-frames:v", str(self.count), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        data = subprocess.run(args, capture_output=True, timeout=600, **M.popen_kwargs()).stdout
        size = self.width * self.height * 3
        self.frames = [np.frombuffer(data[i:i + size], dtype=np.uint8).reshape(self.height, self.width, 3)
                       for i in range(0, len(data) - size + 1, size)]
        self.base = start

    def get(self, src):
        src = min(max(0.0, src), max(0.0, self.duration - self.dt))
        if self.base is None or not self.frames or src < self.base - 1e-6 or src > self.base + (len(self.frames) - 1) * self.dt + 1e-6:
            self._load(src)
        if not self.frames:
            return None, None, 0.0
        pos = (src - self.base) / self.dt
        i0 = int(max(0, min(len(self.frames) - 1, math.floor(pos + 1e-6))))
        if i0 + 1 >= len(self.frames):
            return self.frames[i0], None, 0.0
        return self.frames[i0], self.frames[i0 + 1], float(min(1.0, max(0.0, pos - i0)))

    def close(self):
        self.frames = []


class TitleSource:
    """A title rendered once at project resolution (straight-alpha RGBA), then resized like a still image."""

    def __init__(self, title, project_w, project_h, width, height):
        from PIL import Image
        frame = TT.render_title(title, int(project_w), int(project_h))
        if (width, height) != (int(project_w), int(project_h)):
            frame = np.asarray(Image.fromarray(frame, "RGBA").resize((width, height), Image.LANCZOS)).copy()
        self.frame = frame

    def get(self, _src):
        return self.frame, None, 0.0

    def close(self):
        pass


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

    def resize(self, img, width, height):
        if img.shape[1] == height and img.shape[2] == width:
            return img
        import torch.nn.functional as F
        width, height = max(1, int(round(width))), max(1, int(round(height)))
        smaller = width < img.shape[2]
        return F.interpolate(img.unsqueeze(0), size=(height, width), mode="bilinear", align_corners=False, antialias=smaller)[0]

    def to_tensor(self, frame):
        return self.torch.from_numpy(frame).to(self.device).permute(2, 0, 1).float().div_(255.0)

    def grade(self, img, params):
        if params is None:
            return img
        torch = self.torch
        v = lambda values: torch.tensor(values, device=self.device, dtype=torch.float32).view(3, 1, 1)
        c = img * (params["exposure"]) * v(params["wb"])
        if params.get("style") == 1:
            # tonal wheels (same zone weights as the WebGL shader)
            L = (c * self.luma).sum(0, keepdim=True).clamp(0.0, 1.0)
            lo, hi = params["zone_lo"], params["zone_hi"]
            w = max(0.02, min(0.2, (hi - lo) * 0.5))
            ws = 1.0 - self._smooth(lo - w, lo + w, L)
            wh = self._smooth(hi - w, hi + w, L)
            wm = (1.0 - ws - wh).clamp(0.0, 1.0)
            off = params["zone_off"]
            c = c + v(off[0]) + ws * v(off[1]) + wm * v(off[2]) + wh * v(off[3])
            sat = params["zone_sat"]
            l2 = (c * self.luma).sum(0, keepdim=True)
            c = l2 + (c - l2) * (sat[0] * (1.0 + ws * (sat[1] - 1.0) + wm * (sat[2] - 1.0) + wh * (sat[3] - 1.0)))
        else:
            c = c * v(params["gain"]) + v(params["lift"]) * (1.0 - c)
            c = torch.clamp(c, min=0.0) ** (1.0 / v(params["gamma"]))
        c = (c - 0.5) * params["contrast"] + 0.5
        luma = (c * self.luma).sum(0, keepdim=True)
        c = luma + (c - luma) * params["saturation"]
        return c.clamp(0.0, 1.0)

    def place(self, img, x, y, alpha, rotation=0.0, crop=(0.0, 0.0, 0.0, 0.0)):
        """Crop (fractions l, r, t, b of the image), rotate (degrees, clockwise) and place an image whose centre sits at
        (x, y) pixels from the canvas centre. Returns premultiplied RGBA (4, H, W). Same maths as the WebGL layer shader."""
        _, h, w = img.shape
        cl, cr, ct, cb = [min(1.0, max(0.0, float(v))) for v in crop]
        if cl + cr >= 0.999 or ct + cb >= 0.999 or alpha <= 0:
            return self.torch.zeros(4, self.height, self.width, device=self.device)
        x0, x1 = int(round(cl * w)), w - int(round(cr * w))
        y0, y1 = int(round(ct * h)), h - int(round(cb * h))
        if (x0, y0, x1, y1) != (0, 0, w, h):
            img = img[:, y0:y1, x0:x1]
        # the cropped part's centre moves away from the full image's centre
        ox, oy = (x0 + x1 - w) / 2.0, (y0 + y1 - h) / 2.0
        rad = math.radians(float(rotation or 0.0))
        cos, sin = math.cos(rad), math.sin(rad)
        cx, cy = x + ox * cos - oy * sin, y + ox * sin + oy * cos
        if abs(rotation or 0.0) < 1e-4:
            return self.layer(img, cx, cy, alpha)
        return self.rotated(img, cx, cy, alpha, rad)

    def rotated(self, img, x, y, alpha, rad):
        torch = self.torch
        import torch.nn.functional as F
        _, h, w = img.shape
        if img.shape[0] == 3:
            img = torch.cat([img, torch.ones(1, h, w, device=self.device)], 0)
        premul = torch.cat([img[:3] * img[3:4], img[3:4]], 0)
        px = self.X * self.width - (self.width / 2 + x)
        py = self.Y * self.height - (self.height / 2 + y)
        cos, sin = math.cos(rad), math.sin(rad)
        lx = px * cos + py * sin          # inverse rotation back into the image's frame
        ly = -px * sin + py * cos
        gx = lx / (w / 2.0)
        gy = ly / (h / 2.0)
        grid = torch.stack([gx, gy], -1).unsqueeze(0)
        out = F.grid_sample(premul.unsqueeze(0), grid, mode="bilinear", padding_mode="zeros", align_corners=False)[0]
        return out * alpha

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
        self.info = []
        self.cancel_event = threading.Event()
        self.started = time.time()
        self.finished = None

    def public(self):
        return {"id": self.id, "status": self.status, "progress": round(self.progress, 4), "message": self.message,
                "error": self.error, "warnings": self.warnings, "info": self.info, "output": self.out_path if self.status == "done" else None,
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
        codec = CODECS.get(opts.get("codec") or "h264", CODECS["h264"])
        kind = codec.get("kind", "video")

        if kind == "still":
            self._still(tl, float(opts.get("at") or 0.0), opts, codec)
            return

        start = max(0.0, float(opts.get("start") or 0.0))
        end = float(opts.get("end") or 0.0) or tl.end_time()
        if end - start < 1.0 / tl.fps:
            raise RuntimeError("Nothing to export: the timeline (or the selected range) is empty")
        frames = int(round((end - start) * tl.fps))

        has_audio = any(tl.kind(c) in ("audio", "video") and tl.tracks.get(c["trackId"], {}).get("kind") == "audio" for c in tl.clips.values())
        audio_path = None
        if has_audio or kind == "audio":
            self.message = "Mixing audio..."
            audio_path = os.path.join(self.temp_dir, f"{self.id}_mix.wav")
            self._mix_audio(tl, start, end, audio_path, loudness=opts.get("loudness"))
        self.check()

        if kind == "audio":
            try:
                result = M.run([M.ffmpeg_path(), "-y", "-v", "error", "-i", audio_path, *codec["audio"], self.out_path], timeout=3600)
                if result.returncode != 0:
                    raise RuntimeError(f"Encoder failed: {result.stderr.strip()[-500:]}")
            finally:
                self._remove(audio_path)
            return

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
        args += ["-t", f"{frames / tl.fps:.6f}"]
        if codec["ext"] != ".mov":
            args += ["-movflags", "+faststart"]
        args.append(self.out_path)
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

    def _still(self, tl, at, opts, codec):
        """Render the single frame at time `at` and save it as an image."""
        from PIL import Image

        class Grab:
            def __init__(self):
                self.frame = None
                self.stdin = self

            def write(self, data):
                self.frame = data

        grab = Grab()
        at = max(0.0, min(at, max(0.0, tl.end_time() - 1.0 / tl.fps)))
        self._render_video(tl, at, 1, grab, opts)
        image = Image.frombytes("RGB", (tl.width, tl.height), grab.frame)
        if codec["ext"] == ".jpg":
            image.save(self.out_path, quality=95)
        else:
            image.save(self.out_path)

    # ----------------------------------------------------------------- video
    def _render_video(self, tl, start, frames, encoder, opts):
        import torch
        device = "cuda" if torch.cuda.is_available() else "cpu"
        comp = Compositor(tl.width, tl.height, device)
        effects = FX.Effects(device)
        default_interp = opts.get("interpolation") or "blend"
        sources = {}
        rife = {"model": None, "failed": False}
        grades = {cid: (None if T.has_grade_keys(c) else T.grade_params(c.get("grade"))) for cid, c in tl.clips.items()}
        lut_dir = os.path.join(self.registry.data_root, "luts")
        missing_luts = set()
        decode_scale = {}

        def apply_lut(img, grade):
            name = (grade or {}).get("lut")
            if not name or (grade or {}).get("enabled") is False:
                return img
            lut = L.load(lut_dir, name)
            if lut is None:
                if name not in missing_luts:
                    missing_luts.add(name)
                    self.warnings.append(f"LUT '{name}' was not found and was skipped")
                return img
            mix = float(grade.get("lutMix") if grade.get("lutMix") is not None else 1.0)
            return L.apply(img, lut, min(1.0, max(0.0, mix))) if mix > 1e-4 else img

        def source_for(clip):
            src = sources.get(clip["id"])
            if src is None:
                item = tl.media[clip["mediaId"]]
                # Decode at the largest size the clip reaches (scale may be keyframed), resize per frame when needed.
                scales = [float(clip.get("scale") if clip.get("scale") is not None else 1)] + [float(k["v"]) for k in T.keys_of(clip, "scale")]
                decode_scale[clip["id"]] = min(8.0, max(0.05, max(scales)))
                w, h = fit_size(item.get("width") or tl.width, item.get("height") or tl.height, tl.width, tl.height, decode_scale[clip["id"]])
                if item["kind"] == "title":
                    pw, ph = self._project_w(tl), self._project_h(tl)
                    w, h = fit_size(pw, ph, tl.width, tl.height, decode_scale[clip["id"]])
                    src = TitleSource(clip.get("title"), pw, ph, w, h)
                elif item["kind"] in ("solid", "gradient"):
                    w, h = fit_size(self._project_w(tl), self._project_h(tl), tl.width, tl.height, decode_scale[clip["id"]])
                    src = FX.GeneratorSource(item["kind"], clip.get("gen"), w, h)
                elif item["kind"] == "image":
                    src = StillSource(item["path"], w, h)
                elif clip.get("reverse"):
                    src = WindowReader(item["path"], item.get("fps") or tl.fps, w, h, float(item.get("duration") or 0))
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
            # within 2% of a frame is that frame: sub-frame offsets from rounding are not motion to blend
            if f1 is not None and weight > 0.98:
                return comp.to_tensor(f1)
            img = comp.to_tensor(f0)
            if f1 is None or weight < 0.02:
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
            if tl.kind(clip) == "adjust":
                return None
            tau = t - float(clip["start"])
            img = frame_for(clip, tau)
            if img is None:
                return None
            duration = tl.durations[clip["id"]]
            kt = min(max(tau, 0.0), duration)
            keyed = T.has_grade_keys(clip)
            grade = T.grade_at(clip, kt) if keyed else (clip.get("grade") or {})
            params = T.grade_params(grade) if keyed else grades[clip["id"]]
            rgb = img[:3] if img.shape[0] == 4 else img
            level = T.level_at(clip, tau, tl.kind(clip))
            if level is not None:
                # join match: a source correction, so it goes before the clip's own grade
                rgb = (rgb * torch.tensor(level, dtype=rgb.dtype, device=rgb.device).view(3, 1, 1)).clamp(0, 1)
            rgb = apply_lut(comp.grade(rgb, params), grade)
            img = self._cat(rgb, img[3:4]) if img.shape[0] == 4 else rgb
            if FX.active(clip):
                # effects run on premultiplied RGBA in the clip's own image space, then back to straight alpha
                alpha = img[3:4] if img.shape[0] == 4 else torch.ones_like(img[:1])
                out = effects.apply(self._cat(img[:3] * alpha, alpha), clip, kt, round(t * tl.fps))
                a = out[3:4]
                img = self._cat(torch.where(a > 0, out[:3] / a.clamp(min=1e-6), torch.zeros_like(out[:3])).clamp(0, 1), a)
            scale = max(0.0, T.prop(clip, "scale", kt, 1.0))
            base = decode_scale.get(clip["id"], 1.0)
            if abs(scale - base) > 1e-4:
                if scale <= 1e-4:
                    return None
                img = comp.resize(img, img.shape[2] * scale / base, img.shape[1] * scale / base)
            alpha = min(1.0, max(0.0, T.prop(clip, "opacity", kt, 1.0)))
            alpha *= T.fade_factor(clip, kt, duration)
            crop = tuple(T.prop(clip, name, kt, 0.0) for name in ("cropL", "cropR", "cropT", "cropB"))
            return comp.place(img, T.prop(clip, "x", kt, 0.0) * tl.width / max(1, self._project_w(tl)),
                              T.prop(clip, "y", kt, 0.0) * tl.height / max(1, self._project_h(tl)), alpha,
                              rotation=T.prop(clip, "rotation", kt, 0.0), crop=crop)

        def adjust(clip, canvas, t):
            """Adjustment layer: grade and effects on everything composited so far, mixed back by its opacity."""
            duration = tl.durations[clip["id"]]
            kt = min(max(t - float(clip["start"]), 0.0), duration)
            alpha = min(1.0, max(0.0, T.prop(clip, "opacity", kt, 1.0))) * T.fade_factor(clip, kt, duration)
            if alpha <= 0:
                return canvas
            keyed = T.has_grade_keys(clip)
            grade = T.grade_at(clip, kt) if keyed else (clip.get("grade") or {})
            params = T.grade_params(grade) if keyed else grades[clip["id"]]
            out = apply_lut(comp.grade(canvas.clamp(0, 1), params), grade)
            if FX.active(clip):
                out = effects.apply(self._cat(out, torch.ones_like(out[:1])), clip, kt, round(t * tl.fps))
                out = out[:3] + canvas * (1 - out[3:4])   # keyed-out or transparent parts show the original
            return out * alpha + canvas * (1 - alpha)

        track_clips = {t["id"]: sorted([c for c in tl.clips.values() if c["trackId"] == t["id"]], key=lambda c: float(c["start"]))
                       for t in tl.video_tracks}
        track_transitions = {t["id"]: [tr for tr in tl.transitions if tr["trackId"] == t["id"] and tr["type"] in T.VIDEO_TRANSITIONS]
                             for t in tl.video_tracks}
        windows = {cid: tl.clip_window(c) for cid, c in tl.clips.items()}
        last_report = 0
        for index in range(frames):
            self.check()
            t = start + index / tl.fps
            # which clip owns output frame k is decided at the frame's middle, so a clip edge a hair off the frame grid
            # (a cut at 4.250033s) can't hand a frame to the clip that has just ended
            tm = t + 0.5 / tl.fps
            canvas = torch.zeros(3, tl.height, tl.width, device=device)
            for track in tl.video_tracks:
                if track.get("hidden"):
                    continue
                active_tr = next((tr for tr in track_transitions[track["id"]]
                                  if tr["lo"] <= tm < tr["hi"]), None)
                if active_tr is not None:
                    a = clip_layer(tl.clips[active_tr["a"]], t)
                    b = clip_layer(tl.clips[active_tr["b"]], t)
                    if a is None or b is None:
                        layer = a if b is None else b
                    else:
                        p = (t - active_tr["lo"]) / active_tr["duration"]
                        layer = comp.transition(active_tr, a, b, p)
                    layers = [layer] if layer is not None else []
                else:
                    layers = []
                    for clip in track_clips[track["id"]]:
                        s = float(clip["start"])
                        if s <= tm < s + tl.durations[clip["id"]]:
                            if tl.kind(clip) == "adjust":
                                for layer in layers:
                                    canvas = layer[:3] + canvas * (1 - layer[3:4])
                                layers = []
                                canvas = adjust(clip, canvas, t)
                                continue
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

    @staticmethod
    def fx_filters(fx):
        """ffmpeg audio filter chain for a track's EQ and compressor (mirrors the Web Audio chain in playback.js)."""
        fx = fx or {}
        chain = []
        eq = fx.get("eq") or {}
        if eq.get("on"):
            low, mid, high = eq.get("low") or {}, eq.get("mid") or {}, eq.get("high") or {}
            if abs(float(low.get("g") or 0)) > 1e-3:
                chain.append(f"lowshelf=f={float(low.get('f') or 120):.1f}:g={float(low.get('g')):.2f}:t=s:w=1")
            if abs(float(mid.get("g") or 0)) > 1e-3:
                chain.append(f"equalizer=f={float(mid.get('f') or 1000):.1f}:t=q:w={max(0.1, float(mid.get('q') or 1)):.3f}:g={float(mid.get('g')):.2f}")
            if abs(float(high.get("g") or 0)) > 1e-3:
                chain.append(f"highshelf=f={float(high.get('f') or 8000):.1f}:g={float(high.get('g')):.2f}:t=s:w=1")
        comp = fx.get("comp") or {}
        if comp.get("on"):
            threshold = 10 ** (float(comp.get("threshold") or -18) / 20)
            makeup = min(64.0, max(1.0, 10 ** (float(comp.get("makeup") or 0) / 20)))
            chain.append(f"acompressor=threshold={max(0.000976563, min(1.0, threshold)):.6f}:ratio={max(1.0, min(20.0, float(comp.get('ratio') or 3))):.3f}"
                         f":attack={max(0.01, min(2000.0, float(comp.get('attack') or 10))):.3f}:release={max(0.01, min(9000.0, float(comp.get('release') or 150))):.3f}"
                         f":makeup={makeup:.4f}:knee=6")
        return chain

    def _apply_fx(self, buffer, fx):
        chain = self.fx_filters(fx)
        if not chain or not buffer.shape[1]:
            return buffer
        data = np.ascontiguousarray(buffer.T.astype(np.float32)).tobytes()
        args = [M.ffmpeg_path(), "-v", "error", "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "2", "-i", "-",
                "-af", ",".join(chain), "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "2", "-"]
        proc = subprocess.run(args, input=data, capture_output=True, timeout=3600, **M.popen_kwargs())
        if proc.returncode != 0:
            self.warnings.append("An audio effect could not be applied: " + proc.stderr.decode("utf-8", "ignore").strip()[-200:])
            return buffer
        out = np.frombuffer(proc.stdout, dtype=np.float32)
        out = out[: (len(out) // 2) * 2].reshape(-1, 2).T
        if out.shape[1] < buffer.shape[1]:
            out = np.pad(out, ((0, 0), (0, buffer.shape[1] - out.shape[1])))
        return out[:, : buffer.shape[1]].copy()

    def _loudness(self, wav_path):
        """Integrated loudness (LUFS) and true peak (dBTP) of a wav, measured with ffmpeg's EBU R128 scanner."""
        import re
        result = M.run([M.ffmpeg_path(), "-hide_banner", "-nostats", "-i", wav_path, "-af", "ebur128=peak=true", "-f", "null", "-"], timeout=3600)
        text = result.stderr or ""
        summary = text[text.rfind("Summary:"):] if "Summary:" in text else text
        integrated = re.search(r"I:\s*(-?[\d.]+|-inf)\s*LUFS", summary)
        peak = re.search(r"Peak:\s*(-?[\d.]+|-inf)\s*dBFS", summary)
        to_float = lambda m: (float(m.group(1)) if m and m.group(1) != "-inf" else None)
        return to_float(integrated), to_float(peak)

    @staticmethod
    def _write_wav(path, mix):
        pcm = (np.clip(mix, -1.0, 1.0).T * 32767.0).round().astype(np.int16)
        with wave.open(path, "wb") as handle:
            handle.setnchannels(2)
            handle.setsampwidth(2)
            handle.setframerate(SAMPLE_RATE)
            handle.writeframes(pcm.tobytes())

    @staticmethod
    def _needs_declick(tl, clip, edge, audio_transitions):
        """Whether a clip's head/tail is a hard cut in its audio (see _mix_audio)."""
        if any(tr["b" if edge == "head" else "a"] == clip["id"] for tr in audio_transitions):
            return False
        here = float(clip["start"]) if edge == "head" else float(clip["start"]) + tl.durations[clip["id"]]
        tol = 0.5 / tl.fps
        for other in tl.clips.values():
            if other["id"] == clip["id"] or other["trackId"] != clip["trackId"]:
                continue
            o0 = float(other["start"])
            o1 = o0 + tl.durations[other["id"]]
            if not (abs(o1 - here) < tol if edge == "head" else abs(o0 - here) < tol):
                continue
            first, second = (other, clip) if edge == "head" else (clip, other)
            if first["mediaId"] != second["mediaId"] or first.get("reverse") or second.get("reverse"):
                return True
            kind = tl.kind(first)
            if T.has_speed_keys(first, kind) or T.has_speed_keys(second, kind):
                return True
            if abs(T.clip_speeds(first)[0] - T.clip_speeds(second)[0]) > 1e-6:
                return True
            gap = float(T.source_time(second, 0.0, kind)) - float(T.source_time(first, tl.durations[first["id"]], kind))
            return abs(gap) > 1.5 / tl.fps          # the audio carries straight on: nothing to de-click
        return True

    def _mix_audio(self, tl, start, end, out_path, loudness=None):
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
                s0, _ = T.clip_speeds(clip)
                keyed_speed = T.has_speed_keys(clip, item["kind"])
                src_a, src_b = T.source_time(clip, s - cs), T.source_time(clip, e - cs)
                taus = (s - cs) + np.arange(count, dtype=np.float64) / SAMPLE_RATE
                if not keyed_speed and not clip.get("reverse"):
                    seg = self._decode_audio(item["path"], src_a, src_b, tempo=s0)
                    seg = seg[:, :count]
                    if seg.shape[1] < count:
                        seg = np.pad(seg, ((0, 0), (0, count - seg.shape[1])))
                else:
                    # Varispeed / reverse: resample along the source-time curve (pitch follows speed, like tape).
                    src_times = T.source_time(clip, taus)
                    lo_src, hi_src = float(src_times.min()), float(src_times.max())
                    raw = self._decode_audio(item["path"], lo_src, hi_src + 2.0 / SAMPLE_RATE, tempo=1.0)
                    src_a = lo_src
                    pos = (src_times - src_a) * SAMPLE_RATE
                    idx = np.arange(raw.shape[1])
                    seg = np.stack([np.interp(pos, idx, raw[ch], left=0.0, right=0.0) for ch in range(2)]).astype(np.float32) if raw.shape[1] else np.zeros((2, count), np.float32)
                inside = np.clip(taus, 0, duration)
                gain = T.db_to_gain(np.asarray(T.prop(clip, "volume", inside, 0.0), dtype=np.float64)) * T.fade_factor(clip, inside, duration)
                if keyed_speed:
                    # Fade out as the clip approaches a freeze instead of leaving a held (DC) sample.
                    gain = gain * np.clip(np.asarray(T.speed_at(clip, inside)) / 0.1, 0, 1)
                for tr in audio_transitions:
                    times = s + np.arange(count) / SAMPLE_RATE
                    lo, hi = tr["lo"], tr["hi"]
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
                # de-click: a 5 ms taper on each side of a hard audio cut, so the waveform never jumps between
                # samples. Not where a transition already crosses the cut or the audio carries straight on.
                taper = DECLICK_SAMPLES if count > 4 * DECLICK_SAMPLES else 0
                if taper and abs(s - w0) < 0.5 / SAMPLE_RATE and self._needs_declick(tl, clip, "head", audio_transitions):
                    gain[:taper] *= DECLICK_RAMP[::-1]
                if taper and abs(e - w1) < 0.5 / SAMPLE_RATE and self._needs_declick(tl, clip, "tail", audio_transitions):
                    gain[-taper:] *= DECLICK_RAMP
                buffer[:, i0:i0 + count] += seg * gain.astype(np.float32)
            buffer = self._apply_fx(buffer, track.get("fx"))
            buffer *= T.db_to_gain(track.get("volume"))
            automation = ((track.get("keys") or {}).get("volume")) or []
            if automation:
                times = start + np.arange(total, dtype=np.float64) / SAMPLE_RATE
                buffer *= T.db_to_gain(np.asarray(T.key_values(automation, times), dtype=np.float64)).astype(np.float32)
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
        master = self.project.get("master") or {}
        mix = self._apply_fx(mix, master.get("fx"))
        mix *= T.db_to_gain(master.get("volume"))
        self._write_wav(out_path, mix)
        if loudness in (None, "", "off"):
            measured, peak = self._loudness(out_path)
            if measured is not None:
                self.info.append(f"Loudness: {measured:.1f} LUFS integrated, peak {peak:.1f} dBFS" if peak is not None else f"Loudness: {measured:.1f} LUFS integrated")
            return
        target = float(loudness)
        measured, peak = self._loudness(out_path)
        if measured is None:
            self.warnings.append("The mix is silent, so it could not be normalised")
            return
        gain_db = target - measured
        mix *= 10 ** (gain_db / 20)
        ceiling = 10 ** (-1.0 / 20)
        if np.abs(mix).max() > ceiling:
            # keep peaks under -1 dBFS with ffmpeg's look-ahead limiter (fed float samples, so nothing clips on the way in)
            data = np.ascontiguousarray(mix.T.astype(np.float32)).tobytes()
            limited = out_path + ".lim.wav"
            proc = subprocess.run([M.ffmpeg_path(), "-y", "-v", "error", "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "2", "-i", "-",
                                   "-af", f"alimiter=limit={ceiling:.4f}:level=disabled", "-c:a", "pcm_s16le", limited],
                                  input=data, capture_output=True, timeout=3600, **M.popen_kwargs())
            if proc.returncode == 0 and os.path.isfile(limited):
                os.replace(limited, out_path)
            else:
                self.warnings.append("The limiter could not run; peaks above -1 dBFS were clipped")
                self._write_wav(out_path, mix)
        else:
            self._write_wav(out_path, mix)
        final, final_peak = self._loudness(out_path)
        self.info.append(f"Loudness: {measured:.1f} LUFS normalised to {final:.1f} LUFS (target {target:.0f}), peak {final_peak:.1f} dBFS"
                         if final is not None and final_peak is not None else f"Loudness normalised by {gain_db:+.1f} dB")
