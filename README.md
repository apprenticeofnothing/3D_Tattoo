# Tattoo preview on my own 3D body

A private, static web app: load a 3D scan of my body, place flat tattoo
designs on it with stencil-like (length-preserving) mapping, and judge
placement and size before getting inked. See `CLAUDE.md` for the brief
and `docs/` for the reconstruction research and capture guide.

## Run it

Online (after each push, via GitHub Pages):
https://apprenticeofnothing.github.io/3D_Tattoo/

The repository is private. GitHub Pages on a private repository needs a
paid GitHub plan; on the free plan the deploy step is skipped (the
workflow still runs the tests and the build). To get the online URL,
either make the repository public (it never contains body data) or
upgrade the plan, then in Settings, Pages set Source to "GitHub
Actions". If a deploy then fails with "branch not allowed to deploy to
github-pages", allow the branch pattern `claude/*` under Settings,
Environments, github-pages.

On the Mac:

```sh
npm install        # also fetches the pose model into public/mediapipe (once)
npm run dev        # prints a local URL and a LAN URL for the phone
npm test           # unit tests
npm run build      # static site in dist/
```

Open the LAN URL (shown by `npm run dev`) in Safari on the phone while
both devices are on the same Wi-Fi.

## Status

- Phase 1 done: viewer with a procedural placeholder body, GLB/GLTF/OBJ/PLY
  import from the device, touch and mouse navigation, body part picker,
  height scaling.
- Phase 2 done: stencil-style design mapping. Tap to place an SVG or PNG,
  size in real centimetres along the skin, rotate, mirror, wrap around a
  limb, stencil / inked / heatmap views, stretch report with a 5% warning,
  circumference readout. Verified on analytic shapes (see `tests/`).
- Phase 3 done: direct manipulation. Drag a design along the skin, rotate
  and scale with on-skin handles (or the panel), several designs with
  chips to switch, duplicate, undo/redo (Ctrl+Z / Ctrl+Shift+Z), save and
  open a project file (designs embedded, no body data), autosave of the
  last session in the browser, PNG photo export (share sheet on iPhone),
  and a split A/B compare view.
- Phase 4 (tools written, awaiting the first real scan): capture
  assistant page (`capture.html`) with compass ring progress, blur check,
  auto shooting and ZIP export; `tools/recon`, a Swift command-line wrapper
  around Apple's photogrammetry engine (not compiled here); Blender mesh
  prep script in `tools/mesh-prep`; orientation controls for loaded scans.
  Walkthrough in `docs/pipeline.md`.
- Body builder: six realistic preset bodies (female and male; thin,
  athletic, slightly overweight) built from MakeHuman data, shaped further
  with sliders for weight, muscle, torso, arms and legs, plus skin tone.
  Designs stay on the same spot of skin while the body changes. See
  `docs/body-builder.md`.
- Arm pose: raise, swing, rotate, bend and turn each arm (or both), with
  quick poses such as "Inner arm" and "Flex", or grab a wrist or elbow
  ring and drag the arm into place (inverse kinematics within realistic
  joint limits). Tattoos move with the skin, and placing, dragging and
  measuring work on a posed arm.
- Turning the body: drag the ring on the floor to spin the body, drag up
  or down to tilt it (to see shoulders from above or soles from below),
  double-click the ring for the front view, or use the Front, Left, Back
  and Right buttons. Arrow keys turn and tilt when no design is selected.
  Lights travel with the view so every side is evenly lit.
- Zoom: mouse wheel, trackpad scroll and trackpad pinch zoom towards the
  point under the pointer (that spot of skin stays put), pinch with two
  fingers on a phone, double-click or double-tap the body to zoom in
  there, − and + buttons, keys + and − (0 shows the whole body). Close
  enough to inspect fine lines (about 7 cm from the skin).
- Navigation, the way 3D viewers such as Sketchfab, BioDigital Human and
  model-viewer work: one finger (or drag) turns, two fingers either pinch
  to zoom about the skin between them (which stays put even when the
  fingers drift) or drag together to move the view, decided in the first
  few pixels; after moving, turning pivots on the skin in the middle of
  the view. Double-tap the body to zoom in there, double-tap the
  background for the whole body. The view always stays on the body,
  tilts between 75 degrees looking down and 45 looking up, and zooming out
  stops a little beyond the whole body. The whole-body view refits when
  the screen changes size (phone toolbars, turning the phone). Tap a
  design to select it; only the selected design moves when dragged, so
  looking around never moves a tattoo by accident.
- Sizing and stencil export: resize a design on the body by dragging the
  yellow corner handle, by pinching it with two fingers on a phone, or
  with Alt (Option) + scroll over it on a Mac. A tag under the design shows
  its size along the skin in cm and inches as it changes. "Export
  stencil" then saves the design at exactly that size, for the tattoo
  artist: a print-ready PDF (A4 or US Letter, 100% scale, calibration
  rulers, big pieces split over several pages with alignment crosses, an
  optional placement page with a picture and the position on the body),
  an SVG sized in millimetres, or a 300 dpi PNG. See
  `docs/stencil-export.md`.
- Existing tattoos: add a tattoo you already have from a photo (flattened
  around the arm or leg with perspective correction, ink separated from
  the skin), from a photo showing your body (tap the tattoo and the app
  says and shows where it is), or straight from your textured scan.
  Cover-up check: how much of the old tattoo a new design hides, what
  would show through, and the size that covers it. See
  `docs/existing-tattoos.md`.
- Phase 5 (polish, in progress): tape measure (distance along the skin
  between two taps, circumference of a limb at a tap, both drawn on the
  body), keyboard nudging (arrows 1 mm, Shift 10 mm, [ ] rotate 1°).

## How the mapping works

The design plane is laid onto the skin with the exponential map from the
anchor point: the point at design position (r, angle) lands at geodesic
distance r along the surface in that direction, like pressing a stencil
down from its centre outwards. Coordinates are computed by tracing exact
straightest geodesics across the triangle mesh (an edge-walking pass
provides the ordering and fills gaps). Radial lengths are exact; on
doubly curved skin the tangential direction compresses or stretches, and
the heatmap shows by how much. On a cylinder the error is 0.01%; on a
sphere the measured tangential compression matches sin(r/R)/(r/R) within
0.3 points.
