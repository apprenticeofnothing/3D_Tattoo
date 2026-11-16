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
npm install
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
