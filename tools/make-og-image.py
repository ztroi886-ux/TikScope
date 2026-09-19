"""Draw the link preview card that WhatsApp, Telegram and Facebook show.

Usage:
    python tools/make-og-image.py

Writes media/og-cover.jpg at 1200x630, the size every scraper crops to.

The hero photographs are 941x1672 portrait, the wrong shape entirely, so this
takes a landscape band out of one, lays the site's own scrim over it and sets
the wordmark on top — the same treatment the homepage gives the hero, at the
proportions a shared link needs.
"""
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("Pillow is required:  pip install pillow")

SOURCE = os.path.join("hero-sources", "stockholm.png")
DEST = os.path.join("media", "og-cover.jpg")
W, H = 1200, 630

INK = (11, 27, 51)
TEAL = (12, 134, 168)
WHITE = (255, 255, 255)

TITLE = "Opportunity Has No Borders"
SUB = "ARYOS GROUP  ·  INTERNATIONAL RECRUITMENT"


def font(names, size):
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main():
    if not os.path.isfile(SOURCE):
        sys.exit("No such file: %s" % SOURCE)

    src = Image.open(SOURCE).convert("RGB")

    # Cover-crop to 1200x630, biased above centre: the horizon and skyline sit
    # in the upper half of these shots and a centred crop lands on empty water.
    scale = max(W / src.width, H / src.height)
    src = src.resize((round(src.width * scale), round(src.height * scale)),
                     Image.LANCZOS)
    left = (src.width - W) // 2
    top = int((src.height - H) * 0.32)
    card = src.crop((left, top, left + W, top + H))

    # The homepage scrim: dark at the foot, clear at the head, so type stays
    # legible without flattening the photograph.
    scrim = Image.new("L", (1, H))
    for y in range(H):
        t = y / (H - 1)
        scrim.putpixel((0, y), int(20 + 205 * (t ** 1.6)))
    scrim = scrim.resize((W, H))
    card = Image.composite(Image.new("RGB", (W, H), INK), card, scrim)

    d = ImageDraw.Draw(card)
    title_f = font(["segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"], 76)
    sub_f = font(["segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"], 26)

    margin = 72
    # The logo bar, same proportions as .logo__mark on the site.
    bar_h = 34
    baseline = H - margin - 30
    d.rectangle([margin, baseline - bar_h + 4, margin + 7, baseline + 8], fill=TEAL)
    d.text((margin + 26, baseline - bar_h + 2), SUB, font=sub_f, fill=(214, 226, 238))

    # Title sits above the strapline, wrapped by hand at the natural break.
    lines = ["Opportunity Has", "No Borders."]
    y = baseline - bar_h - 26
    for line in reversed(lines):
        box = d.textbbox((0, 0), line, font=title_f)
        y -= (box[3] - box[1]) + 26
        d.text((margin, y), line, font=title_f, fill=WHITE)

    card.save(DEST, "JPEG", quality=86, optimize=True, progressive=True)
    print("  %s  %dx%d  %.1f KB" % (DEST, W, H, os.path.getsize(DEST) / 1024))


if __name__ == "__main__":
    main()
