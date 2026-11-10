# Color Script — Photoshop UXP plugin

A Photoshop panel that lays your images out as a colour-script page and colours each panel by mood,
with real Gradient Map adjustment layers you can keep editing. It also builds palette sheets
(dominant colours, hex labels, gradient strips) from any set of images.

**App:** Adobe Photoshop 2026 (24.2.0+) · **Type:** UXP panel (manifest v5)
**Repo:** https://github.com/fiorisims/pfa-week08

This branch (`isaac-fixes`) is the post-critique build. The 2026-11-03 class critique asked for
nine things; they are all here, plus the fixes and additions listed under "What changed".

## Using it

### Colour script tab
1. **Build Template...** — pick images, a page preset (11×17 landscape or portrait, 16:9 HD, A3,
   square) and a column count (1–8). Each image becomes a layer `Panel 01 - <file>`, scaled to fit
   its cell and centred. Colour images keep their colour; tick **Desaturate panels on import** for
   the old grayscale look. Tick **Keep the layers of PSD files** to import a PSD as a panel group
   with its layers intact. **Caption each panel** adds the file name under each panel.
   **Add images...** appends panels to the open template; **Re-flow panels** re-lays every panel
   with the current page and column settings (and resizes the canvas if the preset changed).
2. **Template panels** — every panel as a thumbnail chip, grouped by row. Tick the panels to
   colour; **All**, **None**, **Select row**, or Shift+click for a range. Clicking a chip selects
   its layer in Photoshop; the Layers panel selection also works.
3. **Mood** — thirteen mood buttons (Happy, Tense, Sad, Cautious, Calm, Angry, Eerie, Romantic,
   Nostalgic, Hopeful, Lonely, Triumphant, Dreamy). Each click rolls a variation of that mood and
   writes one **Gradient Map adjustment layer per checked panel, clipped to that panel**. The
   swatch strip shows the palette in use.
   - **Describe it in words** — type something like `eerie dawn, muted` and press Apply words. The
     panel blends the moods it recognises and applies modifiers (warm, cold, night, dawn, pastel,
     neon, stormy, ocean, forest, golden, the seasons, plain colour names...). The note under the
     swatches says what it understood. It is offline and deterministic: same words, same palette.
   - **From colour picker... / From foreground colour** — a custom four-stop ramp around one
     colour. Click any swatch to replace that stop with the current foreground colour.
   - **Lock palette** reuses the exact palette on every panel you colour next; **Reroll** makes
     another variation; **Apply this palette** colours the checked panels with what the strip shows.
   - **Gradient map for grayscale panels** (on): a grayscale panel is replaced by the ramp (Normal
     blend). A colour panel always gets a Color-blend map, which keeps its light and shadow.
   - **Line art** is detected per panel (ink and paper, or dark lines on transparency): the ink
     takes the shadow colour and the paper the light colour. Untick **fill the paper too** to
     colour only the lines.
   - **Split into shadows / midtones / highlights** writes three clipped maps per panel, each with
     a layer mask built from the panel's own luminance so it only touches its band, and each with
     its own strength slider. At 100% the three together read close to the single map; the
     differences sit in the transition zones between bands.
   - **Strength** is the adjustment layers' opacity. It applies to every checked panel (or the
     selected panel, its row in row mode, or every tint) and moves while you drag.
   - **Row variations** drifts the hue gently across a row. **Color range** widens or narrows how
     far a variation strays from the base mood. **Clear emotion tint** removes every tint.
4. **Export** — save the page as PNG or JPEG, save the current palette as an `.aco` swatch file
   (Window > Swatches > Import Swatches), or copy its hex codes.

### Palette sheet tab
**Build from images...** extracts the dominant colours of each image (deterministic k-means) and
draws a palette sheet into a new document: thumbnails, swatches, hex labels and gradient strips,
in one undo step. **Colors** per palette (2–16), **One palette for all images**, optional title.
**Build from layout JSON...** replays a spec written by `palette_sheet.build_sheet`.

### Settings tab
**Theme**: Frutiger Aero (default), Match Photoshop (follows the host theme), or one of the four
Photoshop greys. **Text size**: small, normal, large. Both are remembered.

## Installing

