"""
The one place the new Diggo pickaxe mark is turned into pixels.

The source is a flat two-colour illustration - a black head and an orange handle on a white
field - so the white is removed by solving the white-blend equation per pixel against each of
the two inks and keeping whichever fits better. That recovers a genuinely antialiased alpha
instead of a hard threshold, and the resolved colour is the flat ink itself, so every asset
built from here stays exactly the artwork that was supplied: nothing is redrawn, traced or
recoloured.
"""

from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
BRAND = REPO / "public" / "assets" / "brand"

# The two inks the source artwork is printed in, read off its own histogram.
INK_HEAD = (35.0, 33.0, 34.0)
INK_HANDLE = (240.0, 118.0, 35.0)

# The site's own tokens, so the mark and the card sit in the same palette as the UI.
PAPER = (241, 238, 228)
INK = (23, 24, 19)
ACID = (215, 255, 63)
WHITE = (255, 255, 255)

DISPLAY_FONT = r"C:\Windows\Fonts\ariblk.ttf"   # --font-display: Arial Black
BOLD_FONT = r"C:\Windows\Fonts\arialbd.ttf"
MONO_FONT = r"C:\Windows\Fonts\consolab.ttf"


def cut_out(source):
    """Unmix the white field, leaving a flat-coloured mark with an antialiased alpha."""
    rgb = np.asarray(Image.open(source).convert("RGB")).astype(np.float64)
    best_error = np.full(rgb.shape[:2], np.inf)
    alpha = np.zeros(rgb.shape[:2])
    colour = np.zeros_like(rgb)

    for ink in (INK_HEAD, INK_HANDLE):
        flat = np.array(ink, dtype=np.float64)
        # P = a * ink + (1 - a) * 255, solved per channel and averaged over the three.
        per_channel = np.clip((255.0 - rgb) / (255.0 - flat), 0.0, 1.0)
        candidate = per_channel.mean(axis=2)
        predicted = candidate[:, :, None] * flat + (1.0 - candidate)[:, :, None] * 255.0
        error = ((rgb - predicted) ** 2).mean(axis=2)
        wins = error < best_error
        best_error = np.where(wins, error, best_error)
        alpha = np.where(wins, candidate, alpha)
        colour = np.where(wins[:, :, None], flat, colour)

    alpha[alpha < 0.004] = 0.0
    out = np.dstack([colour, alpha * 255.0])
    # Fully transparent pixels keep an ink colour, never white, so a later premultiply of a
    # downscaled edge can never drag a white halo in.
    return Image.fromarray(out.astype(np.uint8), "RGBA")


def resize(image, size):
    """Resample in premultiplied space, so a new edge never picks up a dark fringe."""
    side = int(size)
    data = np.asarray(image).astype(np.float64)
    alpha = data[:, :, 3:4] / 255.0
    premultiplied = np.dstack([data[:, :, :3] * alpha, data[:, :, 3:4]])
    resized = Image.fromarray(premultiplied.astype(np.uint8), "RGBA").resize(
        (side, side), Image.LANCZOS
    )
    out = np.asarray(resized).astype(np.float64)
    out_alpha = np.clip(out[:, :, 3:4] / 255.0, 0.0, 1.0)
    safe = np.where(out_alpha > 0.0001, out_alpha, 1.0)
    straight = np.dstack([np.clip(out[:, :, :3] / safe, 0, 255), out_alpha * 255.0])
    return Image.fromarray(straight.astype(np.uint8), "RGBA")


def trim_square(mark):
    """The tight square bounding box of the visible mark, with no padding added."""
    box = mark.getchannel("A").point(lambda v: 255 if v > 2 else 0).getbbox()
    mark = mark.crop(box)
    return square_centred(mark)


def square_centred(mark):
    """The mark alone on a transparent square whose centre is the mark's own centre.

    Centring on the mark's centroid-of-ink rather than on its bounding box is what keeps a
    diagonal artwork centred: a diagonal pickaxe has very little ink at one corner, so the
    bounding box is not symmetric about the mass, and centring the box would leave the mark
    visibly off to one side.
    """
    alpha = np.asarray(mark.getchannel("A")).astype(np.float64)
    total = alpha.sum()
    if total <= 0:
        raise ValueError("mark is empty")
    ys, xs = np.nonzero(alpha > 0)
    centre_x = float((xs * alpha[ys, xs]).sum() / total)
    centre_y = float((ys * alpha[ys, xs]).sum() / total)
    # A square that circumscribes the mark about that centre, so nothing is clipped.
    side = 2 * int(np.ceil(np.hypot(xs - centre_x, ys - centre_y).max())) + 2
    canvas = Image.new("RGBA", (side, side), (255, 255, 255, 0))
    canvas.paste(
        mark,
        (int(round(side / 2 - centre_x)), int(round(side / 2 - centre_y))),
    )
    return canvas


def corner_radius(mark):
    """The farthest opaque pixel, as a fraction of the square's side.

    The mark is a diagonal, so its bounding box is a square that the artwork only partly
    fills - measuring the box alone would badly understate how far the tips reach, and
    wallets that crop icons round will cut those tips off first.
    """
    alpha = np.asarray(mark.getchannel("A"))
    ys, xs = np.nonzero(alpha > 8)
    centre = (mark.width - 1) / 2.0
    return float(np.hypot(xs - centre, ys - centre).max()) / mark.width


def fit(mark, size, max_radius=None, fraction=None):
    """The largest size the mark can be drawn at on a square canvas without breaking a limit.

    Both limits are optional and the stricter one wins, so one call covers "fill the canvas
    unless that would push a tip outside the safe circle". max_radius is in canvas pixels;
    fraction is the share of the canvas edge the mark's bounding box may span.
    """
    limits = []
    if fraction is not None:
        limits.append(size * (1.0 - 2.0 * fraction))
    if max_radius is not None:
        # The mark's own farthest pixel sits at corner_radius * (drawn size) from the centre,
        # so the drawn size that keeps it inside max_radius is max_radius / corner_radius.
        limits.append(max_radius / corner_radius(mark))
    chosen = round(min(limits))
    if chosen < 8:
        raise ValueError(
            "fit() would draw the mark at " + str(chosen) + "px on a " + str(size) +
            "px canvas; the limits are inconsistent"
        )
    return chosen


def padded(mark, size, fraction):
    """The mark on a transparent square, with fraction of the side empty on each edge."""
    inner = max(1, round(size * (1.0 - 2.0 * fraction)))
    canvas = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    scaled = resize(mark, inner)
    canvas.paste(scaled, ((size - inner) // 2, (size - inner) // 2), scaled)
    return canvas


def tile(mark, size, inset):
    """A full-bleed opaque white tile, used where the platform paints its own mask.

    Full bleed on purpose: iOS and Android round and crop the icon themselves, so a corner
    that is already rounded here would only end up rounded twice.
    """
    inner = max(1, round(size * (1.0 - 2.0 * inset)))
    canvas = Image.new("RGB", (size, size), WHITE)
    scaled = resize(mark, inner)
    canvas.paste(scaled, ((size - inner) // 2, (size - inner) // 2), scaled)
    return canvas
