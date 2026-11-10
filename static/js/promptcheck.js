// Continuation timing in H3 prompts. A run that leaves a clip (or a sliding window after the first) opens on frames it
// can't change: the held frames of the join, or the overlap with the previous window. Prompt time 00:00 is the first of
// them. A cut or a new line timed inside them can't happen there, so the model makes it happen straight after them:
// the shot jumps right at the join and the new line runs over the end of the last one. The rule: a continuation keeps
// its shot and starts nobody talking for its first 2 seconds (or longer when more than that is held).

const TS = /\bAt (\d{1,2}):(\d{2}(?:\.\d+)?)/g;              // a timed event
const ANY_TS = /\b([Aa]t) (\d{1,2}):(\d{2}(?:\.\d+)?)/g;     // events and references back to them ("her line at 00:00.200")
const BLOCK = /\[\/duration=[^\]]*\]/g;
const fmt = (t) => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
};

// The prompt's sliding-window blocks: [{start, end, text, duration}] (one block when it has no [/duration=...] markers).
export function blocks(prompt) {
  const marks = [...prompt.matchAll(BLOCK)];
  if (!marks.length) return [{ start: 0, end: prompt.length, text: prompt, duration: null }];
  const out = [];
  // text before the first marker belongs to the first block
  marks.forEach((m, i) => {
    const start = i === 0 ? 0 : m.index;
    const end = i + 1 < marks.length ? marks[i + 1].index : prompt.length;
    const d = /duration=\s*([\d.]+)/.exec(m[0]);
    out.push({ start, end, text: prompt.slice(start, end), duration: d ? parseFloat(d[1]) : null });
  });
  return out;
}

// When a block first cuts or starts a line: {at, untimedCut, timed} (at = Infinity when it does neither).
export function firstEvent(text) {
  const times = [...text.matchAll(TS)].map(m => parseInt(m[1], 10) * 60 + parseFloat(m[2]));
  const timed = times.length ? Math.min(...times) : Infinity;
  // [Shot 1] that opens with a cut and no time of its own cuts at 00:00
  const s1 = /\[Shot 1\]\s*([^[]{0,200})/.exec(text);
  const lead = s1 ? s1[1].split(/\bAt \d/)[0] : "";     // Shot 1's words before its first timing
  const untimedCut = !!(s1 && /\bcuts? (?:straight |directly )?to\b/i.test(lead.slice(0, 120)));
  return { at: untimedCut ? 0 : timed, untimedCut, timed };
}

// Problems with a prompt's continuation timing. continues: whether the first block continues a clip (Extend, Bridge…);
// held: seconds held at its start. Later blocks always continue the window before.
export function check(prompt, { continues, held = 0, minimum = 2 } = {}) {
  const out = [];
  blocks(prompt).forEach((b, i) => {
    if (i === 0 && !continues) return;
    const need = i === 0 ? Math.max(minimum, Math.ceil((held + 1) * 10) / 10) : minimum;
    const ev = firstEvent(b.text);
    if (ev.at < need - 1e-6) out.push({ block: i, at: ev.at, need, untimedCut: ev.untimedCut });
  });
  return out;
}

// Move a block's timings so its first cut or line comes at `need`: every "At mm:ss.sss" later by the same amount, and an
// untimed opening cut becomes a timed one after a first shot that carries straight on from the frames before.
function fixBlock(text, need) {
  const ev = firstEvent(text);
  const shift = Math.max(0, need - (ev.untimedCut ? 0 : ev.timed));
  let out = text.replace(ANY_TS, (_, at, m, s) => `${at} ${fmt(parseInt(m, 10) * 60 + parseFloat(s) + shift)}`);
  if (ev.untimedCut) {
    out = out.replace(/\[Shot (\d+)\]/g, (_, n) => `[Shot ${parseInt(n, 10) + 1}]`);
    out = out.replace(/\[Shot 2\]\s*(\S)/, (_, c) =>
      `[Shot 1] The shot carries straight on from the opening frames with no cut: the same framing, camera move and people, and nobody starts a new line until ${fmt(need)}. [Shot 2] At ${fmt(need)}, ${c.toLowerCase()}`);
  }
  return { text: out, shift };
}

// The prompt with every problem from check() fixed. A window whose last shot now starts too close to its end (or past
// it) is lengthened by the same amount, so nothing written falls off it: lengthened lists those [{block, from, to}].
export function fix(prompt, problems) {
  const bs = blocks(prompt);
  const want = new Map(problems.map(p => [p.block, p.need]));
  let out = "";
  const lengthened = [];
  bs.forEach((b, i) => {
    if (!want.has(i)) { out += b.text; return; }
    let { text } = fixBlock(b.text, want.get(i));
    const last = Math.max(0, ...[...text.matchAll(TS)].map(m => parseInt(m[1], 10) * 60 + parseFloat(m[2])));
    if (b.duration && last > b.duration - 1) {
      const to = Math.ceil(last + 1.5);
      text = text.replace(/(\[\/duration=\s*)([\d.]+)/, (_, a) => `${a}${to}`);
      lengthened.push({ block: i, from: b.duration, to });
    }
    out += text;
  });
  return { prompt: out, lengthened };
}

export const ts = fmt;
