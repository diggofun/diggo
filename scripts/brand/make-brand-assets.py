"""
Rebuilds every raster Diggo brand asset from the supplied pickaxe artwork.

    python scripts/brand/make-brand-assets.py

Run it with no arguments to regenerate everything, or name one output to rebuild just that:

    python scripts/brand/make-brand-assets.py og

Writes, all in place, under public/:
   assets/brand/mark-1024.png        transparent mark, trimmed and padded square
   assets/brand/mark-512.png         the same mark at half size
   assets/brand/icon-192.png         PWA / manifest icon
   assets/brand/icon-512.png
   assets/brand/maskable-512.png     the same mark inside the 80% safe zone
   assets/brand/apple-touch-icon.png
   assets/brand/favicon-16.png       raster favicons, for the browsers that prefer them
   assets/brand/favicon-32.png
   assets/brand/favicon-48.png
   assets/brand/favicon.svg          the mark embedded, so the old filename keeps working
   brand/diggo-token.png             1024 square token icon on white
   og-image-v2.png                   1200x630 social card: mark, wordmark, tagline
and the same token icon at ~/.diggo-mainnet/diggo-token.png.
"""

import base64
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from brandart import (
    ACID,
    BOLD_FONT,
    BRAND,
    DISPLAY_FONT,
    INK,
    MONO_FONT,
    PAPER,
    REPO,
    WHITE,
    cut_out,
    fit,
    padded,
    resize,
    tile,
    trim_square,
)

SOURCE = Path(r"C:\Users\Jurek\Downloads\image.png")
TOKEN_FOLDERS = [REPO / "public" / "brand", Path.home() / ".diggo-mainnet"]

# Wallets and launchers crop a round-ish icon over the top of whatever is supplied, so the
# mark is fitted to a circle rather than to a bounding box: the pickaxe's two tips are the
# first thing a circular crop would take, and they are what makes the mark recognisable.
#
# The two limits disagree, and the circle is the one that has to hold. A 72% bounding box puts
# the tips 0.72 * 1024 / 2 * 1.414 = 521px from the canvas centre, past the 490px allowed, so
# the mark is drawn at the largest size the circle permits (about 68% of the canvas edge) and
# the 72% request is deliberately not met.
SAFE_RADIUS = 490  # every opaque pixel stays inside a centred circle of this radius


