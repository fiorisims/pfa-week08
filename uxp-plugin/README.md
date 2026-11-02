# Color Script — UXP plugin

A Photoshop **panel** that builds grayscale color script templates and palette
sheets inside the open document. It is the "inside Photoshop" sibling of the
standalone `palette_gui.py` app: instead of the terminal driving Photoshop, the
panel lives inside Photoshop.

```
manifest.json     plugin metadata (manifest v5, one panel entrypoint)
index.html        the panel UI
index.js          colour extraction + layout + batchPlay drawing
icons/            panel icon (@1x and @2x)
```

## What it does

1. **Color script template** — pick images and a column count (2–5). The panel
   creates a **grayscale** 11×17 in, 150 ppi (2550×1650 px) landscape page and
   lays the images out as an evenly spaced panel grid: scaled to fit, centred,
   with no swatches, hex labels, captions or title. Each image becomes its own
   layer named `Panel 01 - <file>`, `Panel 02 - <file>`, ... and the first panel
   is selected when the build finishes. The status line at the top of the panel
   reports progress and any panel that could not be placed.
   - **Template panels picker**: a **Template panels** card lists every
     panel as a thumbnail chip, grouped by visual row. Click a chip to select
     that panel in Photoshop, or keep using the Layers panel - a selected
     panel/tint layer always wins over the chip. Thumbnails are cached per
     document. On Photoshop versions without `imaging.encodeImageData` (or if
     a thumbnail fails) the chip shows its panel number instead. Use
     **Refresh** after opening a different template or changing the panel set.
   - **Mood per panel**: click a panel chip or select its layer, then click
     **Happy**, **Tense**, **Sad** or **Cautious**. The panel writes a
     gradient-map overlay clipped to that panel only (named
     `Emotion tint - Happy - Panel 03`, etc.). Selecting the panel or its
     overlay and clicking another mood rerolls that panel; other panels keep
     their own overlays. A template is never tinted as one whole document.
   - **Whole row, slight variations** (checkbox): with this on, a mood click
     finds the selected panel's row, tints every panel in it in one undo
     step, and drifts the base palette gently from left to right (about
     +/-4 degrees of hue plus a tiny wobble). **Strength** updates every tint
     in that row while the checkbox is on.
2. **Build from images...** — pick one or more images (`png`, `jpg`, `gif`,
   `bmp`, `tif`, `webp`, `psd`, `psb`, ...). The panel reads a small preview of
   each file, extracts its dominant colours (same deterministic k-means as
   `palette_sheet.py`), plans the layout and draws the sheet into a new
   **Color Script** document: background, source-image thumbnails, one
   swatch-fill layer per palette, captions + hex labels on top, then the
   gradient strips. All of it runs inside one `executeAsModal` scope with a
   single suspended history state.
3. **Build from layout JSON...** — replay a spec written by
   `palette_sheet.build_sheet` (the same spec `photoshop_palette.jsx` uses).
4. **Emotion color** — in a color script template this works per selected
   panel (see above). Otherwise it colorizes the **active document** with one
   click, or imports a grayscale image first. **Happy**, **Tense**, **Sad** or
   **Cautious** each generate a new palette close to that mood's four-stop
   ramp; the swatch strip under the buttons shows it. The panel maps the
   document's luminance onto that ramp and writes one non-destructive layer.
   - **Import grayscale images...** — multi-select one or more image files
     (already-open files are reused). The panel opens them, reports which are
     grayscale, and waits: no gradient layer is created until you click a
     mood. That single click adds the **same** gradient-map layer (one shared
     palette) on top of every imported image. The import flow always uses the
     gradient map, even when an image is not detected as grayscale (the status
     says so). Click another mood to reroll all of them; switching to a
     document outside the imported set or **Clear emotion tint** exits the
     flow (Clear removes the tints from all imported images).
   - **Gradient map for grayscale** (on by default): if the active image is
     detected as grayscale — a grayscale/bitmap/duotone document, or an RGB
     composite with no chroma — the ramp replaces it through a **Normal**
     layer, which is a true gradient map.
   - Otherwise (or when the box is off) it writes a **Color**-blend layer, so
     the original light, shadow and alpha are kept.
   **Strength** sets the layer's opacity (10–100%, live); in a template it
   changes the selected panel's overlay, or the whole selected row when row
   mode is on. Clicking another mood replaces the previous tint and **Clear
   emotion tint** removes every tint (or the tint from every imported image).

