# Existing tattoos

Put tattoos you already have on the 3D body, to see how new ones fit
next to them, or to plan a cover-up: what size and design hides the old
one.

## Three ways in

1. **From a photo** (Add design, "Existing tattoo from a photo"). An
   editor opens with the photo:
   - **Handles.** They start around the tattoo by themselves. Around an
     arm or leg, the blue lines follow the limb's two edges and the
     orange bars sit just past the tattoo's ends. On a flat area (back,
     chest), four corners go around it.
   - **Fixing them.** Tap the tattoo if they are not around it, and drag
     any handle (a magnifier shows under your finger).
   - **Placing.** Check the preview, choose where on the body, type the
     tattoo's width if you measured it, and press "Place on body".
2. **From a photo that shows your body.** Shoulders and hips must be in
   view. Tap the tattoo, and the app says where it is, for example "left
   forearm, 27% of the way from elbow to wrist, seen from the outer
   side". It then puts the tattoo there on the 3D body. Add a close-up
   for a sharp copy of the design: the location comes from the first
   photo, the design from the close-up.
3. **From your own textured scan** (Add design, "Existing tattoo from my
   scan", then tap the tattoo). The scan already has your real shape and
   the tattoo in its photo texture, so this is the most exact way.

You can then drag, turn and resize an existing tattoo like any design,
and lock it in place. Existing tattoos are drawn under new designs, the
way new ink goes over old.

## Cover-ups

Select a new design that lies over an existing tattoo. Its panel then
shows:
- **How much of the old tattoo it hides.** Old ink only counts as hidden
  under new ink at least as dark, and dark old ink counts most.
- **Show what shows through:** red dots on the skin where old ink would
  still show.
- **Size to cover:** the smallest width that hides 95%. If no size gets
  there, it shows the best it can do, because of light or open areas
  over the old ink.

This is an estimate from the two images. How a cover-up is shaded is
the artist's call.

## Research: what exists, what was chosen

- **Tattoo try-on and cover-up apps** draw a design over a flat 2D photo.
  None of them flatten a tattoo or place it on a 3D body. Examples:
  [TattooCoverUp.AI](https://theresanaiforthat.com/ai/tattoocoverup-ai/),
  [Ombra cover-up preview](https://ombratattoo.com/cover-up),
  [AI Tattoo Cover-Up & Try-On](https://apps.apple.com/us/app/ai-tattoo-cover-up-try-on/id6775879616)
  and [tattoogenerator.com](https://www.tattoogenerator.com/create/tattoo-cover-up-ideas).
  The flattening here had to be built.
- **Locating the tattoo.**
  - **[DensePose](https://arxiv.org/abs/1802.00434)** maps every pixel
    of a person in a photo to a point on a 3D body surface. That is
    ideal for "where is this tattoo", but it needs a GPU and a Python
    stack, with no browser version. It could be a later, Mac-side
    option.
  - **[MediaPipe Pose Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js)**
    (Apache-2.0) runs in the browser. It finds 33 body points and a
    person mask. Used here.
- **Flattening.**
  - **A limb** is treated as a cylinder (label unwrapping, as for
    bottles), corrected for perspective with the camera's focal length
    from the photo's EXIF data.
  - **A flat area** uses a four-corner perspective correction
    (homography), as in document scanning.
- **Separating ink from skin** uses colour-to-alpha against an estimate
  of the bare skin and its lighting, the method of scanned-document
  background removal.

## How it works

- **Limb unwrap.** The two outline edges give the limb's axis and
  apparent radius. Lengths along the skin are recovered from where each
  point appears.
  - With perspective, a close camera sees the outline from nearer the
    side, so a limb looks narrower than its front is. The apparent
    half-width alone gives the camera distance relative to the radius,
    and from that the exact mapping.
  - Without EXIF data, a phone's main camera (26 mm) is assumed.
- **Ink.** The skin colour under the photo's lighting is estimated on a
  grid from the brighter pixels. Cells that are mostly ink (solid
  blackwork) are filled in from their neighbours. The photo is divided
  by that, and what remains becomes an ink colour with a strength. The
  "inked" view then reproduces the tattoo on any skin tone. Stray marks
  along the edges (creases where a limb meets the body) are dropped.
- **Size.**
  - **Measured.** A tape-measured width is exact; it means the ink's own
    width, left to right in the preview.
  - **Worked out.** For an arm or leg, the width comes from the limb's
    real width on the 3D body at that spot, seen from the same side.
- **Where on the body.**
  - The tap gives the tattoo's spot in the photo. The body's joints in
    the photo give which part it is on, how far along it, and from which
    side the camera saw it.
  - On a built body, that spot is found on the matching labelled part.
    On a scan without labels, the centre of the matching body area is
    used.
  - Photos taken in a mirror swap left and right ("Taken in a mirror").
- **Orientation.** The end of the limb nearer the body ("▲ body end" in
  the editor) goes towards the trunk along the limb on the 3D body.
- **From a scan.** The scan's photo texture is rendered flat through the
  same length-preserving map used for stencils, around the tapped spot.
  The area grows until the ink no longer runs off its edge.

## Taking the photos

- Straight on to the tattoo, 30 to 50 cm away, with the main camera (1×),
  in even light without flash. Shiny skin or flash glare looks like
  missing ink.
- For an arm or leg, hold it away from your body against a plain
  background, so both edges of the limb show. Where a limb lies against
  the body, the automatic edges can follow the wrong outline. Then drag
  the blue handles onto the limb's edges.
- Get the whole tattoo in, with some skin around it.
- For the app to find where it is, also take a photo showing your
  shoulders and hips, with the tattoo visible.
- Measure the tattoo's width along the skin with a tape measure if you
  can. It makes the size exact.
- A photo taken in a mirror is fine: tick "Taken in a mirror".

## Accuracy, measured

The browser check (`e2e/existing-tattoo.mjs`) renders the app's own body
with a test tattoo at a known spot and size, imports the render like a
photo, and compares. Last run:

| Case | Size | Where | Orientation |
|---|---|---|---|
| Close-up, everything automatic | 16% too big | (chosen by hand) | 1° off |
| Body photo + tap + close-up, measured width | 3% | 6.3 cm from the true spot | 5° off |
| Close-up, measured width | 3% | (chosen by hand) | 7° off |
| From a textured scan | 0.6% | 0.1 mm | exact |

Cover-up check: a 5 cm solid disk over a 7 cm ring hides 18%. "Size to
cover" picks 6.9 cm, which hides 97%.

Unit tests:
- the cylinder unwrap without perspective (within 3% to ±60°) and with
  perspective (an exact pinhole render, within 4%);
- the perspective correction of flat photos;
- ink separation under 40% darker light, solid blackwork and red ink;
- the pose suggestion: front, back, mirror and torso;
- cover-up coverage on analytic cases: a disk over a disk hides
  (3/4)² = 56%, and a ring leaves its hole showing;
- picking up a 6 cm circle from a textured cylinder (60.25 × 60.00 mm).

## Still rough

- Automatic sizes from a photo are approximate (about 15%), because
  limbs are not round and the lens is assumed. Measure the tattoo for an
  exact size.
- The automatic edges struggle when the limb lies against the body or
  the background is skin-coloured. Dragging the handles fixes that.
- The location from a body photo is a starting point, a few centimetres
  off. Drag the tattoo to where it really is, then lock it.
- A tattoo going all the way round a limb needs more than one photo.
  Place each part separately.

## Privacy

Everything runs in the browser.
- The pose model and its runtime are downloaded once when the app is
  installed (`scripts/fetch-models.mjs`) and served by the app itself.
  The browser never contacts a third party.
- Photos are not stored. Only the flattened tattoo image is kept, in the
  project on your device.