def token_icon(mark, size):
    """The mark centred on white, drawn as large as the round-crop safe circle allows."""
    inner = fit(mark, size, max_radius=SAFE_RADIUS)
    canvas = Image.new("RGB", (size, size), WHITE)
    scaled = resize(mark, inner)
    canvas.paste(scaled, ((size - inner) // 2, (size - inner) // 2), scaled)
    return canvas


def write(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True)
    try:
        shown = path.relative_to(REPO)
    except ValueError:
        shown = path
    print("  wrote", shown, image.size)


def tracked(draw, xy, text, font, fill, tracking=0.0):
    """Draw text one glyph at a time, which is the only way to get real letter-spacing."""
    x, y = xy
    for glyph in text:
        draw.text((x, y), glyph, font=font, fill=fill)
        x += draw.textlength(glyph, font=font) + tracking
    return x - tracking


def social_card(mark):
    """1200x630: wordmark and tagline in a left column, the mark filling the right half."""
    width, height = 1200, 630
    card = Image.new("RGB", (width, height), PAPER)
    draw = ImageDraw.Draw(card)

    pad = 78
    # The mark fills the right half, cropped to nothing and scaled to the card's height so it
    # reads as artwork rather than as a second, smaller logo.
    mark_size = 470
    mark_art = resize(mark, mark_size)
    card.paste(mark_art, (width - mark_size - 96, (height - mark_size) // 2), mark_art)

    # The left column is laid out from measured text boxes rather than guessed baselines, so
    # the wordmark's descenders can never ride into the tagline on a different Pillow build.
    wordmark = ImageFont.truetype(DISPLAY_FONT, 112)
    tag = ImageFont.truetype(BOLD_FONT, 52)

    def line_box(font, text):
        left, top, right, bottom = font.getbbox(text)
        return left, top, right - left, bottom - top

    mark = line_box(wordmark, "Diggo")
    _, tagline_top, _, _ = line_box(tag, "Build your memecoin")

    column = 150
    gap = 44
    draw.text((pad - mark[0], column - mark[1]), "Diggo", font=wordmark, fill=INK)
    # The tagline starts below the wordmark's real ink, not below its font box.
    body = column + mark[3] + gap
    for index, line in enumerate(["Build your memecoin", "mining crew"]):
        _, top, _, _ = line_box(tag, line)
        draw.text((pad, body + index * 66 - top), line, font=tag, fill=INK)

    # The acid signature line the previous card carried, kept so the two cards still rhyme.
    foot = body + 2 * 66 + 34
    radius = 10
    draw.ellipse([pad, foot, pad + radius * 2, foot + radius * 2], fill=ACID)
    tracked(draw, (pad + 38, foot - 2), "DIGGO.FUN", ImageFont.truetype(MONO_FONT, 27), INK, 2.4)

    return card


def build_marks(mark):
    write(padded(mark, 1024, 0.03), BRAND / "mark-1024.png")
    write(padded(mark, 512, 0.03), BRAND / "mark-512.png")


def build_icons(mark):
    # The square app icons carry the mark a little larger, at 78% of the canvas edge.
    write(tile(mark, 192, 0.11), BRAND / "icon-192.png")
    write(tile(mark, 512, 0.11), BRAND / "icon-512.png")
    # A maskable icon has to survive an aggressive circular crop, so the mark sits well inside.
    write(tile(mark, 512, 0.22), BRAND / "maskable-512.png")
    # iOS rounds the icon itself, so the mark brings its own inset to survive the corners.
    write(tile(mark, 180, 0.11), BRAND / "apple-touch-icon.png")
    for size, inset in ((16, 0.03), (32, 0.04), (48, 0.05)):
        # Rasterised well above the target and then box-filtered down: at 16px the thin
        # handle is only a couple of pixels wide, and a single-step downscale either drops it
        # or smears the whole mark into a blob. Supersampling keeps the silhouette legible.
        # The inset stays a fraction of the canvas edge, so only the supersample factor is
        # scaled, never the padding itself.
        big = tile(mark, size * 8, inset)
        write(big.resize((size, size), Image.LANCZOS), BRAND / ("favicon-%d.png" % size))

    # favicon.svg is still referenced by index.html and by the wallet-connect icon list, and
    # the artwork is raster. Rather than hand-draw a vector that would only approximate the
    # mark, the exact rendered icon is embedded in the same filename.
    encoded = base64.b64encode((BRAND / "icon-512.png").read_bytes()).decode("ascii")
    markup = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" '
        'viewBox="0 0 512 512"><image width="512" height="512" '
        'xlink:href="data:image/png;base64,' + encoded + '" '
        'xmlns:xlink="http://www.w3.org/1999/xlink"/></svg>\n'
    )
    for path in (BRAND / "favicon.svg", REPO / "public" / "favicon.svg"):
        path.write_text(markup, encoding="utf-8")
        print("  wrote", path.relative_to(REPO), "(embedded mark)")


def build_token(mark):
    icon = token_icon(mark, 1024)
    for folder in TOKEN_FOLDERS:
        write(icon, folder / "diggo-token.png")


def main():
    if not SOURCE.exists():
        raise SystemExit("source artwork is missing: " + str(SOURCE))
    only = set(sys.argv[1:])
    mark = trim_square(cut_out(SOURCE))
    print("mark trimmed to", mark.size)
    steps = {
        "marks": lambda: build_marks(mark),
        "icons": lambda: build_icons(mark),
        "token": lambda: build_token(mark),
        "og": lambda: write(social_card(mark), REPO / "public" / "og-image-v2.png"),
    }
    for name, step in steps.items():
        if only and name not in only:
            continue
        print(name)
        step()


if __name__ == "__main__":
    main()
