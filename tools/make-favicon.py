"""Draw the site icon: the header lockup reduced to what survives at 16px.

Usage:
    python tools/make-favicon.py

Writes favicon.ico (16/32/48) at the project root, plus media/favicon.svg and
media/apple-touch-icon.png. Root is where browsers probe for favicon.ico
without being told, and it is already on app.py's PUBLIC_FILES allowlist; the
other two sit under media/, which that allowlist admits by extension. So this
adds no new public path.

The full lockup is a teal bar next to ARYOS / GROUP stacked. Two lines of type
turn to mud below about 48px, so the icon keeps the bar -- the one piece of the
brand that is a shape rather than a word -- and the A beside it.
"""
import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("Pillow is required:  pip install pillow")

INK = (11, 27, 51)       # --ink
TEAL = (12, 134, 168)    # --teal
WHITE = (255, 255, 255)

# Geometry on a 32x32 grid, scaled up for each output size.
GRID = 32.0
RADIUS = 7.0
BAR = (6.0, 7.0, 9.5, 25.0)          # x0, y0, x1, y1
A_APEX = (20.3, 7.6)
A_FEET = ((14.0, 25.2), (26.6, 25.2))
A_STROKE = 3.3
A_BAR_Y = 19.8
A_BAR = (16.4, 24.2)


def draw(size, supersample=8):
    """Render one square icon. Drawn large and reduced, for clean edges."""
    px = size * supersample
    k = px / GRID
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([0, 0, px - 1, px - 1], radius=RADIUS * k, fill=INK)

    # The logo bar. Square-ended, like .logo__mark in the active theme.
    d.rectangle([BAR[0] * k, BAR[1] * k, BAR[2] * k, BAR[3] * k], fill=TEAL)

    # The A, as strokes rather than type: no font to depend on, and the weight
    # stays even when the whole thing is 16 pixels wide.
    w = max(1, round(A_STROKE * k))
    for foot in A_FEET:
        d.line([A_APEX[0] * k, A_APEX[1] * k, foot[0] * k, foot[1] * k],
               fill=WHITE, width=w, joint="curve")
    # Round off the three ends by hand; PIL has no line cap.
    for pt in (A_APEX,) + A_FEET:
        d.ellipse([pt[0] * k - w / 2, pt[1] * k - w / 2,
                   pt[0] * k + w / 2, pt[1] * k + w / 2], fill=WHITE)
    d.line([A_BAR[0] * k, A_BAR_Y * k, A_BAR[1] * k, A_BAR_Y * k],
           fill=WHITE, width=max(1, round(3.0 * k)))

    return img.resize((size, size), Image.LANCZOS)


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#0B1B33"/>
  <rect x="6" y="7" width="3.5" height="18" fill="#0C86A8"/>
  <path d="M14 25.2 L20.3 7.6 L26.6 25.2" fill="none" stroke="#fff"
        stroke-width="3.3" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M16.4 19.8 H24.2" stroke="#fff" stroke-width="3"
        stroke-linecap="round"/>
</svg>
"""


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(root)

    ico = os.path.join(root, "favicon.ico")
    draw(48).save(ico, sizes=[(16, 16), (32, 32), (48, 48)])
    print("  favicon.ico            16/32/48  %5.1f KB" % (os.path.getsize(ico) / 1024))

    svg = os.path.join("media", "favicon.svg")
    with open(svg, "w", encoding="utf-8") as fh:
        fh.write(SVG)
    print("  media/favicon.svg      vector    %5.1f KB" % (os.path.getsize(svg) / 1024))

    # iOS crops to its own rounded mask, so this one is drawn square-cornered
    # on a filled ground rather than transparent outside the radius.
    touch = draw(180)
    flat = Image.new("RGB", (180, 180), INK)
    flat.paste(touch, (0, 0), touch)
    png = os.path.join("media", "apple-touch-icon.png")
    flat.save(png, optimize=True)
    print("  media/apple-touch-icon.png 180px %5.1f KB" % (os.path.getsize(png) / 1024))


if __name__ == "__main__":
    main()
