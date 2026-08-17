#!/usr/bin/env python3
"""Regenerate every raster of the Verceil mark from a single clean master.

The icon set used to be exported with a soft drop shadow baked into the
pixels. At favicon sizes that shadow is wider than the mark's own edge, so a
32px tab icon spent a third of its area on grey haze and read as a smudge
rather than a logo. The same halo travelled into the PWA icons, the Apple
touch icon and the share card.

Everything here is derived from the alpha silhouette of logo.png, which is
shadow free: the mark is a hard-edged blue shape, and only the RGB of its
fully transparent pixels carries the old grey field. Resampling is done on
premultiplied alpha so those transparent pixels contribute nothing to the
downscaled edges — the source of the dark fringe you get from a naive resize.

Usage: python3 scripts/generate-icons.py   (needs Pillow, run from repo root)
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent

# Favicons and the standalone mark sit nearly edge to edge; the installable
# app icons keep the wider breathing room platforms expect around artwork.
FAVICON_FILL = 0.90
APP_ICON_FILL = 2 / 3
WHITE = (255, 255, 255)


def load_master():
    """logo.png with its alpha cleaned of sub-perceptual noise."""
    im = Image.open(ROOT / "logo.png").convert("RGBA")
    alpha = im.getchannel("A").point(lambda v: 0 if v < 16 else v)
    im.putalpha(alpha)
    return im


def mark_of(master):
    """The mark cropped to its own silhouette, with no surrounding field."""
    solid = master.getchannel("A").point(lambda v: 255 if v > 127 else 0)
    return master.crop(solid.getbbox())


def resize_rgba(im, size):
    """Lanczos resize that ignores the colour of transparent pixels."""
    r, g, b, a = im.split()
    premultiplied = Image.merge(
        "RGB", [Image.composite(ch, Image.new("L", im.size, 0), a) for ch in (r, g, b)]
    )
    premultiplied = premultiplied.resize(size, Image.LANCZOS)
    a = a.resize(size, Image.LANCZOS)

    out = premultiplied.load()
    alpha = a.load()
    for y in range(size[1]):
        for x in range(size[0]):
            av = alpha[x, y]
            if av in (0, 255):
                continue
            pr, pg, pb = out[x, y]
            out[x, y] = (
                min(255, pr * 255 // av),
                min(255, pg * 255 // av),
                min(255, pb * 255 // av),
            )
    premultiplied.putalpha(a)
    return premultiplied


def render(mark, size, fill, background=None):
    """The mark centred on a square canvas, scaled to `fill` of its width."""
    width = round(size * fill)
    height = max(1, round(mark.height * width / mark.width))
    scaled = resize_rgba(mark, (width, height))

    canvas = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    canvas.alpha_composite(scaled, ((size - width) // 2, (size - height) // 2))
    if background is None:
        return canvas
    flat = Image.new("RGBA", canvas.size, background + (255,))
    return Image.alpha_composite(flat, canvas).convert("RGB")


def write_logo(master):
    """Rewrite logo.png keeping its canvas, dropping the grey field.

    The transparent margin still carried the grey render backdrop in its RGB
    channels. Browsers honour the alpha and never showed it, but anything that
    flattens the file without compositing — Google's logo crawler among them —
    drew the mark on a grey card. Whitening those pixels makes the flattened
    result a clean white plate, and drops the file from 2MB to a fraction.
    """
    r, g, b, a = master.split()
    opaque = a.point(lambda v: 255 if v > 0 else 0)
    white = Image.new("L", master.size, 255)
    cleaned = Image.merge(
        "RGBA", [Image.composite(ch, white, opaque) for ch in (r, g, b)] + [a]
    )
    cleaned.save(ROOT / "logo.png", optimize=True)


def write_og_card(mark):
    """Repaint the share card's mark without its halo.

    The card is a smooth gradient behind the logo lockup, so the shadowed mark
    is lifted out by interpolating each row across the box from the untouched
    gradient either side of it, then the clean mark goes back in the same spot.
    """
    card = Image.open(ROOT / "og-card.png").convert("RGBA")
    left, top, right, bottom = 79, 68, 160, 141  # mark plus the old shadow's reach
    px = card.load()

    def sample(x0, y):
        cols = [px[x, y] for x in range(x0, x0 + 4)]
        return [sum(c[i] for c in cols) / len(cols) for i in range(3)]

    for y in range(top, bottom):
        a = sample(left - 5, y)
        b = sample(right + 1, y)
        for x in range(left, right):
            t = (x - left + 1) / (right - left + 1)
            px[x, y] = tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)

    width, height = 54, max(1, round(mark.height * 54 / mark.width))
    card.alpha_composite(resize_rgba(mark, (width, height)), (91, 80))
    # The card ships as a 256-colour PNG; keeping it paletted holds the share
    # image near 175KB instead of doubling it for a flat two-tone gradient.
    flat = card.convert("RGB").quantize(
        colors=256, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG
    )
    flat.save(ROOT / "og-card.png", optimize=True)


def main():
    master = load_master()
    mark = mark_of(master)

    render(mark, 160, FAVICON_FILL).save(ROOT / "logo-mark.png", optimize=True)
    for size in (96, 48, 32):
        render(mark, size, FAVICON_FILL).save(
            ROOT / f"favicon-{size}x{size}.png", optimize=True
        )

    ico = [render(mark, size, FAVICON_FILL) for size in (48, 32, 16)]
    ico[0].save(
        ROOT / "favicon.ico",
        sizes=[(48, 48), (32, 32), (16, 16)],
        append_images=ico[1:],
    )

    render(mark, 180, APP_ICON_FILL, WHITE).save(
        ROOT / "apple-touch-icon.png", optimize=True
    )
    for size in (192, 512):
        render(mark, size, APP_ICON_FILL, WHITE).save(
            ROOT / f"icon-{size}.png", optimize=True
        )

    write_og_card(mark)
    write_logo(master)


if __name__ == "__main__":
    main()
