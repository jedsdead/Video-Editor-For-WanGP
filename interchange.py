"""Hand-off to other editors and project collection.

- FCP 7 XML (xmeml v5), which Premiere Pro and DaVinci Resolve both import: every video and audio track, clips with their
  trims, linked sound, constant speed and reverse, dissolves and audio crossfades, clip volume and opacity, clips that
  are turned off, and markers. Grades, effects, masks, transforms and titles have no equivalent there and are left out
  (the export says so).
- A CMX 3600 EDL of the main video track (V1), with its sound, for anything else.
- Collect: one ZIP with the project and every file it uses (and its LUTs), for archiving or moving machines; and
  opening such a ZIP, with every file relinked where it was unpacked.
"""
import json
import os
import re
import zipfile
from urllib.parse import quote
from xml.sax.saxutils import escape


# ---------------------------------------------------------------- shared
def rate_of(fps):
    """(timebase, ntsc) for a frame rate: 23.976 is 24 with NTSC pulldown, 29.97 is 30, 59.94 is 60."""
    fps = float(fps or 24)
    for base in (24, 30, 60, 120):
        if abs(fps - base * 1000 / 1001) < 0.01:
            return base, True
    return int(round(fps)), False


def tracks_of(project, kind):
    return [t for t in project.get("tracks") or [] if t.get("kind") == kind]


def media_kind(project, clip):
    item = (project.get("media") or {}).get(clip.get("mediaId")) or {}
    return item.get("kind") or ("title" if item.get("generator") else None)


def clip_len(clip):
    """Timeline seconds a clip lasts (constant speed; a speed ramp is taken at its average)."""
    if clip.get("dur") is not None:
        return float(clip["dur"])
    span = abs(float(clip.get("out") or 0) - float(clip.get("in") or 0))
    return span / max(0.01, abs(float(clip.get("speed") or 1)))


def file_url(path):
    p = os.path.abspath(path).replace("\\", "/")
    if re.match(r"^[A-Za-z]:/", p):
        return "file://localhost/" + quote(p, safe="/:")
    return "file://localhost" + quote(p, safe="/")


def _tc(frames, base):
    frames = max(0, int(round(frames)))
    f, s = frames % base, frames // base
    return f"{s // 3600:02d}:{s // 60 % 60:02d}:{s % 60:02d}:{f:02d}"


