# Video Editor for WanGP

A multi-track video editor that runs as a plugin inside [WanGP](https://github.com/deepbeepmeep/Wan2GP), in its own tab. Cut your generations together, grade them, mix the audio and export, without leaving WanGP.

**Version 3.0.1** · by jedsdeadbaby · MIT licence

## Features

**Timeline**
- Any number of video and audio tracks. A video's audio is linked to it and moves with it (toggle **Link**, or Alt-drag an edge to trim one side only).
- **Magnetic mode (M):** V1 is the main storyline. It closes gaps and pushes clips aside, and clips on the tracks above connect to the V1 clip under them and move with it. Turn it off for free placement, where dropped clips overwrite what's underneath.
- **Select (V)**, **Blade (B)** (Shift-click cuts every track), **Trim (T)** and **Range (R)** tools, with Snap, Magnetic and Link, sit in the timeline's own toolbar beside the zoom.
- **Trim tool (T):** drag a cut between two touching clips to **roll** it (one gets longer as the other gets shorter, nothing else moves); drag a clip's edge to **ripple-trim** it (everything after it moves up or along, on every track); drag the middle of a clip to **slip** it (a different part of its footage in the same place and length), or Alt-drag to **slide** it between its neighbours. A label shows the new timing; Alt on an edge leaves the linked clip alone.
- **Q / W** ripple-trim the clip under the playhead so it starts or ends there (the selected clips if they're under it). **Alt+← / →** nudges the selected clips a frame (Shift: 10 frames).
- **Turn a clip off (Shift+E):** it stays on the timeline, dimmed and hatched, but doesn't play or export. **Clip colours** (right-click → Clip colour) tint a clip and its linked sound. **Replace with…** swaps a clip's footage for the media bin's selected item, keeping its place, length, grade, effects and keyframes. **Unlink (Ctrl+L)** detaches a video's sound for good.
- **Timelines:** a project can hold several timelines (alternate cuts) sharing its media and settings. Switch with the menu at the left of the timeline toolbar; ⋯ makes a new empty one, duplicates the current one, renames or deletes. Switching is undoable. In a range, Del removes it and Shift+Del ripples the rest of the timeline up.
- Snapping (S), marquee and Ctrl/Shift multi-select, copy and paste, in/out points, and full undo and redo.
- **Compound clips:** right-click selected clips (on one video track, with their linked audio) → **Make compound clip**. They then act as one clip: they move and trim together, and the compound has its own opacity, transform, fades, colour grade and effects, applied on top of the clips' own. Nothing is re-encoded: double-click to open it and edit, trim, switch takes or regenerate the clips inside, then right-click → **Close compound clip**. **Break apart** puts the clips back as they were.
- **Markers (Shift+M):** named, coloured markers on the ruler and in a Markers panel. Drag to move, double-click to rename; ↑/↓ and snapping include them.
- **Shuttle (J/K/L):** play backwards or forwards, pressing again for 2x, 4x and 8x. Audio scrubbing plays a short burst as you drag the playhead or step frames.
- **Freeze frame (Shift+F)** inserts a held frame at the playhead, and **Reverse (Shift+R)** plays clips backwards (with their audio).
- **Shot detection (Shift+D, or right-click a clip):** finds the cuts inside a clip and splits it into shots after you review them. For WanGP generations whose prompt has a shot list (`[/duration=…]` windows with `[Shot N] At mm:ss`), each detected cut is matched to the shot that asked for it, and every piece carries its shot text into the Inspector, ready for regeneration later.
- **Insert gap at playhead** (Edit menu): opens a gap of any length at the playhead across the unlocked tracks, splitting clips that span it and moving everything after it along, markers and in / out points too. **Close the loop** (right-click a clip → Generate → Loop) generates a shot that joins a clip's end back to its start.

**Keyframes**
- Keyframe volume, opacity, scale, position, rotation, crop, speed and the colour grade. Each keyframe eases to the next with Linear, Ease in, Ease out, S-curve, Fast start, Slow start or Hold.
- Clips show a line for one property (volume on audio, opacity on video; right-click a clip > *Show keyframes for* to switch). Select the clip, then Ctrl+click the line to add a keyframe, drag points to move them, drag the line to raise or lower a section, and right-click a point for its ease or to delete it.
- In the Inspector, ◆ adds or removes a keyframe at the playhead and ◀ ▶ jump between them. Once a property has keyframes, changing it adds one automatically.
- Fades have shapes too: right-click a fade handle, or use the Inspector.

**Transform**
- Position, scale, rotation and crop for every video clip, all keyframeable. **Scale X** and **Scale Y** stretch each axis on its own, with one-click **Fit**, **Fill**, **Stretch**, **Fill width**, **Fill height**, **Full size** (the clip's own pixels, one per project pixel) and **Anamorphic** desqueeze (1.25× to 2×). **Flip horizontal** and **Flip vertical** mirror a clip (after its effects, so crops stay on the sides you see).
- The viewer shows the frame at **Fit** or at 25% to 400% of the project's resolution (scroll when it's bigger), from the menu under the frame. **Full screen** keeps the transport, so you can play and leave without the keyboard.
- When the side panels are dragged wider, the viewer's controls shrink to fit (then wrap onto two rows) instead of disappearing behind them, and the viewer never gets narrower than 300 px.
- **Lock the aspect ratio** in the project settings to change width and height together. Its presets are standard delivery sizes: 16:9 up to 4K UHD, DCI 4K, 2.40:1 scope (1280 × 534 to 4096 × 1716), 21:9, vertical and square.
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

**Pages**
- **Full screen editor:** the button at the top right fills the screen with the editor (WanGP's own Full Screen, as Showrunner has; in a browser on its own, the browser's full screen). Click it again to go back.
- A **scrub bar** under the viewer when the timeline isn't on screen: in the viewer's full screen and on the Colour page. It shows the shots, markers and in / out range; click or drag to move the playhead.
- Three pages, as in Resolve: **Edit** (Shift+4), **Colour** (Shift+6) and **Audio** (Shift+7), switched with the buttons in the top bar. They share the project, viewer and playback; each page remembers its own panel layout.
- **Colour page:** a **Shots** strip of every shot on the timeline in order. Click a shot to grade it (it shows in the viewer), Ctrl/Shift+click to pick several. The wheels, sliders, curves, shot match and LUT sit side by side under it, with the scopes beside the viewer. Right-click a shot to **match the selected shots' colour to it**, copy its grade to them, or reset a grade. The Colour panel still works on the Edit page.
- **Audio page:** the timeline with a wide mixer beside it, the audio effects in the Effects panel, the Inspector for clip effects, and an **Analyser**: the master spectrum with peak hold, loudness over the last 30 seconds (momentary and short-term LUFS) and a stereo phase and balance meter.

**Audio effects**
- **Sound:** reverb, echo / delay, pitch shift (same speed), distortion.
- **EQ and filters:** bass / treble EQ, a ten-band **graphic EQ** (31 Hz to 16 kHz), **parametric EQ**, low cut, high cut, **band pass**, **notch** and an **auto filter** (a sweeping low-pass, auto-wah).
- **Dynamics:** **compressor** (threshold, ratio, attack, release, knee, makeup) and **limiter** (input gain, ceiling, release).
- **Modulation:** **chorus**, **flanger**, **phaser**, **tremolo**, **vibrato**, **auto pan** and **ring modulator**.
- Drag one from the Effects panel onto an audio clip, click it to add it to the selected audio clips, or use **Add audio effect** in the Inspector, where they can be switched on and off, reordered, reset and removed. Whole tracks and the master bus also have an EQ and compressor under the mixer's **FX** buttons.
- EQ and filter effects show their **curve over a live spectrum** of the clip (dim: before its effects, bright: after). Drag the points: graphic EQ bands up and down, the parametric EQ anywhere (scroll for its width), the shelves up and down, the cut, band and notch frequencies left and right. Double-click a band to flatten it.
- They play in the viewer and render the same on export (the same filters, impulse responses, pitch shifter and compressor), before the clip's volume and fades. Modulation effects start their sweep at the clip's start on export; in the viewer the sweep runs freely, so its position can differ.

**Blend modes and masks** (Inspector → Blend & mask)
- **Blend modes:** Normal, Multiply, Screen, Overlay, Add, Darken, Lighten, Difference and Soft light mix a clip with the tracks below it (for light leaks, smoke, overlays).
- **Masks:** a rectangle or ellipse on any video clip, with centre, width, height, feather and invert. It's set on the clip's own picture, so it moves and scales with the clip (and mirrors with a flip). Applied before the clip's effects.
- **Picture in picture:** one-click corners (or the centre) at 25%, 33% or 50%, in the Inspector beside Fit.
- **Stabilise** (right-click a video clip): makes a stabilised copy of the clip's file in the background (ffmpeg's two-pass vidstab, or deshake when vidstab isn't there), Light, Medium or Strong, zoomed to hide the moving edges or not, and puts it in the clip, keeping its timing, grade, effects and WanGP lineage. Undo puts the original back. Copies go in `video_editor/stabilised`.

**Captions** (Captions panel, or Edit → Captions)
- Each caption is a title on a **Captions** track at the top of the timeline, so it shows in the viewer, burns into the export and moves and trims like any clip. Type them in the panel; click a time to go to one.
- **Draft from prompts:** makes captions from the dialogue in the WanGP prompts of the clips on the timeline (the `<d>…</d>` lines, at their `At mm:ss` times, window by window), long enough to read and not past the next line.
- **Transcribe speech…:** listens to the audio tracks you pick with WanGP's own Whisper (the model Deepy and the dialogue models use, set in Configuration > Extensions; Medium or Large-v3 can be picked too) and makes captions timed to the words, broken at pauses and sentence ends, two lines at most. The same take on two tracks is only captioned once, and an in / out range can limit it. It waits for any generation that's running (both use the GPU) and caches what it heard, so redoing it is quick.
- **Style…** sets the font, size, colour, background box, outline and height for every caption. **Import SRT** and **Export SRT**. Untick **Show captions** to leave them out of the viewer and the export (an SRT export still works).

**Titles**
- Drag the **Title** generator from the Effects panel (or press Shift+T). Set the text, font, size, bold and italic, colour, alignment, line height, outline, drop shadow and background box in the Inspector, and animate it with the transform keyframes.

**Speed**
- A constant speed, or a speed curve with keyframes that can go anywhere from 0% (a freeze frame) to 1000%. Presets: *Ramp to stop*, *Ease to slow-mo* and *Speed up*, starting at the playhead. A graph in the Inspector shows the curve.
- Ramps keep the clip's length and change how much of the source it uses. Linked audio follows the same curve.
- In-between frames on export: nearest frame, frame blend, or optical flow using WanGP's built-in RIFE v4.26 model. This also smooths 16 fps WanGP clips in a 24 or 30 fps project.

**Panels**
- The Effects and Transitions panels' groups (generators, video effects, each family of audio effects) fold away: click a heading, Alt+click to fold or unfold them all. What's folded is remembered.

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
- **Curves:** custom curves (master, red, green and blue) and **Hue vs Hue**, **Hue vs Sat**, **Hue vs Lum**, **Lum vs Sat** and **Sat vs Sat**. Click to add a point, drag it, double-click or right-click to remove it; the hue curves have quick R / Y / G / C / B / M points. Curves come after the wheels and sliders and before the LUT, and render the same on export.
- **Colour picker (⌖):** pick a colour in the viewer. On the curves it adds a point at the picked colour (its hue, saturation, luminance or channel value, as the curves see it: after the wheels, before the curves) with a point either side, **Range** apart, so only that range moves. Every colour field (titles, solids, borders, dips) has one too.
- **White balance:** **Auto** evens out the frame's average colour at the playhead (ignoring clipped and near-black pixels); **Pick neutral** makes something grey or white in the picture truly neutral. Per-channel gains before the rest of the grade, with On and Reset.
- **Shot match:** from the Colour page, a per-channel correction that brings a shot's colour and contrast to another shot's (measured over three frames of each, as graded). It sits after the grade and LUT, and can be switched off or cleared in the Colour panel.
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
- **Normalise loudness** (right-click → Audio, or Edit menu): sets each selected clip's volume so its own sound reaches -14, -16 or -23 LUFS (peaks kept under -1 dBFS) or a peak of -1 or -3 dBFS. Volume keyframes keep their shape.
- **Duck under dialogue** (right-click an audio clip → Audio): lowers the selected clips (music, say) while someone speaks on the other audio tracks, with volume keyframes you can adjust: duck amount, fade down before the speech, fade back up after it, and how readily it counts something as speech.

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
- **Start / end images:** where nothing is pinned on that side, a generation can start from or end on a picture: a new shot takes both, an Extend can end on one, a Prepend can start from one. Pick the picture at the playhead, an image in the media bin, a video's first or last frame, or choose or drop an image file. They become WanGP's `image_start` / `image_end` (the models that take them: H3 FL2VA and Ref2VA), and count as the generation's own pictures in the prompt: the start image is <Picture 1>, the end image next, and RefMod pictures move up after them.
- **Sound switches** (in the generate dialog): no music, nobody speaks, ambience only, no sound effects. They rewrite the prompt's `<non_diegetic_music>` and `<overall_soundscape>` sections (or add a line) for that run.
- **Running into a clip** (Prepend, Bridge, Fill, Replace) holds the next clip's first 22, 39 or 56 frames at the end of the run and trims them off, so the new footage arrives exactly on them. Pins can carry their audio too.
- **Masked joins** (the default for arriving; with keyframes, the second choice for leaving): the neighbour's frames are held inside the run by a denoise mask, using WanGP's own Denoise Control Video edit, so H3 never re-draws them and the join has a single rendering. With saved latents the held frames are the neighbour's own latents, and the cut hands over a few frames inside the window, where both files decode identically. **Masked + keyframes** also gives H3 the frames as keyframes to steer toward. Masked joins need a model with Denoise Control Video and a video mask (Ref2VA has both), settings that don't already use a reference or control video, phase 2 tiling off, and an attention mode other than Sol (WanGP's Grouped Rows masking). Otherwise the dialog falls back to pinned keyframes and says why.
- **Motion + masked** (the recommended way to leave a clip): both at once. The earlier part of the clip's tail (17, 34 or 51 frames) goes to H3 as motion-context history, and its last 22 frames are held inside the run by the mask, so the motion carries on and the cut falls inside a single rendering. The held frames' sound is held too, with the history's sound before it. Without masking it falls back to plain motion context.
- **Latent grade:** the editor installs a small add-on into WanGP that saves each H3 generation's latents beside the video. Pins taken from those latents skip a decode/encode round trip, for the cleanest joins. That needs the cut on H3's 17-frame grid, so a cut may move by up to 16 frames; tick **Keep my exact cuts** to use pixel grade instead. If **H3 Latent Carry** is installed, the latents it saves with each video (the last 56 frames) are used too, so extending a clip from its end gets latent grade even for videos made before the editor's add-on. Clips without saved latents from either use pixel grade.
- **Join match** (on by default): a generated clip often opens at a slightly different exposure or colour balance from the clip it continues. The editor measures each generated join and corrects the new clip with a per-channel gain that is strongest at the join and fades out over about half a second (and the mirror image where a run arrives on a clip). Joins whose frames are held exactly by a mask need nothing and are left alone. Toggle it per clip in the Inspector.
- **Blend the joins** (pinned frames inside the run): the new clip's own rendering of the neighbour's frames is crossfaded with the neighbour, so the switch between the two renderings is gradual. The crossfades are ordinary transitions positioned to end (or start) at the cut, so you can change or delete them.
- **Seam verdicts:** each join is rated seamless, soft bump or hard cut, shown as coloured bars on the timeline and in the Inspector, with ▶ buttons to play across a join.
- **Sliding windows as separate clips:** each sliding window's full render is kept (from generations made with 3.1 or later). **Split into windows** cuts the clip at its windows, and each piece becomes its own clip of its window's render, trimmed to meet its neighbours: it can be moved, or dragged out to the window's full length, like an extended or prepended clip.
- **Sliding windows:** an extend (or a new shot) longer than the model's longest window runs in WanGP's sliding windows, with the join in the first window; runs that arrive on a clip still fit one window. The clip appears on the timeline after the first window and grows as each one finishes; if you stop the run, the finished windows are kept. Tick **Sliding windows** in the generate dialog to see the window options (it ticks itself when the length needs more than one window, or when the prompt sets its own windows with `[/duration=...]`, which override the length). **Join the windows as Motion + masked** (on by default) joins WanGP's own windows the way the editor joins clips: each window takes the previous one's tail as motion-context history and holds its last 18 frames (and their sound) inside the new window with the denoise mask, so every window seam falls inside one rendering (it uses an overlap of at least 35 frames and discards each window's last 4). Tick **One clip per sliding window** to place the result as one clip per window, or right-click any WanGP clip → **Split at sliding windows**. The cuts come from the windows the add-on saved latents for, else from the clip's WanGP settings (window size, overlap and discarded frames).
- **Takes and lineage:** generating the same slot again (or **Reroll**) adds a take. Generated clips show what they came from. Each take remembers where it cut its neighbours (join modes and latent grade can move a cut), so switching takes puts the neighbouring cuts back where that take joins them.
- **Live preview** of the generation in the Inspector while WanGP works.
- **Blocks:** plan shots before generating them. Right-click empty space on a video track → **Add a block to generate here…**: a prompt and a length, shown as a dashed slate on the timeline and in the viewer (and left out of exports). Right-click a block → Generate, or **Edit → Generate all blocks** to generate every block left to right, each waiting for the one before: a block that starts where a clip ends continues out of it (an Extend, with the usual joins) unless that's switched off, any other is a new shot. The result takes the block's place and length. A block can also have an **end image** (the picture it lands on: its last frame) and, for a new shot, a **start image**, so a whole sequence of keyframes can be laid out and generated in one go; these need a model that takes them (H3 FL2VA or Ref2VA), and Generate all stops and shows the dialog if the run can't use one. A block that lands on an end image keeps its last frames even when the run comes out a little longer than the block.
- **Settings drift** (Edit → Compare clips with current WanGP settings…): lists the generated clips on the timeline made with a different model, steps, phases, guidance, shift, sampler, sigmas, resolution or LoRAs from what the Media Generator has now (was → now), and selects them.
- **View → Snap cuts to H3's 17-frame grid** keeps splits and trims of WanGP clips on the grid.
- Saved latents are kept up to 20 GB, oldest removed first. WanGP must be restarted once after installing or updating the editor so the add-on loads.

**Final render (upscale)**
- Edit with fast one-phase drafts, then **File → Render final…** (or right-click clips → **Render final**) refines each continuous stretch of the main track as one piece through WanGP's own phase 2: the drafts, latent-upscaled ×2, with the Turbo LoRA, noise level and steps of your clips' phase 2, and optionally the H3 VAE ×2 on decode. RefMods and references carry over; LoRAs are left out unless you keep them. The **refiner** is Turbo (WanGP's *H3 Original 2 Phases*) or **Open-H3 Regenerate 2K** (*H3 Regenerate 2K 2 Phases*: its own LoRA and fixed noise schedule, silent audio conditioning; the drafts' soundtrack is kept); by default it follows the clips' settings.
- WanGP's H3 presets (*Vanilla 1 Phase*, *Original 2 Phases*, *Regenerate 2K 2 Phases*) work for editor generations too. When the project's generation size switches the number of phases, the editor fits **Custom Sigmas** and per-phase LoRA multipliers to it, and drops the phase-2-only Regenerate LoRA from one-phase drafts.
- Each clip gets a **Final** take (its draft and its sound are kept); **View → Show final renders** switches between drafts and finals. A final goes out of date when its draft is trimmed.
- Stretches longer than one window are refined in overlapping windows blended at every step. A clip rendered next to one that already has a final re-renders a little of that final and holds it, so the two flow into each other.
- The project's **Generation** size (Inspector, with nothing selected) sets the draft size for editor generations; it defaults to the first clip's. Presets give 16:9, 4:3, 1:1, 3:2, 21:9 and 2.40:1 in one of WanGP's resolution groups (320p to 1440p, plus H3's native 768p, which keeps the short side at 768: 1344 × 768, 1024 × 768, 768 × 768, 1856 × 768…): WanGP's own size where it lists that shape, fitted to H3's 32-pixel blocks as WanGP does (720p 16:9 is 1280 × 704), otherwise the largest size of exactly that shape within the group (2.40:1 is 768 × 320 at 384p, 1536 × 640 at 720p, 1920 × 800 at 1080p) or the closest within its pixel cap; picking another group keeps the shape, **Flip** swaps width and height for portrait, and **Lock the aspect ratio** changes both sides together.

**Inspector**
- Click a section heading, or an effect's name, to fold it away. Alt+click folds or unfolds every section. Folded sections are remembered.

**WanGP integration**
- Browse WanGP's output folders and import files in place, with nothing copied.
- **Missing files:** files that are moved, renamed or deleted (even while the editor is open) show as missing, with a banner in the Media panel. **Locate…** points one at its new place, keeping every clip, grade and take that uses it; files with the same names in the folder it's in are relinked too. Right-click → **Relink to another file…** swaps a file for another (it warns when the length differs).
- Clips that WanGP generated show their prompt, seed and settings in the Inspector, and after shot detection, each shot's own text.

**Export**
- H.264, H.265 or ProRes 422 HQ, at any resolution and frame rate. Fast hardware H.264 / H.265 (NVIDIA NVENC, AMD AMF, Intel Quick Sync, VAAPI on Linux, Apple VideoToolbox) is offered when a test encode shows it works on your machine.
- **Audio only** (WAV, MP3 or AAC) and **still frame** (PNG or JPEG at the playhead).
- **Loudness normalisation** to -14, -16, -23 or -24 LUFS with a -1 dBFS peak limiter. Every export reports its measured loudness.
- The whole timeline, in/out points or a range selection.
- Rendered on the GPU from the original files.
- **De-click:** hard audio cuts get a 5 ms taper either side so the waveform never jumps; joins where the audio carries straight on, or a transition covers the cut, are left alone.
- **Self-check:** after every export the file is read back: its length against the timeline, any decoding errors, black stretches longer than a second, and its loudness and true peak, listed in the export dialog.
- **Disk space:** exports, generations and final renders check there's room first and say how much is needed.
- **Hand-off to Resolve or Premiere** (File → Export for other editors): **FCP 7 XML** (tracks, cuts, speed and reverse, opacity, volume, dissolves, audio crossfades, markers, clips turned off) or a **CMX 3600 EDL** of V1. Grades, effects, titles and keyframes stay in this editor; the export lists what didn't carry over. Check speed changes after importing.
- **Collect project** (File): a ZIP of the project, every file it uses (from all its timelines) and its LUTs, to move it to another machine. **File → Open collected project…** unpacks one and relinks it.

**Layout**
- Media, Transitions, Effects, Markers, Inspector, Colour, Scopes and Mixer panels can each be moved to the left, right or bottom dock, onto the **stage** (the area under the viewer on the Colour and Audio pages, where the Shots strip lives), **floated** as a movable, resizable window, or hidden.
- **Drag a panel** by its tab, its grip on the stage, or a floating window's title bar: the place it will snap to is highlighted (on the stage, a line shows where in the stack it goes), and letting go puts it there. Let go anywhere else to float it; Esc cancels. The **View** menu and a right-click on a tab do the same, and **Reset this page's layout** puts a page back as it started. Each page remembers its own layout.

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
2. Drag clips from the Media panel onto the timeline (or double-click one to add it to the end). Files dragged in from Explorer or Finder are uploaded and placed where you drop them on the timeline, or added to the Media panel when dropped anywhere else.
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
| V B T R | Select, Blade, Trim, Range tool |
| Q / W | Ripple-trim the clip under the playhead to start / end there |
| Alt+← → | Nudge selected clips a frame (Shift: 10 frames) |
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

The editor is a web page served by WanGP through the plugin web-app API and shown inside the tab. The viewer composites clips with WebGL from lightweight 540p proxies, or from the original files when the viewer's quality menu is set to **Full res**. Export re-renders every frame from the original files with PyTorch, on the GPU when available, using the same colour, transition and speed maths, so the export matches what you saw.

## Roadmap

- Multicam editing, nested sequences, audio noise reduction.

## Licence

MIT. See [LICENSE](LICENSE).

## Attributions

The timeline generation features were inspired by [comfyui-obvpm-timeline](https://github.com/chanon/comfyui-obvpm-timeline) by chanon, a timeline for MiniMax H3 in ComfyUI. Its design and published findings shaped the ideas behind extending, prepending, bridging and filling with pinned frames, masked joins and handing over inside the held window, seam ratings, takes and lineage, crossfading a join across the frames both sides rendered, correcting exposure at joins, and de-clicking hard audio cuts. Thank you for sharing that work.

No code from that project is included here. The Video Editor's implementations were written independently for WanGP: masked joins use WanGP's own Denoise Control Video masking, and Join match is its own method.
