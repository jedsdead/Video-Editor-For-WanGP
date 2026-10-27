# Video Editor for WanGP

A multi-track video editor that runs as a plugin inside [WanGP](https://github.com/deepbeepmeep/Wan2GP), in its own tab. Cut your generations together, grade them, mix the audio and export, without leaving WanGP.

**Version 0.2** · by jedsdeadbaby · MIT licence

## Features

**Timeline**
- Any number of video and audio tracks. A video's audio is linked to it and moves with it (toggle **Link**, or Alt-drag an edge to trim one side only).
- **Magnetic mode (M):** V1 is the main storyline. It closes gaps and pushes clips aside, and clips on the tracks above connect to the V1 clip under them and move with it. Turn it off for free placement, where dropped clips overwrite what's underneath.
- **Select (V)**, **Blade (B)** (Shift-click cuts every track) and **Range (R)** tools. In a range, Del removes it and Shift+Del ripples the rest of the timeline up.
- Snapping (S), marquee and Ctrl/Shift multi-select, copy and paste, in/out points, and full undo and redo.

**Keyframes**
- Keyframe volume, opacity, scale, position and speed. Each keyframe eases to the next with Linear, Ease in, Ease out, S-curve, Fast start, Slow start or Hold.
- Clips show a line for one property (volume on audio, opacity on video; right-click a clip > *Show keyframes for* to switch). Select the clip, then Ctrl+click the line to add a keyframe, drag points to move them, drag the line to raise or lower a section, and right-click a point for its ease or to delete it.
- In the Inspector, ◆ adds or removes a keyframe at the playhead and ◀ ▶ jump between them. Once a property has keyframes, changing it adds one automatically.
- Fades have shapes too: right-click a fade handle, or use the Inspector.

**Speed**
- A constant speed, or a speed curve with keyframes that can go anywhere from 0% (a freeze frame) to 1000%. Presets: *Ramp to stop*, *Ease to slow-mo* and *Speed up*, starting at the playhead. A graph in the Inspector shows the curve.
- Ramps keep the clip's length and change how much of the source it uses. Linked audio follows the same curve.
- In-between frames on export: nearest frame, frame blend, or optical flow using WanGP's built-in RIFE v4.26 model. This also smooths 16 fps WanGP clips in a 24 or 30 fps project.

**Transitions**
- **Dissolve:** cross, film, additive, non-additive, dip to colour.
- **Wipe** and **Slide / Push** at any angle, diagonals included.
- **Iris:** circle, oval, diamond, square, cross (+), X, triangle, each reversible.
- **Clock wipe**, **Venetian blinds** and **Barn door**.
- Every edge-based transition has **Feather**, or a hard edge with a coloured **Border**.
- Three audio crossfades: equal power, linear, dip.

**Colour and scopes**
- Lift, gamma and gain wheels with master sliders, plus exposure, contrast, saturation, temperature and tint.
- Bypass, and copy and paste a grade between clips.
- Waveform, RGB parade, vectorscope and histogram.

**Audio**
- A mixer with fader, pan, mute, solo and stereo meters for each track, plus a master bus.
- Clip volume and fade handles.

**WanGP integration**
- Browse WanGP's output folders and import files in place, with nothing copied.
- Clips that WanGP generated show their prompt, seed and settings in the Inspector.

**Export**
- H.264, H.265, H.264 NVENC or ProRes 422 HQ, at any resolution and frame rate.
- The whole timeline, in/out points or a range selection.
- Rendered on the GPU from the original files.

**Layout**
- Media, Transitions, Inspector, Colour, Scopes and Mixer panels can each be moved to the left, right or bottom dock, or hidden.
- Use the **View** menu or right-click a panel tab. The layout is remembered.

## Installation

1. Close WanGP.
2. Put this repository in WanGP's `plugins` folder as `wan2gp-video-editor`:
   ```
   cd Wan2GP/plugins
   git clone https://github.com/jedsdead/Video-Editor-For-WanGP wan2gp-video-editor
   ```
   Or download the ZIP and extract it so the files sit in `Wan2GP/plugins/wan2gp-video-editor/`. `plugin.py` must be directly inside that folder.
3. Start WanGP, open the **Plugins** tab, enable **Video Editor** and restart WanGP.
4. A **Video Editor** tab appears.

There's nothing extra to install, because the plugin uses the FFmpeg, PyTorch and FastAPI that come with WanGP. Optical-flow speed changes use the RIFE model that WanGP downloads the first time you use RIFE temporal upsampling.

## Using it

1. Use **Import files** or **Browse outputs…** in the Media panel to bring in clips.
2. Drag clips onto the timeline, or double-click one to add it to the end.
3. Edit with the tools. Select a clip or transition to change it in the Inspector.
4. Click **Export**.

The first video you add sets the project's resolution and frame rate. You can change them later in File → Project settings.

Projects save automatically. **Help → Keyboard shortcuts** lists every key.

### Main shortcuts

| Key | Action |
|---|---|
| Space / J K L | Play-pause, back, pause, play |
| ← → / ↑ ↓ | Previous or next frame / edit point |
| V B R | Select, Blade, Range tool |
| S / M | Snapping / Magnetic timeline |
| Ctrl+B | Split at the playhead |
| Del / Shift+Del | Delete / ripple delete |
| I / O | Mark in / out |
| Ctrl+T | Transition at the cut under the playhead |
| Ctrl+Alt+C / V | Copy / paste a grade |
| Ctrl+E | Export |

## Where files go

Everything is stored in `<WanGP output folder>/video_editor/`:

| Folder | Contents |
|---|---|
| `projects/` | Saved projects (JSON) |
| `exports/` | Finished exports |
| `media/` | Files you uploaded with *Import files* |
| `cache/` | Preview proxies, thumbnails and waveforms; safe to delete |

## How it works

The editor is a web page served by WanGP through the plugin web-app API and shown inside the tab. The viewer composites clips with WebGL from lightweight 540p proxies. Export re-renders every frame from the original files with PyTorch, on the GPU when available, using the same colour, transition and speed maths, so the export matches what you saw.

## Roadmap

- **Regenerate a shot:** pick a clip and regenerate it in WanGP from its saved prompt and settings, then drop the result back in place.
- Track-level volume automation, keyframed colour, LUT import, titles.

## Licence

MIT. See [LICENSE](LICENSE).