# ---------------------------------------------------------------- FCP 7 XML
def to_xmeml(project):
    """FCP 7 XML of the open timeline. Returns (xml text, [notes on what isn't carried])."""
    settings = project.get("settings") or {}
    fps = float(settings.get("fps") or 24)
    base, ntsc = rate_of(fps)
    W, H = int(settings.get("width") or 1920), int(settings.get("height") or 1080)
    media = project.get("media") or {}
    clips = [c for c in project.get("clips") or []]
    F = lambda sec: int(round(float(sec) * fps))
    rate = f"<rate><timebase>{base}</timebase><ntsc>{'TRUE' if ntsc else 'FALSE'}</ntsc></rate>"
    notes, skipped = set(), 0
    files_done, file_ids = set(), {}
    out = []

    def file_el(item):
        fid = file_ids.setdefault(item["id"], f"file-{len(file_ids) + 1}")
        if fid in files_done:
            return f'<file id="{fid}"/>'
        files_done.add(fid)
        dur = F(item.get("duration") or 0)
        v = (f"<video><samplecharacteristics>{rate}<width>{int(item.get('width') or W)}</width><height>{int(item.get('height') or H)}</height>"
             f"</samplecharacteristics></video>") if item.get("kind") in ("video", "image") else ""
        a = ("<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>"
             if item.get("has_audio") or item.get("kind") == "audio" else "")
        return (f'<file id="{fid}"><name>{escape(item.get("name") or "")}</name><pathurl>{escape(file_url(item.get("path") or ""))}</pathurl>'
                f"{rate}<duration>{dur}</duration><media>{v}{a}</media></file>")

    # which clips are exported (real footage on real tracks), and their positions per track for links
    vtracks, atracks = tracks_of(project, "video"), tracks_of(project, "audio")
    vtracks = [t for t in vtracks if not t.get("captions")]
    placed = {}         # clip id -> (mediatype, track index, clip index)
    per_track = {}
    for kind, tracks in (("video", vtracks), ("audio", atracks)):
        for ti, tr in enumerate(tracks, 1):
            items = sorted([c for c in clips if c.get("trackId") == tr["id"]], key=lambda c: float(c.get("start") or 0))
            keep = []
            for c in items:
                k = media_kind(project, c)
                if k not in ("video", "audio", "image") or not media.get(c.get("mediaId"), {}).get("path"):
                    skipped += 1
                    continue
                keep.append(c)
                placed[c["id"]] = (kind, ti, len(keep))
            per_track[tr["id"]] = keep
    if skipped:
        notes.add(f"{skipped} title, generator or caption clip{'s' if skipped > 1 else ''} left out (no file behind them)")

    def effects(c, kind):
        fx = []
        speed = float(c.get("speed") or 1)
        if (c.get("keys") or {}).get("speed"):
            notes.add("speed ramps are carried as their average speed")
        if kind == "video" and (abs(speed - 1) > 1e-6 or c.get("reverse")):
            notes.add("speed changes and reversed clips: check them after importing (editors read retiming differently)")
        rev = bool(c.get("reverse"))
        if kind == "video" and (abs(speed - 1) > 1e-6 or rev):
            fx.append("<filter><effect><name>Time Remap</name><effectid>timeremap</effectid><effectcategory>motion</effectcategory>"
                      "<effecttype>motion</effecttype><mediatype>video</mediatype>"
                      "<parameter><parameterid>variablespeed</parameterid><name>variablespeed</name><valuemin>0</valuemin><valuemax>1</valuemax><value>0</value></parameter>"
                      f"<parameter><parameterid>speed</parameterid><name>speed</name><valuemin>-100000</valuemin><valuemax>100000</valuemax><value>{speed * 100 * (-1 if rev else 1):.4f}</value></parameter>"
                      f"<parameter><parameterid>reverse</parameterid><name>reverse</name><value>{'TRUE' if rev else 'FALSE'}</value></parameter>"
                      "<parameter><parameterid>frameblending</parameterid><name>frameblending</name><value>FALSE</value></parameter></effect></filter>")
        if kind == "video":
            op = float(c.get("opacity", 1) if c.get("opacity") is not None else 1)
            if (c.get("keys") or {}).get("opacity"):
                notes.add("opacity keyframes are left out (the clip's base opacity is kept)")
            if op < 0.999:
                fx.append("<filter><effect><name>Opacity</name><effectid>opacity</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype>"
                          f"<mediatype>video</mediatype><parameter><parameterid>opacity</parameterid><name>opacity</name><valuemin>0</valuemin><valuemax>100</valuemax><value>{op * 100:.2f}</value></parameter></effect></filter>")
            if c.get("grade") or c.get("effects") or c.get("mask") or c.get("blend") or c.get("flipH") or c.get("flipV") \
                    or any(abs(float(c.get(k) or 0)) > 1e-6 for k in ("x", "y", "rotation", "cropL", "cropR", "cropT", "cropB")) or abs(float(c.get("scale", 1) or 1) - 1) > 1e-6:
                notes.add("grades, effects, masks, blend modes, flips and position / scale / crop stay in this editor (export a graded master for those)")
        else:
            vol = float(c.get("volume") or 0)
            if (c.get("keys") or {}).get("volume"):
                notes.add("volume keyframes are left out (the clip's base volume is kept)")
            if abs(vol) > 1e-3:
                fx.append("<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory>"
                          "<effecttype>audiolevels</effecttype><mediatype>audio</mediatype>"
                          f"<parameter><parameterid>level</parameterid><name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>{10 ** (vol / 20):.5f}</value></parameter></effect></filter>")
            if c.get("fx"):
                notes.add("audio effects stay in this editor")
        return "".join(fx)

    def clipitem(c, kind):
        item = media[c["mediaId"]]
        start = F(c.get("start") or 0)
        end = start + max(1, F(clip_len(c)))
        a, b = sorted((float(c.get("in") or 0), float(c.get("out") or 0)))
        speed = max(0.01, abs(float(c.get("speed") or 1)))
        file_dur = float(item.get("duration") or 0) or clip_len(c)
        if item.get("kind") == "image":
            a, b, speed = 0.0, clip_len(c), 1.0
        # FCP 7 XML counts a retimed clip's in / out in its retimed frames (out - in is always its length on the
        # timeline), and its duration as the whole file at that speed
        if c.get("reverse") and item.get("kind") != "image":
            a = max(0.0, file_dur - b)
        rin = F(a / speed)
        rout = rin + (end - start)
        links = []
        if c.get("linkId"):
            for o in clips:
                if o.get("linkId") == c["linkId"] and o["id"] in placed:
                    mt, ti, ci = placed[o["id"]]
                    links.append(f"<link><linkclipref>{o['id']}</linkclipref><mediatype>{mt}</mediatype><trackindex>{ti}</trackindex><clipindex>{ci}</clipindex></link>")
        src = f"<sourcetrack><mediatype>{kind}</mediatype><trackindex>1</trackindex></sourcetrack>" if kind == "audio" else ""
        return (f'<clipitem id="{c["id"]}"><name>{escape(c.get("name") or item.get("name") or "")}</name>'
                f"<enabled>{'FALSE' if c.get('disabled') else 'TRUE'}</enabled><duration>{F(file_dur / speed)}</duration>{rate}"
                f"<start>{start}</start><end>{end}</end><in>{rin}</in><out>{rout}</out>"
                f"{file_el(item)}{src}{effects(c, kind)}{''.join(links)}</clipitem>")

    def transitions(track, kind):
        out_t = []
        by_id = {c["id"]: c for c in clips}
        for t in project.get("transitions") or []:
            a, b = by_id.get(t.get("a")), by_id.get(t.get("b"))
            if not a or not b or a.get("trackId") != track["id"] or a["id"] not in placed or b["id"] not in placed:
                continue
            cut = F(float(a.get("start") or 0) + clip_len(a))
            d = max(1, F(t.get("duration") or 1))
            align = t.get("align") or "center"
            s0, s1 = (cut - d // 2, cut - d // 2 + d) if align == "center" else (cut, cut + d) if align == "start" else (cut - d, cut)
            if kind == "video":
                if (t.get("type") or "dissolve") != "dissolve":
                    notes.add("transitions other than dissolves come in as dissolves")
                eff = ("<effect><name>Cross Dissolve</name><effectid>Cross Dissolve</effectid><effectcategory>Dissolve</effectcategory>"
                       "<effecttype>transition</effecttype><mediatype>video</mediatype></effect>")
            else:
                eff = ("<effect><name>Cross Fade (+3dB)</name><effectid>KGAudioTransCrossFade3dB</effectid><effecttype>transition</effecttype>"
                       "<mediatype>audio</mediatype></effect>")
            out_t.append(f"<transitionitem>{rate}<start>{s0}</start><end>{s1}</end><alignment>{align if align in ('start', 'end') else 'center'}</alignment>{eff}</transitionitem>")
        return "".join(out_t)

    def track_el(tr, kind):
        body = "".join(clipitem(c, kind) for c in per_track.get(tr["id"], [])) + transitions(tr, kind)
        lock = "<locked>TRUE</locked>" if tr.get("locked") else ""
        on = "FALSE" if tr.get("hidden") or tr.get("mute") else "TRUE"
        return f"<track>{body}<enabled>{on}</enabled>{lock}</track>"

    ends = [float(c.get("start") or 0) + clip_len(c) for c in clips if c["id"] in placed]
    total = F(max(ends or [0]))
    name = escape(project.get("name") or "Timeline")
    tl_name = next((t.get("name") for t in project.get("timelines") or [] if t.get("id") == project.get("activeTimeline")), None)
    seq_name = f"{name} · {escape(tl_name)}" if tl_name else name
    markers = "".join(f"<marker><name>{escape(m.get('name') or m.get('label') or '')}</name><comment>{escape(m.get('note') or '')}</comment>"
                      f"<in>{F(m.get('time') or 0)}</in><out>-1</out></marker>" for m in project.get("markers") or [])
    out.append('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5">')
    out.append(f'<sequence id="sequence-1"><name>{seq_name}</name><duration>{total}</duration>{rate}'
               f"<timecode>{rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>")
    out.append(f"<media><video><format><samplecharacteristics>{rate}<width>{W}</width><height>{H}</height>"
               "<pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>")
    out.extend(track_el(t, "video") for t in vtracks)
    out.append("</video><audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate>"
               "</samplecharacteristics></format>")
    out.extend(track_el(t, "audio") for t in atracks)
    out.append(f"</audio></media>{markers}</sequence></xmeml>\n")
    if any(t.get("captions") for t in tracks_of(project, "video")):
        notes.add("captions aren't in the XML: use Export SRT in the Captions panel")
    return "".join(out), sorted(notes)


# ---------------------------------------------------------------- EDL
def to_edl(project):
    """CMX 3600 EDL of the main video track with its linked sound. Returns (text, notes)."""
    settings = project.get("settings") or {}
    fps = float(settings.get("fps") or 24)
    base, _ = rate_of(fps)
    media = project.get("media") or {}
    clips = project.get("clips") or []
    primary = next((t for t in tracks_of(project, "video") if not t.get("captions")), None)
    notes = []
    if not primary:
        return "", ["There's no video track"]
    F = lambda sec: float(sec) * fps
    rows = [f"TITLE: {(project.get('name') or 'Timeline')[:60]}", "FCM: NON-DROP FRAME", ""]
    n = 0
    others = len([t for t in tracks_of(project, "video") if not t.get("captions")]) - 1
    for c in sorted([c for c in clips if c.get("trackId") == primary["id"] and not c.get("disabled")], key=lambda c: float(c.get("start") or 0)):
        item = media.get(c.get("mediaId")) or {}
        if item.get("kind") not in ("video", "image") or not item.get("path"):
            continue
        n += 1
        a, _b = sorted((float(c.get("in") or 0), float(c.get("out") or 0)))
        length = clip_len(c)
        if item.get("kind") == "image":
            a = 0.0
        linked = any(o.get("linkId") and o.get("linkId") == c.get("linkId") and o["id"] != c["id"] for o in clips)
        chan = "B   " if linked else "V   "
        rec_in = F(c.get("start") or 0)
        speed = float(c.get("speed") or 1)
        src_len = length * abs(speed)
        rows.append(f"{n:03d}  AX       {chan}  C        {_tc(F(a), base)} {_tc(F(a + src_len), base)} {_tc(rec_in, base)} {_tc(rec_in + F(length), base)}")
        if abs(speed - 1) > 1e-6 or c.get("reverse"):
            rows.append(f"M2   AX       {(-1 if c.get('reverse') else 1) * speed * fps:06.1f}                {_tc(F(a), base)}")
        rows.append(f"* FROM CLIP NAME: {item.get('name') or ''}")
        rows.append(f"* SOURCE FILE: {item.get('path') or ''}")
        rows.append("")
    if others > 0:
        notes.append(f"An EDL holds one track: the {others} video track{'s' if others > 1 else ''} above V1 aren't in it (use the XML for those)")
    if project.get("transitions"):
        notes.append("transitions are left out of the EDL (they're in the XML)")
    return "\n".join(rows) + "\n", notes


# ---------------------------------------------------------------- collect
def used_media_ids(project):
    ids = {c.get("mediaId") for c in project.get("clips") or []}
    for t in project.get("timelines") or []:
        ids |= {c.get("mediaId") for c in (t.get("data") or {}).get("clips") or []}
    media = project.get("media") or {}
    return [i for i in ids if i in media and media[i].get("path") and not media[i].get("generator")]


def used_luts(project):
    names = set()
    def scan(clips):
        for c in clips or []:
            lut = (c.get("grade") or {}).get("lut")
            if lut:
                names.add(lut)
    scan(project.get("clips"))
    for t in project.get("timelines") or []:
        scan((t.get("data") or {}).get("clips"))
    return sorted(names)


def collect(project, luts_dir, out_zip, progress=lambda f, msg: None, cancelled=lambda: False):
    """One ZIP: project.json (paths pointing into media/), media/ with every file the project uses, luts/ with its
    LUTs. Files are stored as they are (video doesn't compress). Returns {files, bytes, missing}."""
    media = project.get("media") or {}
    ids = used_media_ids(project)
    names, missing, plan = set(), [], []
    for mid in ids:
        path = media[mid]["path"]
        if not os.path.isfile(path):
            missing.append(media[mid].get("name") or path)
            continue
        base, ext = os.path.splitext(os.path.basename(path))
        name, k = base + ext, 1
        while name.lower() in names:
            k += 1
            name = f"{base}_{k}{ext}"
        names.add(name.lower())
        plan.append((mid, path, f"media/{name}"))
    total = sum(os.path.getsize(p) for _, p, _ in plan) or 1
    copy = json.loads(json.dumps(project))
    for mid, _, arc in plan:
        copy["media"][mid]["path"] = arc
        copy["media"][mid]["collected"] = True
    copy["collected"] = {"from": project.get("name"), "files": len(plan)}
    done = 0
    tmp = out_zip + ".part"
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as z:
        z.writestr("project.json", json.dumps(copy, indent=1))
        for lut in used_luts(project):
            p = os.path.join(luts_dir, lut + ".cube")
            if os.path.isfile(p):
                z.write(p, f"luts/{lut}.cube")
        for mid, path, arc in plan:
            if cancelled():
                raise RuntimeError("cancelled")
            progress(done / total, f"Adding {os.path.basename(path)}")
            with open(path, "rb") as src, z.open(zipfile.ZipInfo.from_file(path, arc), "w", force_zip64=True) as dst:
                while True:
                    chunk = src.read(8 * 1024 * 1024)
                    if not chunk:
                        break
                    dst.write(chunk)
                    done += len(chunk)
                    progress(done / total, f"Adding {os.path.basename(path)}")
    os.replace(tmp, out_zip)
    return {"files": len(plan), "bytes": done, "missing": missing}


def open_collected(zip_path, dest_dir, luts_dir):
    """Unpack a collected ZIP into dest_dir and return its project with every media path pointing at the unpacked
    files (the caller relinks them under their ids and saves the project)."""
    with zipfile.ZipFile(zip_path) as z:
        if "project.json" not in z.namelist():
            raise ValueError("That ZIP isn't a collected project (no project.json in it)")
        project = json.loads(z.read("project.json").decode("utf-8"))
        root = os.path.abspath(dest_dir)
        for info in z.infolist():
            target = os.path.abspath(os.path.join(root, info.filename))
            if not target.startswith(root + os.sep) and target != root:
                raise ValueError(f"Unsafe path in the ZIP: {info.filename}")
            if info.filename.startswith("luts/") and info.filename.lower().endswith(".cube"):
                lut_target = os.path.join(luts_dir, os.path.basename(info.filename))
                if not os.path.exists(lut_target):
                    with z.open(info) as src, open(lut_target, "wb") as dst:
                        dst.write(src.read())
                continue
            if info.filename == "project.json" or info.is_dir():
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(info) as src, open(target, "wb") as dst:
                while True:
                    chunk = src.read(8 * 1024 * 1024)
                    if not chunk:
                        break
                    dst.write(chunk)
    for mid, item in (project.get("media") or {}).items():
        if item.get("collected") and item.get("path"):
            item["path"] = os.path.join(root, item["path"].replace("/", os.sep))
            item.pop("collected", None)
            item.pop("missing", None)
    project.pop("collected", None)
    return project
