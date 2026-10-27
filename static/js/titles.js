// Title rendering on a canvas for the viewer. titles.py renders the same layout with Pillow for export.
export const ASCENT = 0.8;
export const FONT_FALLBACK = ["Segoe UI", "Arial", "Calibri", "Bahnschrift", "Verdana", "Tahoma", "Trebuchet MS", "Georgia",
  "Times New Roman", "Palatino Linotype", "Courier New", "Consolas", "Impact", "Comic Sans MS"];

const hexA = (hex, a = 1) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  const v = m ? parseInt(m[1], 16) : 0xffffff;
  return `rgba(${v >> 16 & 255},${v >> 8 & 255},${v & 255},${Math.max(0, Math.min(1, a))})`;
};

// Draw a title into `canvas` sized width x height (the project frame size).
export function drawTitle(canvas, title, width, height) {
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  const t = title || {};
  const size = Math.max(4, Math.round(t.size || 96));
  ctx.font = `${t.italic ? "italic " : ""}${t.bold ? "bold " : ""}${size}px "${t.font || "Segoe UI"}", sans-serif`;
  const lines = String(t.text ?? "").split("\n");
  const advance = size * (t.lineHeight || 1.15);
  const widths = lines.map(l => ctx.measureText(l).width);
  const blockW = Math.max(0, ...widths);
  const blockH = size + advance * (lines.length - 1);
  const top = height / 2 - blockH / 2;
  const align = t.align || "center";
  const anchorX = align === "left" ? width / 2 - blockW / 2 : align === "right" ? width / 2 + blockW / 2 : width / 2;
  if (t.box?.on) {
    const pad = t.box.padding || 0;
    ctx.fillStyle = hexA(t.box.color, t.box.opacity ?? 0.5);
    ctx.fillRect(width / 2 - blockW / 2 - pad, top - pad, blockW + 2 * pad, blockH + 2 * pad);
  }
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  const stroke = t.outline?.on ? Math.round(t.outline.width || 0) : 0;
  const drawLines = (fill, strokeColor, dx = 0, dy = 0) => {
    lines.forEach((line, i) => {
      const y = top + size * ASCENT + i * advance + dy;
      if (stroke > 0) { ctx.strokeStyle = strokeColor; ctx.lineWidth = stroke * 2; ctx.strokeText(line, anchorX + dx, y); }
      ctx.fillStyle = fill;
      ctx.fillText(line, anchorX + dx, y);
    });
  };
  if (t.shadow?.on) {
    ctx.save();
    const blur = t.shadow.blur || 0;
    if (blur > 0) ctx.filter = `blur(${blur / 2}px)`;
    ctx.globalAlpha = Math.max(0, Math.min(1, t.shadow.opacity ?? 0.6));
    const col = hexA(t.shadow.color, 1);
    drawLines(col, col, t.shadow.x || 0, t.shadow.y || 0);
    ctx.restore();
  }
  drawLines(hexA(t.color, 1), hexA(t.outline?.color || "#000000", 1));
  canvas.__version = (canvas.__version || 0) + 1;
}