Palette-sheet options: **Colors** per palette (2–16), **Sheet title**
(optional) and **One palette for all images** (one merged palette instead of
one per file).

The layout maths mirror `palette_sheet.plan_layout`, so the panel, the
standalone app and the `.jsx` renderer produce the same sheet.

## Panel look

The panel uses its own **Frutiger Aero** styling (sky-to-water gradient, glass
cards, gel buttons, glossy aqua controls) instead of inheriting the Photoshop
theme. It is plain HTML/CSS in `index.html`, so it can be restyled freely; the
only requirements are that the element IDs used by `index.js` stay the same
(`btnTemplate`, `optEmotionStrength`, `status`, ...) and that numeric fields
keep a readable `.value`, checkboxes `.checked`, and buttons fire `click`.

The panel content scrolls in its own `#scroll` container. Use the mouse wheel
or scrollbar; if your host does not deliver wheel events to UXP panels, the
round arrow buttons at the bottom-right scroll up and down. They appear only
when the panel is shorter than the content.

## Loading it

### Permanent (recommended)

Install the packaged `.ccx` — it survives Photoshop and UDT restarts:

```powershell
& "C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /install "path\to\ColorScript-<version>.ccx"
```

Then restart Photoshop and open **Plugins > Color Script**.

### Development

1. Open the UXP Developer Tool and sign in with the same Adobe ID as Photoshop.
2. **Add Plugin…** → choose this `uxp-plugin/` folder (manifest v5 is read automatically).
3. Click **• • • → Load**. Photoshop opens the **Color Script** panel.
4. Use **• • • → Debug** for the console, or **• • • → Watch** to reload on save.

## Notes / current limits

- Text uses the Photoshop DOM (`createTextLayer`, `paragraphStyle`,
  `characterStyle`), so the sheet text is real, editable type — not raster.
- Gradient strips are painted with the UXP Imaging API (no temporary PNGs).
- Emotion tints are computed per pixel with the same Imaging API (8-bit RGB
  read of the composite), then placed on a new layer; documents above 20 MP
  are read at a reduced size and the tint layer is scaled back to the canvas.
  Grayscale/CMYK documents are converted to RGB first so the tint can be
  written (bitmap and duotone go through grayscale).
- Grayscale detection samples the composite, ignores transparent pixels and
  tolerates a tiny colored mark; document modes grayscale/bitmap/duotone are
  trusted directly. Gradient-map mode is a luminance LUT drawn on a Normal
  layer — the scriptable equivalent of a Gradient Map adjustment layer, whose
  gradient cannot be set through Action Manager in current Photoshop versions.
  The explicit **Import grayscale images...** flow uses the same check for its
  status but always forces the gradient map once a mood is chosen, applying the
  same palette to every selected image.
- Random palettes shift all four stops by a wider hue/saturation/lightness
  amount and tilt the hue across the ramp, so each click explores more color
  while the mood stays recognizable.
- Template panels are rasterized after placement. The page is created in
  Grayscale mode, so the placed and rasterized panels are already true
  grayscale pixels for the per-panel tint; no separate Desaturate command is
  used. The tint layer sits directly above its panel and is clipped to it, so
  painting one panel never affects its neighbours.
- The template panel thumbnails use imaging.encodeImageData (Photoshop
  24.4+) at a 96x72 preview and are cached by document/layer id. On an older
  host or if a panel cannot be read, the chip keeps its numbered placeholder.
  A row mood click and its per-panel variations share one suspended history
  state, so a single undo removes the whole row.
- Images and template panels are placed through the **File entries returned by
  the picker** (session token + `placeEvent`). Rebuilding a file path into a
  `getEntryWithUrl` entry can be denied by UXP's `request` filesystem
  permission, which used to make the template build produce an empty page. If
  `placeEvent` fails, the panel falls back to opening the file and duplicating
  its flattened layer into the page.
- A document is treated as a template when it is named **Color Script
  Template** or contains a `Panel NN` layer; a mood click then requires
  exactly one selected panel. Template pages are whole-page only - there is no
  crop tool and no whole-document tint. **Strength** adjusts the tint of the
  selected panel (or its selected tint layer); **Clear emotion tint** removes
  every panel tint in the document.
- PSD/PSB inputs contribute their flattened composite.
- The standalone `palette_gui.py` remains the supported fallback and still
  offers the advanced options (orientation, shape, gap, crop, drag-to-arrange,
  `.aco` export, Photoshop send).
