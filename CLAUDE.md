# Project: Tattoo preview on my own 3D body

## Goal
Build an app where I load a 3D model of my own body (reconstructed from
photos), upload flat tattoo designs (SVG first, PNG too), and place them
on any body part to see how they will look on me before I get tattooed.
I am the only user. I will use this to make real, permanent decisions,
so placement, size and shape fidelity matter more than feature count.

## My setup
- Height: 193 cm.
- Phone: iPhone 16 (no LiDAR). Used for photo capture and for directing
  development; occasional testing in the phone browser.
- Computer: MacBook Pro with Apple M4. This is where I will primarily
  use the app, and where photogrammetry and mesh prep can run.
- Existing 3D body scan: none yet; it has to be produced in phase 1.
I direct development from my phone, but I will primarily use the app on
my MacBook Pro. The app must work well in a desktop browser first, and
also in a phone browser with touch.

## Privacy
The source material is photos of my body. Body photos and meshes are
never committed to the repo, never sent to third-party services, and
there is no telemetry. The app loads my scan from my device and
processes it in the browser. Only code and small synthetic test assets
live in the repo.

## Architecture
1. Reconstruction: photos -> textured mesh (GLB). Research the current
   best option for my hardware before choosing, for example a phone
   scanning app that exports a mesh, or a photogrammetry tool on my
   computer. Do not use a parametric average body fitted to photos; I
   need my actual shape. The app must import an existing GLB/OBJ so
   the viewer can be built and tested before my scan exists. Write me
   a short capture guide (how many photos, lighting, pose, clothing).
2. Mesh prep: clean, make manifold, decimate to a size that runs
   smoothly on a phone, scale to real centimetres using my height,
   keep the photo texture as skin.
3. Viewer: static web app, TypeScript + three.js. Propose the rest of
   the stack and tell me why. Tell me how I can open and test it on my
   phone after each phase.

## Design mapping: the core problem
A flat design cannot be mapped onto a doubly curved surface with zero
distortion. The right target is what a tattoo stencil does: paper laid
on skin, preserving lengths along the surface as closely as possible.
- Do not use simple projective decals; they stretch at grazing angles.
- Flatten the local surface patch around the anchor point with a
  length-preserving method (geodesic/exponential map, or ARAP/LSCM
  parameterisation) and map the design through it.
- Design size is set in real centimetres and measured along the skin.
- Show a distortion heatmap toggle and warn me when local stretch
  exceeds about 5%, since a real stencil would wrinkle there too.
- Provide a wrap mode for armbands and sleeves around limbs.
- Rasterise SVGs at high enough resolution that fine lines stay crisp
  at full zoom.

## Interaction
- One-finger rotate, two-finger pan and pinch zoom; mouse equivalents
  on desktop. Smooth and never disorienting.
- Body part picker (forearm, upper arm, shoulder, chest, ribs, back,
  thigh, calf, and so on, left/right) that flies the camera there.
- Tap the body to place a design; then drag, rotate, scale, mirror.
- Opacity slider and an "inked skin" render (multiply blend, slightly
  softened edges) next to a crisp stencil view.
- Multiple designs at once, undo/redo, save and reload placements,
  export PNG screenshots, side-by-side comparison of two options.
- Plain, uncluttered UI with large touch targets. I should never need
  a manual.

## Verification
Prove accuracy rather than asserting it:
- Unit tests on analytic shapes: a cylinder should give near-zero
  distortion; a sphere should match the known theoretical stretch.
- A test grid and a circle of known diameter; measure geodesic lengths
  on the mesh against the design and report the error.
- Run the app and check it visually (screenshots) before calling a
  phase done.

## How to work
- Phases: (1) viewer with a placeholder body mesh and navigation,
  (2) design mapping and its tests, (3) placement UI, (4) reconstruction
  with my photos, (5) polish.
- Commit at the end of each phase with a short note on what works and
  what is still rough. Tell me plainly when something is an
  approximation.
- Keep messages to me brief; I am reading on a phone.
- Out of scope for now: posing or animating the body, muscle flex,
  accounts, app store packaging.
