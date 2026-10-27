"""Title rendering for export with Pillow. static/js/titles.js uses the same layout rules on a canvas for the preview."""

import os
import sys

# Family -> (regular, bold, italic, bold italic) font files.
FONT_FILES = {
    "Segoe UI": ("segoeui.ttf", "segoeuib.ttf", "segoeuii.ttf", "segoeuiz.ttf"),
    "Arial": ("arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf"),
    "Calibri": ("calibri.ttf", "calibrib.ttf", "calibrii.ttf", "calibriz.ttf"),
    "Bahnschrift": ("bahnschrift.ttf",) * 4,
    "Verdana": ("verdana.ttf", "verdanab.ttf", "verdanai.ttf", "verdanaz.ttf"),
    "Tahoma": ("tahoma.ttf", "tahomabd.ttf", "tahoma.ttf", "tahomabd.ttf"),
    "Trebuchet MS": ("trebuc.ttf", "trebucbd.ttf", "trebucit.ttf", "trebucbi.ttf"),
    "Georgia": ("georgia.ttf", "georgiab.ttf", "georgiai.ttf", "georgiaz.ttf"),
    "Times New Roman": ("times.ttf", "timesbd.ttf", "timesi.ttf", "timesbi.ttf"),
    "Palatino Linotype": ("pala.ttf", "palab.ttf", "palai.ttf", "palabi.ttf"),
    "Courier New": ("cour.ttf", "courbd.ttf", "couri.ttf", "courbi.ttf"),
    "Consolas": ("consola.ttf", "consolab.ttf", "consolai.ttf", "consolaz.ttf"),
    "Impact": ("impact.ttf",) * 4,
    "Comic Sans MS": ("comic.ttf", "comicbd.ttf", "comici.ttf", "comicz.ttf"),
    # Linux fallbacks (used when the Windows fonts are not present)
    "DejaVu Sans": ("DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSans-Oblique.ttf", "DejaVuSans-BoldOblique.ttf"),
    "DejaVu Serif": ("DejaVuSerif.ttf", "DejaVuSerif-Bold.ttf", "DejaVuSerif-Italic.ttf", "DejaVuSerif-BoldItalic.ttf"),
}

ASCENT = 0.8  # baseline sits this far (in font sizes) below the top of a line; titles.js uses the same value


def _font_dirs():
    dirs = []
    if os.name == "nt":
        windir = os.environ.get("WINDIR", r"C:\Windows")
        dirs.append(os.path.join(windir, "Fonts"))
        local = os.environ.get("LOCALAPPDATA")
        if local:
            dirs.append(os.path.join(local, "Microsoft", "Windows", "Fonts"))
    elif sys.platform == "darwin":
        dirs += ["/System/Library/Fonts", "/Library/Fonts", os.path.expanduser("~/Library/Fonts")]
    else:
        dirs += ["/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/truetype", "/usr/share/fonts", os.path.expanduser("~/.fonts")]
    return [d for d in dirs if os.path.isdir(d)]


_cache = {}


def _find(filename):
    if filename in _cache:
        return _cache[filename]
    found = None
    for folder in _font_dirs():
        candidate = os.path.join(folder, filename)
        if os.path.isfile(candidate):
            found = candidate
            break
        try:
            for name in os.listdir(folder):
                if name.lower() == filename.lower():
                    found = os.path.join(folder, name)
                    break
        except OSError:
            continue
        if found:
            break
    _cache[filename] = found
    return found


def available_fonts():
    return [family for family, files in FONT_FILES.items() if _find(files[0])]


def font_path(family, bold=False, italic=False):
    files = FONT_FILES.get(family)
    if not files or not _find(files[0]):
        for fallback in ("Segoe UI", "Arial", "DejaVu Sans"):
            if _find(FONT_FILES[fallback][0]):
                files = FONT_FILES[fallback]
                break
        else:
            return None
    index = (1 if bold else 0) + (2 if italic else 0)
    return _find(files[index]) or _find(files[0])


def _rgba(hex_color, opacity=1.0):
    text = str(hex_color or "#ffffff").lstrip("#")
    try:
        v = int(text, 16) if len(text) == 6 else 0xFFFFFF
    except ValueError:
        v = 0xFFFFFF
    return ((v >> 16) & 255, (v >> 8) & 255, v & 255, int(round(255 * max(0.0, min(1.0, float(opacity))))))


def render_title(title, width, height):
    """RGBA uint8 array (height, width, 4), straight alpha, of a title at frame size width x height."""
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter, ImageFont

    title = title or {}
    size = max(4, int(round(float(title.get("size") or 96))))
    path = font_path(title.get("font") or "Segoe UI", bool(title.get("bold")), bool(title.get("italic")))
    try:
        font = ImageFont.truetype(path, size) if path else ImageFont.load_default(size)
    except Exception:
        font = ImageFont.load_default()
    lines = str(title.get("text") or "").split("\n")
    advance = size * float(title.get("lineHeight") or 1.15)
    measure = ImageDraw.Draw(Image.new("L", (1, 1)))
    widths = [measure.textlength(line, font=font) for line in lines]
    block_w = max(widths) if widths else 0
    block_h = size + advance * (len(lines) - 1)
    top = height / 2 - block_h / 2
    align = title.get("align") or "center"
    anchor_x = {"left": width / 2 - block_w / 2, "right": width / 2 + block_w / 2}.get(align, width / 2)
    anchor = {"left": "ls", "right": "rs"}.get(align, "ms")

    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    box = title.get("box") or {}
    if box.get("on"):
        pad = float(box.get("padding") or 0)
        rect = [width / 2 - block_w / 2 - pad, top - pad, width / 2 + block_w / 2 + pad, top + block_h + pad]
        ImageDraw.Draw(canvas).rectangle(rect, fill=_rgba(box.get("color"), box.get("opacity", 0.5)))

    outline = title.get("outline") or {}
    stroke = int(round(float(outline.get("width") or 0))) if outline.get("on") else 0

    def draw_text(target, fill, stroke_fill, dx=0.0, dy=0.0):
        draw = ImageDraw.Draw(target)
        for i, line in enumerate(lines):
            y = top + size * ASCENT + i * advance + dy
            draw.text((anchor_x + dx, y), line, font=font, fill=fill, anchor=anchor,
                      stroke_width=stroke, stroke_fill=stroke_fill)

    shadow = title.get("shadow") or {}
    if shadow.get("on"):
        layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        colour = _rgba(shadow.get("color"), 1.0)
        draw_text(layer, colour, colour, float(shadow.get("x") or 0), float(shadow.get("y") or 0))
        blur = float(shadow.get("blur") or 0)
        if blur > 0:
            layer = layer.filter(ImageFilter.GaussianBlur(blur / 2))
        alpha = layer.getchannel("A").point(lambda a: int(a * max(0.0, min(1.0, float(shadow.get("opacity", 0.6))))))
        layer.putalpha(alpha)
        canvas = Image.alpha_composite(canvas, layer)

    text_layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw_text(text_layer, _rgba(title.get("color")), _rgba(outline.get("color")))
    canvas = Image.alpha_composite(canvas, text_layer)
    return np.asarray(canvas).copy()