### Permanent (.ccx)
`tools/make-ccx.sh` packs `uxp-plugin/` into `dist/ColorScript-<version>.ccx`. Install it with
Adobe's installer agent, then restart Photoshop and open **Plugins > Color Script**.

macOS:
```
"/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent" --install dist/ColorScript-1.8.0.ccx
```
Windows:
```
& "C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /install dist\ColorScript-1.8.0.ccx
```

### Development
UXP Developer Tool → **Add Plugin...** → choose `uxp-plugin/` → **Load**. **Debug** opens the
console; **Watch** reloads on save.

## Tests
`node tests/run.mjs` runs the dependency-free tests for the pure modules (gradient-map
descriptors, pixel analysis, the mood interpreter). `tools/autotest.py` drives the real panel
inside Photoshop through `uxp-plugin/autotest.js` (inert unless an `autotest.json` job is placed
in the plugin's data folder); `tools/pstest.sh` wraps it.

## Files
```
uxp-plugin/
  manifest.json     plugin metadata (manifest v5, one panel entrypoint)
  index.html        the panel UI and styles (Aero default, Photoshop themes)
  index.js          template layout, palette sheet, panel picker, tint flows (batchPlay + Imaging API)
  gradientmap.js    Gradient Map descriptors, line-art and value-band stops, pixel analysis (pure)
  moods.js          the thirteen moods and the words interpreter (pure)
  features.js       tabs, settings, custom colours, picker controls, re-flow, add images, export
  autotest.js       developer self-test hook (does nothing without a job file)
  icons/            panel icon
tests/run.mjs       Node tests for the pure modules
tools/              make-ccx.sh, autotest.py, pstest.sh, reload.sh
```

## What changed in this build (from the 2026-11-03 critique and review)
- Template pages are RGB; imported images keep their colour (was: page created in Grayscale mode).
- Strength applies to every checked panel and updates while dragging (was: one panel, on release).
- Refresh re-scans the panels (was: it closed the document without saving).
- Tints are Gradient Map adjustment layers, clipped to their panel (was: pixel layers painted
  through a LUT, capped at 20 MP and rescaled).
- Line art, value bands, PSD layers, more moods, typed moods, custom colours, palette lock,
  page presets, captions, add images, re-flow, export, themes, text size, larger titles.
- Thumbnails fall back to the panel number instead of a broken image.
- One panel, three tabs; a two-line status; the unused network permission is gone.

## Notes and limits
- A Gradient Map maps luminance to the ramp. On a colour panel the map uses the Color blend mode,
  so the panel's own light and shadow stay; on a grayscale panel it replaces the pixels (Normal).
- Group panels (from PSD files) are analysed from the composite inside their bounds.
- Words are interpreted by a small built-in lexicon (see `moods.js`); unknown words are ignored and
  the note says so. No network, no account.
- The colour picker button uses Photoshop's own picker; if the host refuses it, the foreground
  colour is used and the status says so.
- The standalone `palette_gui.py` app remains the more feature-rich option for palette sheets
  (drag-to-arrange, crop, orientation).

## Peer run (from A6)
Irene's Peer Run: 

- The first issue I hit was that pygame crashed immediately the moment I clicked any button in the window, so I had opencode bypass that problem before I could use the tool at all.
- After that workaround, every feature and button worked and ran smoothly — loading images, sampling and building the palette, and saving the sheet — with the only remaining exception being the Photoshop export button.
- A nice touch was that each swatch displays its hex code, but the hex codes sometimes clip into the color palette area instead of staying fully inside their swatch.

Elise's Peer Run: 

- I installed Python and the dependencies needed to run palette_gui.py, then added an image to test the tool.
- The interface worked very well and successfully generated a color palette preview from my image.
- The interface is clear and easy to use, although a note about the recommended Python version would make setup even easier.

What Was Fixed:

-Changed it into a photoshop plugin that can run directly inside the program
-Removed the swatches/hexcode functions to make it work more like a proper color script creator which does not display those 
-Added gradient map functions based on mood temperatures
-Added function to select individual panels/layers within the interface to color them individually 

## Screen recording
https://drive.google.com/file/d/1x20Wj68gNZWWMd3UkDT0WfmcwiWYiUHo/view?usp=sharing

## Screen recording
https://drive.google.com/file/d/1x20Wj68gNZWWMd3UkDT0WfmcwiWYiUHo/view?usp=sharing
