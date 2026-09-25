"""Rebuild the tightly trimmed Diggo mark used by the site header, sidebar and /diggo page.

The trimmed mark is now produced by make-brand-assets.py straight from the source artwork (so it
shares the transparent, halo-free cutout); this entry point is kept for the old command.

Usage: python scripts/brand/trim-mark.py
Writes: public/assets/brand/mark-trim-512.png (and the other "marks" outputs)
"""

import runpy
import sys
from pathlib import Path

if __name__ == "__main__":
    sys.argv = [sys.argv[0], "marks"]
    runpy.run_path(str(Path(__file__).with_name("make-brand-assets.py")), run_name="__main__")
