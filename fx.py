"""Clip effects and generators for export. Mirrors static/js/effects.js (catalogue, parameter scaling and shader maths)
so exports match the viewer. Effects work on premultiplied RGBA tensors (4, H, W) in 0..1, in the clip's own image space."""

import math

import numpy as np

from . import timeline_math as T

GENERATOR_KINDS = ("title", "solid", "gradient", "adjust")

DEFAULTS = {
    "blur": {"amount": 20},
    "sharpen": {"amount": 60},
    "vignette": {"amount": 50, "size": 50, "softness": 50},
    "grain": {"amount": 25, "size": 1.5},
    "bw": {"amount": 100},
    "chroma": {"color": "#00ff00", "tolerance": 25, "softness": 10, "spill": 50},
    "flip": {"horizontal": True, "vertical": False},
    "pixelate": {"size": 20},
    "aberration": {"amount": 20},
    "letterbox": {"ratio": 2.39, "color": "#000000"},
}


def lane(fx_id, key):
    return f"fx:{fx_id}:{key}"


def params_at(clip, fx, tau):
    """An effect's parameters at clip time tau, with keyframed ones interpolated (mirrors model.effectParamsAt)."""
    out = {**DEFAULTS.get(fx.get("type"), {}), **(fx.get("params") or {})}
    for key in list(out):
        ks = T.keys_of(clip, lane(fx.get("id"), key))
        if ks:
            out[key] = float(T.key_values(ks, tau))
    return out


def active(clip):
    return [fx for fx in (clip.get("effects") or []) if fx.get("on", True) and fx.get("type") in DEFAULTS]


def frame_seed(frame_index):
    return float(int(frame_index) % 997)


# --------------------------------------------------------------------------- generators

def render_generator(kind, gen, width, height):
    """Solid colour or linear gradient as an RGBA uint8 frame (same geometry as the canvas gradient in effects.js)."""
    gen = gen or {}
    if kind == "solid":
        rgb = T.hex_to_rgb(gen.get("color") or "#000000")
        frame = np.empty((height, width, 4), np.uint8)
        frame[..., :3] = np.round(np.array(rgb) * 255).astype(np.uint8)
        frame[..., 3] = 255
        return frame
    a = math.radians(float(gen.get("angle") or 0))
    dx, dy = math.cos(a), -math.sin(a)
    half = abs(dx) * width / 2 + abs(dy) * height / 2
    xs = np.arange(width, dtype=np.float32) + 0.5 - width / 2
    ys = np.arange(height, dtype=np.float32) + 0.5 - height / 2
    t = (xs[None, :] * dx + ys[:, None] * dy + half) / max(1e-6, 2 * half)
    t = np.clip(t, 0, 1)[..., None]
    c0 = np.array(T.hex_to_rgb(gen.get("color") or "#1b2a49"), np.float32) * 255
    c1 = np.array(T.hex_to_rgb(gen.get("color2") or "#c86b3c"), np.float32) * 255
    frame = np.empty((height, width, 4), np.uint8)
    frame[..., :3] = np.round(c0 + (c1 - c0) * t).astype(np.uint8)
    frame[..., 3] = 255
    return frame


class GeneratorSource:
    def __init__(self, kind, gen, width, height):
        self.frame = render_generator(kind, gen, width, height)

    def get(self, _src):
        return self.frame, None, 0.0

    def close(self):
        pass


# --------------------------------------------------------------------------- effects

