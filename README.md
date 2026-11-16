# Tattoo preview on my own 3D body

A private, static web app: load a 3D scan of my body, place flat tattoo
designs on it with stencil-like (length-preserving) mapping, and judge
placement and size before getting inked. See `CLAUDE.md` for the brief
and `docs/` for the reconstruction research and capture guide.

## Run it

Online (after each push, via GitHub Pages):
https://apprenticeofnothing.github.io/3D_Tattoo/

One-time setup on GitHub: Settings, Pages, Source "GitHub Actions". If a
deploy fails with "branch not allowed to deploy to github-pages", go to
Settings, Environments, github-pages, and allow the branch pattern
`claude/*` (or merge to main).

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
- Next: phase 3, placement interaction (drag, multiple designs, undo,
  save and load, screenshots, side-by-side).

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
