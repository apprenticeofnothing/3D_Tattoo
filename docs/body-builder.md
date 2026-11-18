# Body builder

For anyone without a 3D scan of their own body: start from one of six
realistic bodies and shape it with sliders. Your own scan (More, Load my
scan) always replaces it.

## What you can change

- **Start from:** female or male; thin, athletic or slightly overweight.
  Presets are defined by BMI (about 19, 22.5 to 25.5, and 27.5 to 29) and
  are re-calibrated for the height you set, so "slightly overweight" stays
  slightly overweight at 193 cm.
- **Basics:** sex (a continuous blend), weight, muscle tone, breast size
  and firmness.
- **Torso:** shoulder width, chest muscles, chest size, V-shape, waist,
  belly, hips, buttocks, torso length, neck.
- **Arms:** upper arm size, biceps and triceps, forearm size, forearm
  muscle, arm length.
- **Legs:** thigh size, thigh muscle, calf size, calf muscle, leg length.
- **Ancestry:** a mix of MakeHuman's three base populations; mostly
  changes the face and proportions.
- **Height** and **skin tone** (eight swatches or any colour). The bodies
  are unclothed so designs can go anywhere, including areas underwear
  would cover.

Every setting is saved in the browser and inside saved project files.

## Arm pose

Open **Arm pose** to move the arms, so tattoos on the inside of the arm,
the armpit or the back of the arm can be seen properly.

- **Quick poses:** Relaxed (as modelled), Arms down, Arms out, Inner arm
  (palms up, arms forward; the camera turns to the inner forearm), Flex,
  Arm up.
- **Drag the arm itself:** with the panel open, green rings sit on the
  wrists and yellow rings on the elbows. Grab a wrist ring and move it:
  the elbow finds a natural position (it keeps its current swivel, nudged
  towards down-and-back) and every joint stays within its limits; a
  target out of reach straightens the arm towards it. Grab an elbow ring
  and the upper arm swings there while the forearm keeps its bend and
  twist. With "Both arms" selected, the other arm mirrors the movement.
  Works with a mouse and with a finger.
- **Sliders**, for both arms together or each arm separately: raise arm
  (0° hanging, 90° out to the side, up to 160°), arm forward or behind,
  rotate upper arm inward or outward, bend elbow (0° straight to 150°),
  and turn forearm (palm down to palm up).
- **Tattoos move with the skin.** A design is anchored to the skin of the
  relaxed body and carried by the same skin when the arm moves, twists or
  bends, like a real tattoo. You can place, drag, rotate, scale and measure
  on a posed arm; everything lands where you tap.
- **Size and stretch are measured on the relaxed body.** The stencil
  heatmap and the centimetre sizes describe the design as applied, not
  the extra stretch of skin in a pose.
- The pose is saved with the body and in project files. Arm posing works on
  built bodies only; a loaded scan keeps the pose it was captured in.

How it works: MakeHuman's skeleton gives the shoulder, elbow and wrist
joints, which follow every shape slider (they are averages of hidden
helper vertices that the morph targets move too). The arm is posed by
forward kinematics, with the collarbone joining in above about 60° of
elevation, and the skin follows by blending MakeHuman's bone weights.
Arms and twists use dual-quaternion skinning, so a turned forearm keeps
its volume. Where the arm meets the trunk, linear blending is used
instead, because dual quaternions balloon the armpit there.
MakeHuman's weights were repaired so the side of the chest no longer
follows the upper arm (they fade out 4 to 8 cm from the shoulder joint),
and smoothed around the shoulders.

## Designs stay on the same spot

The body is always the same mesh with the same triangles, only moved. A
placed design remembers its triangle and its exact position inside it, so
reshaping the body or switching presets carries every design along with
the skin. Its size in centimetres along the skin does not change, which is
what a real tattoo does when a body changes.

## How it works

- Data comes from MakeHuman (makehumancommunity.org): the hm08 base mesh
  (skin plus eyes, 13,524 vertices) and its morph targets. The repo ships
  only what the app needs in `public/bodies/` (1.3 MB compressed): the
  base mesh, 148 targets restricted to the skin, per-vertex body-part labels
  from MakeHuman's skeleton weights, an eye colour mask, and the preset
  settings.
- In the browser the targets are blended with MakeHuman's own rules (sex,
  muscle and weight blend bilinearly; breast targets depend on all of
  them), then the mesh is subdivided once with Catmull–Clark to 108,000
  triangles. The subdivision is precomputed as fixed weights, so a slider
  step takes about 11 ms.
- The body-part labels make "Body part" jumps work on the A-pose, where the
  arms are raised 45° and point slightly forward.
- BMI is estimated from the body's volume at a density of 1,010 kg/m³. It
  is a guide, not a measurement.

## Honest limits

- Only the arms move. Legs, spine, head and hands keep MakeHuman's
  A-pose; fingers and wrist do not bend.
- Skin deformation is skinning, not simulation: the armpit stretches into
  a smooth web when the arm is raised, and a fully bent elbow can
  interpenetrate slightly. Muscles do not bulge when flexed.
- Height is a uniform scale of the body. The MakeHuman package used here
  has no separate height targets, so a tall body has the same proportions
  as an average one; use the leg, arm and torso length sliders to adjust.
- The body is a young adult; there is no age slider.
- Skin is a single colour; there are no freckles, hair or skin texture.
- MakeHuman's default body has no genital detail; the groin is smooth.

## Licence and sources

MakeHuman's team released the base mesh and targets under CC0 (public
domain), and models generated with MakeHuman are CC0. The targets were
read from the PyPI wheel `makehuman==1.3.2` (`data/targets.npz`, tagged
CC0, 2001-2020). The base mesh with skeleton weights was read from the npm
package `makehuman-data@0.0.2` (`public/data/models/human_full_size.json`;
that copy still carries MakeHuman's older 2015 notice). No MakeHuman code
runs in the app or the generator; both are read as data.

## Regenerating the data

```sh
mkdir -p /tmp/mh && cd /tmp/mh
pip download makehuman==1.3.2 --no-deps -d .
python3 -c "import zipfile; zipfile.ZipFile('makehuman-1.3.2-py3-none-any.whl').extractall('wheel')"
npm pack makehuman-data@0.0.2
mkdir npm && tar -xzf makehuman-data-0.0.2.tgz -C npm
cd -   # back to the repo
python3 tools/body-builder/build_presets.py \
  --targets /tmp/mh/wheel/makehuman/data/targets.npz \
  --base /tmp/mh/npm/package/public/data/models/human_full_size.json \
  --out public/bodies
```

The generator also re-calibrates the six presets and prints their BMI.
Run `npm test` afterwards: the tests check that the browser blending
reproduces the generator's numbers.
