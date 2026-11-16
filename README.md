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

Phase 1 done: viewer with a procedural placeholder body, GLB/GLTF/OBJ/PLY
import from the device, touch and mouse navigation, body part picker,
height scaling. Next: phase 2, stencil-style design mapping with tests.
