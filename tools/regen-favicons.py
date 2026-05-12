#!/usr/bin/env python3
"""
regen-favicons.py — Regenerate all favicon files from a single source PNG.

Usage: python tools/regen-favicons.py <source.png>

Generates:
  public/favicon.ico             (multi-res: 16, 32, 48)
  public/favicon-16x16.png
  public/favicon-32x32.png
  public/favicon-48x48.png
  public/apple-touch-icon.png    (180x180)
  public/android-chrome-192x192.png
  public/android-chrome-512x512.png
"""
import sys
from pathlib import Path
from PIL import Image

if len(sys.argv) != 2:
    print(__doc__)
    sys.exit(1)

src_path = Path(sys.argv[1])
if not src_path.exists():
    print(f"Source not found: {src_path}")
    sys.exit(2)

out = Path("public")
raw = Image.open(src_path).convert("RGBA")
print(f"Source: {src_path}  size={raw.size}  mode={raw.mode}")

# Pad to square with transparent background so the icon isn't distorted on resize.
w, h = raw.size
side = max(w, h)
src = Image.new("RGBA", (side, side), (0, 0, 0, 0))
src.paste(raw, ((side - w) // 2, (side - h) // 2), raw)
print(f"Padded:  {src.size} (transparent square canvas)")

png_sizes = {
    "favicon-16x16.png": 16,
    "favicon-32x32.png": 32,
    "favicon-48x48.png": 48,
    "apple-touch-icon.png": 180,
    "android-chrome-192x192.png": 192,
    "android-chrome-512x512.png": 512,
}

for name, sz in png_sizes.items():
    img = src.resize((sz, sz), Image.LANCZOS)
    img.save(out / name, "PNG", optimize=True)
    print(f"  wrote {name} ({sz}x{sz})")

# favicon.ico — multi-res ICO (browsers pick the best)
ico_path = out / "favicon.ico"
ico_sizes = [(16, 16), (32, 32), (48, 48)]
src.save(ico_path, format="ICO", sizes=ico_sizes)
print(f"  wrote favicon.ico (multi-res: {ico_sizes})")
print("done.")
