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
```

Each script prints what it measured (for example "drag: anchor screen y
412 -> 492") and writes PNGs to the given folder. Look at the images.
