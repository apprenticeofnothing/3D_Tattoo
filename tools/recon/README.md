# recon: photos to a textured mesh on the Mac

Wraps Apple's photogrammetry engine (the one behind Object Capture). Runs
fully offline on the M4 MacBook Pro. Not compiled here; first run may
need a small fix, which Xcode's error message will point at.

## One-time setup

1. Install Xcode (App Store) or the Command Line Tools:
   `xcode-select --install`
2. Open Terminal in this folder: `cd tools/recon`

## Run

```sh
# photos in ~/Scan/photos (JPEG or HEIC, 150-250 of them)
swift run -c release recon ~/Scan/photos ~/Scan/out/body.obj
```

First build takes a minute. Reconstruction of 200 photos at the default
"custom" detail (150k triangles, 4K texture) takes roughly 10 to 30
minutes on an M4; the terminal prints progress.

Output `~/Scan/out/` then holds `body.obj`, `body.mtl` and texture
images. In the app choose More, Load my scan, and select all of those
files at once (Cmd+A in the file dialog). The app scales the mesh to
your height.

Options: `--detail full` for the highest quality Apple offers (big files),
`--polys 80000` for a lighter mesh, `--sensitive` if alignment fails on
plain skin, `--sequential` for frames extracted from a video, `--no-mask`
if the subject isolation cuts off limbs (try with masking first; dark
trousers are a known cause).

Problems: if photos are skipped as invalid, they are blurred or too
dark. If "stitching incomplete" appears, there were gaps in the walk;
re-shoot the missing angles and run again with all photos together.
