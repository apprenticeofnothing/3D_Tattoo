# Browser checks

Screenshot-driven checks of the real app, used before calling a phase
done. They drive a built copy of the site with Playwright.

```sh
npm run build
npx vite preview --port 4173 &
npm i -D playwright && npx playwright install chromium   # once
mkdir -p /tmp/shots
node e2e/mapping.mjs /tmp/shots              # place, heatmap, wrap, shoulder
node e2e/placement.mjs /tmp/shots            # drag, handles, undo, compare, photo, save/open
node e2e/measure.mjs /tmp/shots              # tape measure, keyboard nudges
npx vite-node e2e/make-test-obj.ts /tmp/obj  # synthetic Z-up OBJ
node e2e/scan-orientation.mjs /tmp/shots /tmp/obj
node e2e/capture.mjs /tmp/shots              # capture page with a fake camera
node e2e/body-builder.mjs /tmp/shots         # presets, sliders, designs across body changes
node e2e/arm-pose.mjs /tmp/shots             # arm poses, designs riding on the skin, tap/drag/measure when posed
node e2e/joint-drag.mjs /tmp/shots           # grab wrist/elbow rings and move the arm (mouse and touch)
node e2e/turn-body.mjs /tmp/shots            # turn and tilt the body with the floor ring, view buttons
node e2e/stencil-export.mjs /tmp/shots       # resize on the body, export PDF/SVG/PNG and check their sizes (needs python3 with pypdf and Pillow)
node e2e/zoom.mjs /tmp/shots                 # wheel, trackpad pinch, buttons, keys, double-click, phone pinch
```

Each script prints what it measured (for example "drag: anchor screen y
412 -> 492") and writes PNGs to the given folder. Look at the images.
