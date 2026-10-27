""".cube 3D LUTs: parsing, storage and trilinear application (export). static/js/lut.js parses the same format."""

import os
import re

import numpy as np

_cache = {}


def safe_name(name):
    base = os.path.splitext(os.path.basename(str(name or "")))[0]
    base = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", base).strip(" .")
    return base[:80] or "lut"


def parse_cube(text):
    """Returns (size, table) where table is float32 (size, size, size, 3) indexed [b][g][r], values remapped to 0..1."""
    size = None
    domain_min, domain_max = [0.0, 0.0, 0.0], [1.0, 1.0, 1.0]
    rows = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        head = line.split()[0].upper()
        if head == "LUT_3D_SIZE":
            size = int(line.split()[1])
        elif head == "LUT_1D_SIZE":
            raise ValueError("1D LUTs are not supported; use a 3D .cube LUT")
        elif head == "DOMAIN_MIN":
            domain_min = [float(v) for v in line.split()[1:4]]
        elif head == "DOMAIN_MAX":
            domain_max = [float(v) for v in line.split()[1:4]]
        elif head in ("TITLE", "LUT_3D_INPUT_RANGE"):
            continue
        else:
            parts = line.split()
            if len(parts) >= 3:
                try:
                    rows.append([float(parts[0]), float(parts[1]), float(parts[2])])
                except ValueError:
                    continue
    if not size or size < 2:
        raise ValueError("Not a 3D .cube LUT (missing LUT_3D_SIZE)")
    if len(rows) != size ** 3:
        raise ValueError(f"LUT has {len(rows)} entries, expected {size ** 3}")
    table = np.asarray(rows, dtype=np.float32).reshape(size, size, size, 3)
    lo, hi = np.asarray(domain_min, np.float32), np.asarray(domain_max, np.float32)
    table = (table - lo) / np.maximum(hi - lo, 1e-6)
    return size, np.clip(table, 0.0, 1.0)


def load(folder, name):
    path = os.path.join(folder, safe_name(name) + ".cube")
    if not os.path.isfile(path):
        return None
    key = (path, os.path.getmtime(path))
    if key not in _cache:
        with open(path, "r", encoding="utf-8", errors="ignore") as handle:
            _cache[key] = parse_cube(handle.read())
    return _cache[key]


def apply(rgb, lut, mix=1.0):
    """Apply a LUT to a torch tensor (3, H, W) in 0..1 with trilinear interpolation, blended by mix."""
    import torch
    size, table = lut
    device = rgb.device if hasattr(rgb, "device") else "cpu"
    tab = getattr(apply, "_tensors", {}).get((id(table), str(device)))
    if tab is None:
        tab = torch.from_numpy(table).to(device)
        apply._tensors = {**getattr(apply, "_tensors", {}), (id(table), str(device)): tab}
    c = rgb.clamp(0, 1) * (size - 1)
    i0 = c.floor().long() if hasattr(c, "long") else np.floor(c).astype(np.int64)
    i0 = i0.clamp(0, size - 2)
    f = c - i0
    r0, g0, b0 = i0[0], i0[1], i0[2]
    fr, fg, fb = f[0].unsqueeze(-1), f[1].unsqueeze(-1), f[2].unsqueeze(-1)
    out = 0
    for db in (0, 1):
        wb = fb if db else 1 - fb
        for dg in (0, 1):
            wg = fg if dg else 1 - fg
            for dr in (0, 1):
                wr = fr if dr else 1 - fr
                out = out + tab[b0 + db, g0 + dg, r0 + dr] * (wr * wg * wb)
    out = out.permute(2, 0, 1)
    if mix >= 0.999:
        return out
    return rgb * (1 - mix) + out * mix
