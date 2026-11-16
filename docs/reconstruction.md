# Reconstruction: photos to a textured mesh of my body

Research date: 2026-11-16. Hardware: iPhone 16 (no LiDAR) for capture,
MacBook Pro with Apple M4 for processing. Rule: nothing leaves my devices.

## Decision

Use Apple's photogrammetry engine on the Mac (`PhotogrammetrySession` in
RealityKit, the engine behind Object Capture), fed with still photos from
the iPhone 16 camera. The repo will hold a small Swift command-line tool
that wraps it (phase 4). Output: USDZ plus an OBJ folder with textures,
converted to GLB for the app and scaled to 193 cm.

Why this and not the alternatives:

| Option | Offline | Free | Mesh + texture | Verdict |
| --- | --- | --- | --- | --- |
| Apple PhotogrammetrySession (macOS) | Yes* | Yes | Yes | Chosen. Native on Apple Silicon, best reported results on people. |
| Agisoft Metashape Standard | Yes | $179 | Yes | Fallback if Apple's engine fails on my body. More manual control. |
| COLMAP + OpenMVS via Homebrew | Yes | Yes | Yes | No GPU dense stereo on Mac. Hours per scan, worse on skin. |
| RealityScan 2.0 desktop (Epic) | Yes | Mostly | Yes | Windows + NVIDIA only. |
| Meshroom / AliceVision | Yes | Yes | Yes | No usable macOS build; depth maps need CUDA. |
| Gaussian splat tools (Brush, OpenSplat, Mac splat apps) | Yes | Yes | Splats only | No mature splat-to-textured-mesh path on Mac. |
| Scaniverse app (phone) | Yes | Yes | GLB/OBJ | Only phone app that is fully on-device. Quality on a non-LiDAR phone for a full body is unverified. Worth one test. |
| Polycam, KIRI, RealityScan mobile, Luma | No | - | - | Cloud processing. Excluded by the privacy rule. |

*One caveat: on macOS 26 the engine downloads an improved model from Apple
once, in the background, the first time it runs. Photos are not uploaded.
Run one job while online, then it works offline.

## Facts that shape the pipeline

- Input: a folder of JPEG or HEIC images from any camera. Depth and gravity
  data are optional. Without depth the output has arbitrary scale, so we
  scale by my height afterwards.
- Image count: Apple suggests 20 to 200 for objects; Macs with plenty of
  unified memory accept up to 2000. Query `PhotogrammetrySession.limits`.
- Detail levels: preview, reduced, medium, full, raw, and custom (polygon
  count and texture size up to 16K). Use full or custom.
- Useful options: object masking on (isolates the person from the room),
  feature sensitivity high if alignment struggles, sequential ordering if
  photos are frames from a video.
- Output: `.modelFile` to a USDZ, or to a folder for OBJ + textures. One
  unverified forum report says OBJ output broke in a recent SDK, so test
  USDZ and OBJ early and keep a USDZ to GLB converter path ready.
- Hardware: Macs with a GPU of 4 GB or more and ray tracing. M4 qualifies.
- iPhone: on-device guided Object Capture requires LiDAR. iPhone 16 (non
  Pro) has none, so the phone is purely a camera here.
- People: no official Apple statement. Developer reports: bodies come out
  smooth and clean, often better than Metashape or RealityCapture, but
  long hair merges with the face, and dark trousers made legs disappear
  under automatic subject isolation. Capture guide accounts for both.

## Scale

Photogrammetry gives proportions, not size. Plan: measure the
reconstructed mesh height and scale uniformly to my standing height,
193 cm, measured barefoot. Expected accuracy around 1 to 2 percent. If
better accuracy is needed later, place two rulers of known length in
frame and scale from them instead.

## Video instead of stills

Possible but worse: motion blur, rolling shutter and compression lower
the quality, and a few blurred frames can hurt alignment. If I cannot
hold still for the stills, record slow 4K video with stabilisation off,
extract 2 to 4 frames per second, drop blurred frames, and process with
sequential ordering. The upside is a hold time of about one minute.

## Sources

Read directly: Apple developer documentation for RealityKit Object
Capture (creating 3D objects from photographs, capturing photographs for
Object Capture, PhotogrammetrySession request and configuration, the
command-line sample, the macOS 26 release notes), WWDC21 session 10076
and WWDC24 session 10107, Apple developer forum threads 769221, 747010,
786078 and 704570, the Homebrew colmap formula, the COLMAP FAQ, the
Meshroom release page, the Brush and OpenSplat repositories and the
Nerfstudio installation page. Noted from search snippets only, not
verified by reading the page: RealityScan 2.0 platform support, Metashape
2.3.1 Apple Silicon notes, Scaniverse and Polycam on-device processing
statements, KIRI and Luma cloud processing.
