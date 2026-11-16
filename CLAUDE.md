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
- Computer: MacBook Pro. This is where I will primarily use the app.
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
- Fl
