# From photos to my body in the app (Mac walkthrough)

Everything below runs on the MacBook Pro and the iPhone. No cloud.

## 1. Capture (iPhone, with a helper)

Follow `capture-guide.md`. Two ways to shoot:

- **Camera app** (highest resolution, 24 MP HEIC). Lock AE/AF, no zoom,
  three rings plus close-ups. Count by hand, roughly a photo every 6
  degrees.
- **Capture assistant** in the web app (More, Capture assistant; or open
  `capture.html`). Lower resolution (up to 4K frames from the camera
  stream) but it shows ring progress on a compass, flags blurry frames,
  can shoot automatically every 6 degrees, and exports one ZIP per ring.
  On the iPhone it needs to be opened over https (GitHub Pages) or from
  the Mac's local server address while on the same Wi-Fi.

Either way, get the photos onto the Mac with AirDrop into one folder,
for example `~/Scan/photos`. Unzip the assistant's ZIPs into that same
folder. Delete obviously blurred photos.

## 2. Reconstruct (Mac)

```sh
cd tools/recon
swift run -c release recon ~/Scan/photos ~/Scan/out/body.obj
```

See `tools/recon/README.md` for options and troubleshooting. Expect 10 to
30 minutes. The result is `body.obj` with `body.mtl` and textures.

## 3. Load into the app

```sh
npm run dev       # in the repo root
```

Open the printed URL, choose More, Load my scan, and select `body.obj`,
`body.mtl` and all texture files together. The app scales the mesh so it
is 193 cm tall and stands on the floor. If it lies down or faces the
wrong way, use More, Orientation, to stand it up and turn it so the
front faces you. Then set your height in More if it is not 193.

## 4. Optional: lighter mesh or GLB

If the mesh is heavy or has floor fragments, run the Blender script:

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/mesh-prep/mesh_prep.py -- \
  --input ~/Scan/out/body.obj --output ~/Scan/body.glb --height-cm 193 --target-tris 150000
```

It keeps the largest piece, fills small holes, decimates while keeping
the texture, scales to the height and exports a single GLB that loads
with one file pick. Blender is free from blender.org.

## What "good" looks like

- One closed-ish surface, 100k to 200k triangles, texture 4K.
- Arms clearly separated from the torso (A-pose), hands and feet present.
- Tape-measure check: in the app, place the test pattern on the forearm
  with Wrap on; the circumference shown should match a real tape
  measurement within about 1 cm. If it is off by a constant factor, the
  height setting is wrong.
