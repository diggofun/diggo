"""Trim the transparent padding off the Diggo pickaxe mark.

The generated mark-1024.png is a square canvas whose artwork only fills the middle ~50%, because
the generator centres the mark inside a fixed 1024px square. Rendered at a fixed CSS box size that
padding halves the pickaxe the user actually sees, so every surface that shows the logo looked
undersized. Trimming to the alpha bounding box makes the box size mean the mark size, which is what
the header and sidebar sizes are written against.

Pillow only, no AI: this is a crop-and-resample of the shipped asset.

Usage: python scripts/brand/trim-mark.py
Writes: public/assets/brand/mark-trim-512.png
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "public" / "assets" / "brand" / "mark-1024.png"
TARGET = ROOT / "public" / "assets" / "brand" / "mark-trim-512.png"


def main() -> None:
    image = Image.open(SOURCE).convert("RGBA")
    bbox = image.split()[-1].getbbox()
    if bbox is None:
        raise SystemExit("mark-1024.png has no opaque pixels; nothing to trim")

    trimmed = image.crop(bbox)
    # Square it on the long edge so the aspect ratio the sizes assume is preserved.
    side = max(trimmed.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(trimmed, ((side - trimmed.width) // 2, (side - trimmed.height) // 2))

    square.resize((512, 512), Image.LANCZOS).save(TARGET, optimize=True)
    print(f"{SOURCE.name} {image.size} bbox={bbox} -> {TARGET.name} 512x512")


if __name__ == "__main__":
    main()
