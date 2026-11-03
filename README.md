# Color Script — Photoshop UXP Plugin

A Photoshop panel that builds grayscale color-script templates and palette sheets directly inside Photoshop. It is the "inside Photoshop" sibling of a standalone Python app: instead of the terminal driving Photoshop, the panel lives inside Photoshop as a UXP plugin.

**App:** Adobe Photoshop 2026 (24.2.0+)
**Type:** UXP Panel (manifest v5)
**Repo:** https://github.com/fiorisims/pfa-week08

## What it does

### Color Script Template
Pick images and a column count (2–5). The panel creates a **grayscale** 11×17 in, 150 ppi (2550×1650 px) landscape page and lays the images out as an evenly spaced panel grid: scaled to fit, centred, with no swatches, hex labels, captions or title. Each image becomes its own layer named `Panel 01 - <file>`, `Panel 02 - <file>`, ... and the first panel is selected when the build finishes.

- **Template panels picker**: A card lists every panel as a thumbnail chip, grouped by visual row. Check the box next to a panel to select it for coloring. Click a chip to select that panel in Photoshop. The Layers panel selection also works and wins when a panel layer is selected.
- **Mood per panel**: Select one or more panels (checkboxes or Layers panel), then click **Happy**, **Tense**, **Sad** or **Cautious**. The panel writes a gradient-map overlay clipped to that panel only. Selecting another mood rerolls that panel.
- **Whole row, slight variations** (checkbox): tints every panel in a selected panel's row in one undo step, with a gentle left-to-right hue drift.
- **Strength** (10–100%): adjusts tint opacity.
- **Color range** (0–200%): scales the hue/saturation/lightness spread of the emotion palette.
- **Clear emotion tint**: removes all tints.

### Build Template (Palette Sheet)
Pick one or more images (PNG, JPG, GIF, BMP, TIF, WEBP, PSD, PSB). The panel extracts dominant colors from each image using k-means clustering and builds a palette sheet with color swatches, hex labels, and gradient strips.

- **Colors**: How many dominant colors to extract per image (2–16, default 6).
- **One palette for all images**: Merges all images into a single shared palette.
- **Sheet title**: Optional title at the top.

### Emotion Color
Colorizes the active document or imported grayscale images with mood-based gradient maps. Import grayscale images, then click a mood to apply the same gradient map to all of them.

## How to install and run

### Prerequisites
- Adobe Photoshop 2026 (24.2.0 or later)
- UXP Developer Tool (or install the packaged .ccx)

### Development (UXP Developer Tool)
1. Download or clone this repo.
2. Open the UXP Developer Tool and sign in with your Adobe ID.
3. Click **Add Plugin…** and choose the `uxp-plugin/` folder.
4. Click **• • • → Load**. Photoshop opens the **Color Script** panel.
5. Use **• • • → Debug** for the console, or **• • • → Watch** to reload on save.

### Permanent install (.ccx)
```powershell
& "C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" /install "path\to\ColorScript-<version>.ccx"
```
Then restart Photoshop and open **Plugins > Color Script**.

## What doesn't work yet
- The `.ccx` package is not included in this repo; you need to build it from the `uxp-plugin/` folder or use the UXP Developer Tool.
- Template pages are whole-page only — no crop tool.
- PSD/PSB inputs contribute their flattened composite only.
- Strength changes apply to the selected panel/row; there is no per-tint strength.
- The standalone Python app (`palette_gui.py`) remains the more feature-rich option with drag-to-arrange, crop, orientation, and .aco export.
- Due to running into issues with running out of free usage, I was unable to fix the "Import template" feature, so at the moment they will be imported in grayscale by default. I will fix this when I have enough free usage to do so.
- Similarly to last comment, another thing that does not work properly is the sliding scale that changes the color range. This may also be because of the values of the images I picked. I will have to troubleshoot that. 

## What I'd build next
- Add a crop tool for template panels.
- Per-tint strength control.
- Export color palettes as .aco swatch files directly from the panel.
- Support for adjusting panel positions by dragging in the Photoshop canvas.
- Add more emotion moods and allow custom mood palettes.

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

## Files
```
uxp-plugin/
  manifest.json     plugin metadata (manifest v5, one panel entrypoint)
  index.html        the panel UI (Frutiger Aero styling)
  index.js          colour extraction + layout + batchPlay drawing
  README.md         detailed plugin documentation
  icons/            panel icon (@1x and @2x)
```