class Effects:
    def __init__(self, device):
        import torch
        self.torch = torch
        self.device = device
        self.luma = torch.tensor([0.2126, 0.7152, 0.0722], device=device).view(3, 1, 1)
        self._grids = {}

    def _coords(self, h, w):
        """Pixel-centre coordinates in 0..1, y down: (u, v) each (H, W)."""
        key = (h, w)
        if key not in self._grids:
            torch = self.torch
            v = (torch.arange(h, device=self.device, dtype=torch.float32) + 0.5) / h
            u = (torch.arange(w, device=self.device, dtype=torch.float32) + 0.5) / w
            vv, uu = torch.meshgrid(v, u, indexing="ij")
            self._grids = {key: (uu, vv)}
        return self._grids[key]

    def sample(self, img, u, v):
        """Bilinear sample with clamped edges at (u, v) in 0..1 (like a WebGL texture with CLAMP_TO_EDGE)."""
        import torch.nn.functional as F
        grid = self.torch.stack([u * 2 - 1, v * 2 - 1], -1).unsqueeze(0)
        return F.grid_sample(img.unsqueeze(0), grid, mode="bilinear", padding_mode="border", align_corners=False)[0]

    def blur(self, img, sigma_px_x, sigma_px_y):
        import torch.nn.functional as F
        torch = self.torch
        out = img.unsqueeze(0)
        for sigma, axis in ((sigma_px_x, 3), (sigma_px_y, 2)):
            if sigma < 0.2:
                continue
            radius = max(1, int(math.ceil(3 * sigma)))
            x = torch.arange(-radius, radius + 1, device=self.device, dtype=torch.float32)
            k = torch.exp(-0.5 * (x / sigma) ** 2)
            k = k / k.sum()
            c = out.shape[1]
            if axis == 3:
                out = F.conv2d(F.pad(out, (radius, radius, 0, 0), mode="replicate"), k.view(1, 1, 1, -1).repeat(c, 1, 1, 1), groups=c)
            else:
                out = F.conv2d(F.pad(out, (0, 0, radius, radius), mode="replicate"), k.view(1, 1, -1, 1).repeat(c, 1, 1, 1), groups=c)
        return out[0]

    @staticmethod
    def _smooth(e0, e1, x):
        t = ((x - e0) / (e1 - e0)).clamp(0, 1)
        return t * t * (3 - 2 * t)

    def _hash(self, px, py):
        torch = self.torch
        px = torch.frac(px * 443.897)
        py = torch.frac(py * 441.423)
        d = px * (py + 19.19) + py * (px + 19.19)
        px, py = px + d, py + d
        return torch.frac((px + py) * px)

    def apply(self, img, clip, tau, frame_index):
        """Run a clip's enabled effects, in order, on premultiplied RGBA (4, H, W)."""
        for fx in active(clip):
            img = self.one(img, fx["type"], params_at(clip, fx, tau), frame_index)
        return img

    def one(self, img, kind, p, frame_index):
        torch = self.torch
        _, h, w = img.shape
        aspect = w / max(1, h)
        rgb, a = img[:3], img[3:4]
        num = lambda key: float(p.get(key) or 0)
        if kind == "blur":
            sigma = num("amount") / 100 * 0.025
            return self.blur(img, sigma * h, sigma * h) if sigma > 1e-5 else img
        if kind == "sharpen":
            amount = num("amount") / 100
            if amount <= 0:
                return img
            u, v = self._coords(h, w)
            r = max(1.0, 0.0015 * h)
            dx, dy = r / w, r / h
            blur = (self.sample(img, u + dx, v) + self.sample(img, u - dx, v) + self.sample(img, u, v + dy) + self.sample(img, u, v - dy)) * 0.25
            s = rgb + amount * (rgb - blur[:3])
            return torch.cat([torch.minimum(s.clamp(min=0.0), a), a], 0)
        if kind == "vignette":
            u, v = self._coords(h, w)
            start = 0.1 + 0.8 * num("size") / 100
            width = 0.05 + 0.9 * num("softness") / 100
            d = torch.sqrt(((u - 0.5) * aspect) ** 2 + (v - 0.5) ** 2) / math.sqrt((aspect * 0.5) ** 2 + 0.25)
            return torch.cat([rgb * (1 - num("amount") / 100 * self._smooth(start, start + width, d)), a], 0)
        if kind == "grain":
            amount = num("amount") / 100
            if amount <= 0:
                return img
            u, v = self._coords(h, w)
            size = max(1e-3, num("size") * h / 1080.0)
            seed = frame_seed(frame_index)
            cx, cy = torch.floor(u * w / size), torch.floor(v * h / size)
            n = self._hash(cx + seed, cy + seed) + self._hash(cx * 1.37 + seed + 17.0, cy * 1.37 + seed + 17.0) - 1.0
            return torch.cat([torch.minimum((rgb + n * amount * 0.25 * a).clamp(min=0.0), a), a], 0)
        if kind == "bw":
            l = (rgb * self.luma).sum(0, keepdim=True)
            m = num("amount") / 100
            return torch.cat([rgb + (l - rgb) * m, a], 0)
        if kind == "chroma":
            tol, soft, spill_amt = num("tolerance") / 100 * 0.5, num("softness") / 100 * 0.5, num("spill") / 100
            s = torch.where(a > 0, rgb / a.clamp(min=1e-6), torch.zeros_like(rgb))
            kr, kg, kb = T.hex_to_rgb(p.get("color") or "#00ff00")
            cb = -0.1146 * s[0] - 0.3854 * s[1] + 0.5 * s[2]
            cr = 0.5 * s[0] - 0.4542 * s[1] - 0.0458 * s[2]
            kcb = -0.1146 * kr - 0.3854 * kg + 0.5 * kb
            kcr = 0.5 * kr - 0.4542 * kg - 0.0458 * kb
            d = torch.sqrt((cb - kcb) ** 2 + (cr - kcr) ** 2)
            mask = self._smooth(tol, tol + soft + 1e-3, d)
            spill = spill_amt * (1 - self._smooth(tol, tol + soft + 0.25, d))
            l = (s * self.luma).sum(0)
            s = s + (l - s) * spill
            na = a[0] * mask
            return torch.cat([s * na, na.unsqueeze(0)], 0)
        if kind == "flip":
            dims = ([2] if p.get("horizontal") else []) + ([1] if p.get("vertical") else [])
            return torch.flip(img, dims) if dims else img
        if kind == "pixelate":
            size = num("size")
            if size <= 0:
                return img
            block = max(1.0, size / 100 * 0.1 * h)
            u, v = self._coords(h, w)
            bu, bv = block / w, block / h
            return self.sample(img, (torch.floor(u / bu) + 0.5) * bu, (torch.floor(v / bv) + 0.5) * bv)
        if kind == "aberration":
            k = num("amount") / 100 * 0.01 * 2
            if k <= 0:
                return img
            u, v = self._coords(h, w)
            r = self.sample(img, u + (u - 0.5) * k, v + (v - 0.5) * k)
            b = self.sample(img, u - (u - 0.5) * k, v - (v - 0.5) * k)
            return torch.cat([r[0:1], img[1:2], b[2:3], torch.maximum(a, torch.maximum(r[3:4], b[3:4]))], 0)
        if kind == "letterbox":
            ratio = float(p.get("ratio") or 2.39)
            u, v = self._coords(h, w)
            if aspect < ratio:
                bar = (v - 0.5).abs() > 0.5 * aspect / ratio
            else:
                bar = (u - 0.5).abs() > 0.5 * ratio / aspect
            col = torch.tensor([*T.hex_to_rgb(p.get("color") or "#000000"), 1.0], device=self.device).view(4, 1, 1)
            return torch.where(bar.unsqueeze(0), col.expand_as(img), img)
        return img
