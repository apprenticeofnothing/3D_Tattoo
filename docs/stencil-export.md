# Sizing a design and exporting the stencil

## Why the flat design is the stencil

The mapping lays the design on the skin the way a paper stencil is laid:
lengths along the skin are kept (see "How the mapping works" in the
README). So the flat design printed at the size shown on the body is the
stencil the artist needs. "10 × 10 cm" in the app means 10 cm measured
along the skin, which is what a tape measure on the body reads, and what
the printed stencil measures on paper.

Where the skin curves in two directions (shoulder, chest, knee), no flat
sheet fits without small wrinkles or stretch. The app reports how much
(the 5% warning, the heatmap), and the export repeats that figure on the
placement page, so the artist knows to expect it. That part is an
approximation by nature, for paper as well as for the app.

## Resizing on the body

- Mouse: drag the yellow corner handle. The design grows or shrinks
  around its centre and keeps its proportions; the corner follows the
  pointer along the skin.
- Mac trackpad or mouse wheel: hold Alt (Option) and scroll over the
  design. Without Alt, scrolling zooms the camera as usual.
- Phone: put one finger on the design and a second finger next to it,
  then spread or pinch. Twisting the two fingers also rotates it.
- Panel: type a width, or use − and + (0.5 cm steps).

The tag under the design shows width × height in cm and inches while it
changes. Each resize is one undo step.

If the design panel would cover the design or its handles, the view
eases sideways (or up, on a phone) just enough to show it. This happens
after letting go, never during a drag.

## Export formats

"Export stencil" in the design panel opens a sheet with three formats:

| Format | Size information | For |
|---|---|---|
| Stencil PDF | Printed at exact size on A4 or US Letter | Handing to the artist, printing at home |
| SVG | `width`/`height` in mm, vector kept | An artist who prints from their own software |
| PNG 300 dpi | pixel size = cm / 2.54 × 300, dpi stored in the file | Thermal stencil printers, tablets |

Options:

- Mirror for transfer paper: only for transfer methods that need a
  reversed print. A design mirrored on the body is already mirrored in
  the export; this flips it once more.
- Placement page (PDF only): a picture of the design on the body framed
  around it, with the area, height of the centre above the floor,
  rotation, distance to the nearest joints, how flat the spot is, and
  the body used.

The PDF:

- Says "print at 100% (actual size), never fit to page" and carries a
  5 cm and a 2 inch ruler to check the print.
- Centres the design on one page with crop marks when it fits.
- Otherwise splits it over several pages (the orientation with fewer
  pages wins), each tile overlapping its neighbours by 1 cm, with
  alignment crosses in the overlaps and a "Page 2 of 6: row 1, column 2"
  label on each.
- Embeds the design as a 300 dpi image. SVGs are rasterised at that
  resolution for the PDF; use the SVG export to keep vectors.

File names carry the size, for example
`rose_7.5x12cm_stencil.pdf` or `rose_7.5x12cm_mirrored.svg`.

## How it is checked

- `tests/pdf.test.ts`: the PDF writer makes files that `pypdf` reads, with
  pages in exact millimetres.
- `tests/stencil.test.ts`: page tiling, overlaps and the DPI written to
  PNG files.
- `e2e/stencil-export.mjs`: resizes in the browser (corner handle,
  Alt + scroll, two-finger pinch on a phone), exports all three formats,
  and reads the files back. One run: a 6.5 cm design printed at
  65.0 × 65.0 mm on an A4 page, SVG 65 mm, PNG 768 px at 300 dpi
  (6.5 / 2.54 × 300 = 768); a 45 cm design split over 8 US Letter
  pages.

## Still rough

- The PDF image is a 300 dpi raster. Vector output is in the SVG export.
- The placement picture uses the current viewing angle (or looks
  straight at the design if it faces away); it is a guide, not a
  measurement.
