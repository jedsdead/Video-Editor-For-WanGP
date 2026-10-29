# Video Editor for WanGP

A multi-track video editor that runs as a plugin inside [WanGP](https://github.com/deepbeepmeep/Wan2GP), in its own tab. Cut your generations together, grade them, mix the audio and export, without leaving WanGP.

**Version 1.0.2** · by jedsdeadbaby · MIT licence

## Features

**Timeline**
- Any number of video and audio tracks. A video's audio is linked to it and moves with it (toggle **Link**, or Alt-drag an edge to trim one side only).
- **Magnetic mode (M):** V1 is the main storyline. It closes gaps and pushes clips aside, and clips on the tracks above connect to the V1 clip under them and move with it. Turn it off for free placement, where dropped clips overwrite what's underneath.
- **Select (V)**, **Blade (B)** (Shift-click cuts every track) and **Range (R)** tools. In a range, Del removes it and Shift+Del ripples the rest of the timeline up.
- Snapping (S), marquee and Ctrl/Shift multi-select, copy and paste, in/out points, and full undo and redo.
- **Compound clips:** right-click selected clips (on one video track, with their linked audio) → **Make compound clip**. They then act as one clip: they move and trim together, and the compound has its own opacity, transform, fades, colour grade and effects, applied on top of the clips' own. Nothing is re-encoded: double-click to open it and edit, trim, switch takes or regenerate the clips inside, then right-click → **Close compound clip**. **Break apart** puts the clips back as they were.
- **Markers (Shift+M):** named, coloured markers on the ruler and in a Markers panel. Drag to move, double-click to rename; ↑/↓ and snapping include them.
- **Shuttle (J/K/L):** play backwards or forwards, pressing again for 2x, 4x and 8x. Audio scrubbing plays a short burst as you drag the playhead or step frames.
- **Freeze frame (Shift+F)** inserts a held frame at the playhead, and **Reverse (Shift+R)** plays clips backwards (with their audio).
- **Shot detection (Shift+D, or right-click a clip):** finds the cuts inside a clip and splits it into shots after you review them. For WanGP generations whose prompt has a shot list (`[/duration=…]` windows with `[Shot N] At mm:ss`), each detected cut is matched to the shot that asked for it, and every piece carries its shot text into the Inspector, ready for regeneration later.

**Keyframes**
- Keyframe volume, opacity, scale, position, rotation, crop, speed and the colour grade. Each keyframe eases to the next with Linear, Ease in, Ease out, S-curve, Fast start, Slow start or Hold.
- Clips show a line for one property (volume on audio, opacity on video; right-click a clip > *Show keyframes for* to switch). Select the clip, then Ctrl+click the line to add a keyframe, drag points to move them, drag the line to raise or lower a section, and right-click a point for its ease or to delete it.
- In the Inspector, ◆ adds or removes a keyframe at the playhead and ◀ ▶ jump between them. Once a property has keyframes, changing it adds one automatically.
- Fades have shapes too: right-click a fade handle, or use the Inspector.

**Transform**
- Position, scale, rotation and crop for every video clip, all keyframeable.
- Handles on the viewer: drag to move, corners to scale, the knob to rotate (Shift snaps to 15°), and crop mode (C) for edge handles. Clicking in the viewer selects the clip under the pointer.

**Effects panel**
- **Generators:** drag onto a video track, or double-click to add at the playhead on the top track (a new track is added if that one is busy).
  - **Title** (also Shift+T)
  - **Solid colour** and **Gradient** (two colours at any angle)
  - **Adjustment layer:** its colour grade and effects apply to everything on the tracks below it for as long as it lasts, with opacity and fades to mix it in.
- **Video effects:** Blur, Sharpen, Vignette, Film grain, Black & white, Chroma key (with spill removal), Flip, Pixelate, Chromatic aberration and Letterbox (2.76, 2.39, 2, 1.85, 16:9, 4:3 or 1:1, any bar colour).
  - Drag an effect onto a clip, or click it to add it to the selected clips.
  - In the Inspector, effects stack in order after the colour grade: switch each on or off, move it up or down, reset or remove it. Every slider keyframes with ◆.
  - Right-click a clip to copy, paste or remove its effects.

**Titles**
- Drag the **Title** generator from the Effects panel (or press Shift+T). Set the text, font, size, bold and italic, colour, alignment, line height, outline, drop shadow and background box in the Inspector, and animate it with the transform keyframes.

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
- A transition can be centred on its cut, end at it or start at it (Inspector → Position).
- Three audio crossfades: equal power, linear, dip.

**Colour and scopes**
- Two wheel styles per clip:
  - **Lift / Gamma / Gain** (Resolve-style primaries) with master sliders.
  - **Shadows / Midtones / Highlights** (Final Cut style): a Master wheel plus one per tonal range, each with its own colour, brightness and saturation, and adjustable range boundaries.
  Each clip keeps the values of both styles, and only the selected style is applied, so switching loses nothing.
- Exposure, contrast, saturation, temperature and tint.
- **LUTs:** import `.cube` 3D LUTs and apply one per clip with a mix amount.
- **Grade keyframes:** ◆ in the Colour panel keys the whole grade at the playhead, with an ease to the next keyframe.
- Bypass, and copy and paste a grade between clips.
- Waveform, RGB parade, vectorscope and histogram.

**Audio**
- A mixer with fader, pan, mute, solo and stereo meters for each track, plus a master bus.
- **EQ and compressor** on every track and the master (FX button): low shelf, mid peak and high shelf, plus threshold, ratio, attack, release and makeup, with a gain-reduction meter.
- **Track volume automation:** press **A** on an audio track header to show a volume line across the whole track, then Ctrl+click to add points.
- **Loudness meter** on the master (EBU R128 momentary, short-term and integrated LUFS).
- Clip volume keyframes and fade handles.

**Regenerate shots**
- Right-click a WanGP clip or shot: **Re-generate shot with new seed**, **with same seed**, or **Regenerate / extend shot**, also in the Inspector.
- **Settings:** the clip's own saved settings, or the Media Generator's current settings (the model and settings in the Video Generator tab when you last switched to the editor).
- **Prompt:** built for the shot from the original prompt. It keeps the subject definitions and other sections and uses only that shot's text, renumbered as Shot 1 and retimed to start at 00:00. You can edit it before queuing.
- **Start / end image:** none, the shot's own first frame, the previous shot's last frame, or the next shot's first frame (when the model supports them).
- **Audio:** keep the shot's audio, so dialogue stays identical and the new picture lip-syncs to it, or generate new audio.
- **Length:** the shot's length (shots shorter than the model's minimum are generated at the minimum and trimmed) or longer. **Extend** continues the shot from its last frames.
- Regenerations join WanGP's main queue, so they show in its queue and progress bar. Progress shows on the clip and in the Inspector.
- **Takes:** each result is added as a take on its clip, with the original kept as take 1. Switch takes in the Inspector or the clip menu. A take with new audio switches the linked audio too.
- The same seed gives a new result, not the original shot, because the prompt and length differ.

**Generate on the timeline (MiniMax H3)**
- Right-click empty space on a video track → **Generate a new shot here**: a shot from scratch with the Media Generator's settings (or a neighbouring clip's), so a sequence can be built on a blank timeline. Its length can run past one window; WanGP's sliding windows handle it. Reroll it for a new take.
- Right-click a clip → **Generate**: **Extend** (continue out of it), **Prepend** (run into it), **Bridge** (join it to the next clip), **Replace** (regenerate it so it joins both neighbours, as a new take) and **Loop** (end where the edit began). Right-click empty space on a video track for **Fill gap with a generation**.
- **Continuing out of a clip** uses **Motion + masked** by default (below), then Masked + keyframes. Plain **motion context**: its last 17, 34 or 51 frames are handed to H3 as history, the way Wan2GP continues a sliding window (and Latent Carry carries latents), so the run starts at the cut. **Pinned frames inside the run** is the alternative: the frames are regenerated inside the run and trimmed off.
- **Running into a clip** (Prepend, Bridge, Fill, Replace) holds the next clip's first 22, 39 or 56 frames at the end of the run and trims them off, so the new footage arrives exactly on them. Pins can carry their audio too.
- **Masked joins** (the default for arriving; with keyframes, the second choice for leaving): the neighbour's frames are held inside the run by a denoise mask, using WanGP's own Denoise Control Video edit, so H3 never re-draws them and the join has a single rendering. With saved latents the held frames are the neighbour's own latents, and the cut hands over a few frames inside the window, where both files decode identically. **Masked + keyframes** also gives H3 the frames as keyframes to steer toward. Masked joins need a model with Denoise Control Video and a video mask (Ref2VA has both), settings that don't already use a reference or control video, phase 2 tiling off, and an attention mode other than Sol (WanGP's Grouped Rows masking). Otherwise the dialog falls back to pinned keyframes and says why.
- **Motion + masked** (the recommended way to leave a clip): both at once. The earlier part of the clip's tail (17, 34 or 51 frames) goes to H3 as motion-context history, and its last 22 frames are held inside the run by the mask, so the motion carries on and the cut falls inside a single rendering. The held frames' sound is held too, with the history's sound before it. Without masking it falls back to plain motion context.
- **Latent grade:** the editor installs a small add-on into WanGP that saves each H3 generation's latents beside the video. Pins taken from those latents skip a decode/encode round trip, for the cleanest joins. That needs the cut on H3's 17-frame grid, so a cut may move by up to 16 frames; tick **Keep my exact cuts** to use pixel grade instead. If **H3 Latent Carry** is installed, the latents it saves with each video (the last 56 frames) are used too, so extending a clip from its end gets latent grade even for videos made before the editor's add-on. Clips without saved latents from either use pixel grade.
- **Join match** (on by default): a generated clip often opens at a slightly different exposure or colour balance from the clip it continues. The editor measures each generated join and corrects the new clip with a per-channel gain that is strongest at the join and fades out over about half a second (and the mirror image where a run arrives on a clip). Joins whose frames are held exactly by a mask need nothing and are left alone. Toggle it per clip in the Inspector.
- **Blend the joins** (pinned frames inside the run): the new clip's own rendering of the neighbour's frames is crossfaded with the neighbour, so the switch between the two renderings is gradual. The crossfades are ordinary transitions positioned to end (or start) at the cut, so you can change or delete them.
- **Seam verdicts:** each join is rated seamless, soft bump or hard cut, shown as coloured bars on the timeline and in the Inspector, with ▶ buttons to play across a join.
- **Takes and lineage:** generating the same slot again (or **Reroll**) adds a take. Generated clips show what they came from. Each take remembers where it cut its neighbours (join modes and latent grade can move a cut), so switching takes puts the neighbouring cuts back where that take joins them.
- **Live preview** of the generation in the Inspector while WanGP works.
- **View → Snap cuts to H3's 17-frame grid** keeps splits and trims of WanGP clips on the grid.
- Saved latents are kept up to 20 GB, oldest removed first. WanGP must be restarted once after installing or updating the editor so the add-on loads.

**Inspector**
- Click a section heading, or an effect's name, to fold it away. Alt+click folds or unfolds every section. Folded sections are remembered.

**WanGP integration**
- Browse WanGP's output folders and import files in place, with nothing copied.
- Clips that WanGP generated show their prompt, seed and settings in the Inspector, and after shot detection, each shot's own text.

**Export**
- H.264, H.265 or ProRes 422 HQ, at any resolution and frame rate. Fast hardware H.264 / H.265 (NVIDIA NVENC, AMD AMF, Intel Quick Sync, VAAPI on Linux, Apple VideoToolbox) is offered when a test encode shows it works on your machine.
- **Audio only** (WAV, MP3 or AAC) and **still frame** (PNG or JPEG at the playhead).
- **Loudness normalisation** to -14, -16, -23 or -24 LUFS with a -1 dBFS peak limiter. Every export reports its measured loudness.
- The whole timeline, in/out points or a range selection.
- Rendered on the GPU from the original files.
- **De-click:** hard audio cuts get a 5 ms taper either side so the waveform never jumps; joins where the audio carries straight on, or a transition covers the cut, are left alone.

**Layout**
- Media, Transitions, Effects, Markers, Inspector, Colour, Scopes and Mixer panels can each be moved to the left, right or bottom dock, **floated** as a movable, resizable window, or hidden.
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
| Space | Play / pause |
| J / K / L | Shuttle back / stop / forward (again for 2x, 4x, 8x) |
| ← → / ↑ ↓ | Previous or next frame / edit point |
| V B R | Select, Blade, Range tool |
| S / M | Snapping / Magnetic timeline |
| Ctrl+B | Split at the playhead |
| Del / Shift+Del | Delete / ripple delete |
| I / O | Mark in / out |
| Ctrl+T | Transition at the cut under the playhead |
| Ctrl+Alt+C / V | Copy / paste a grade |
| Shift+M / Shift+F / Shift+R / Shift+T | Marker / freeze frame / reverse / title |
| C | Crop handles on the viewer |
| Ctrl+E | Export |

## Where files go

Everything is stored in `<WanGP output folder>/video_editor/`:

| Folder | Contents |
|---|---|
| `projects/` | Saved projects (JSON) |
| `exports/` | Finished exports |
| `media/` | Files you uploaded with *Import files* |
| `luts/` | Imported `.cube` LUTs |
| `cache/` | Preview proxies (including reversed ones), thumbnails and waveforms; safe to delete |

## How it works

The editor is a web page served by WanGP through the plugin web-app API and shown inside the tab. The viewer composites clips with WebGL from lightweight 540p proxies. Export re-renders every frame from the original files with PyTorch, on the GPU when available, using the same colour, transition and speed maths, so the export matches what you saw.

## Roadmap

- Multicam editing, nested sequences, audio noise reduction.

## Licence

MIT. See [LICENSE](LICENSE).

## Attributions

The timeline generation features were inspired by [comfyui-obvpm-timeline](https://github.com/chanon/comfyui-obvpm-timeline) by chanon, a timeline for MiniMax H3 in ComfyUI. Its design and published findings shaped the ideas behind extending, prepending, bridging and filling with pinned frames, masked joins and handing over inside the held window, seam ratings, takes and lineage, crossfading a join across the frames both sides rendered, correcting exposure at joins, and de-clicking hard audio cuts. Thank you for sharing that work.

No code from that project is included here. The Video Editor's implementations were written independently for WanGP: masked joins use WanGP's own Denoise Control Video masking, and Join match is its own method.
