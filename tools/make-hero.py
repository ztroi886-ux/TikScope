"""Generate the four responsive widths for a hero image.

Usage:
    python tools/make-hero.py media/hero-source.jpg hero-2

Produces media/hero-2-{480,750,1080,1280}.{jpg,webp}, then add the base name
to data-hero-slides in index.html:

    <div class="hero__media" data-hero-slides="hero-poster, hero-2">

Quality is tuned low on purpose: the hero sits under a 74-92% dark scrim, so
compression artefacts are invisible and the bytes matter far more. A phone
ends up downloading roughly 35 KB per slide instead of 150 KB.
"""
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required:  pip install pillow")

# width -> (jpeg quality, webp quality)
SIZES = {480: (62, 46), 750: (60, 44), 1080: (64, 50), 1280: (68, 55)}


def main(argv):
    if len(argv) != 3:
        sys.exit(__doc__)
    source, name = argv[1], argv[2]
    if not os.path.isfile(source):
        sys.exit("No such file: %s" % source)

    out_dir = "media"
    os.makedirs(out_dir, exist_ok=True)

    src = Image.open(source).convert("RGB")
    w0, h0 = src.size

    # Never enlarge. Upscaling in the encoder bakes softness into the file and
    # costs bytes for quality that is not there; letting the browser stretch
    # the largest real size looks the same and downloads far less. The srcset
    # simply stops at whatever the source can honestly supply.
    widths = sorted(w for w in SIZES if w <= w0)
    if not widths or max(widths) < w0:
        widths.append(w0)          # keep the full native size as the top step
    widths = sorted(set(widths))

    if w0 < 1280:
        print("  ! source is only %dpx wide." % w0)
        print("    Largest size generated is %dpx, so the hero will look soft" % max(widths))
        print("    on a desktop or retina screen. A 1600px+ original is better.")

    made = []
    for width in widths:
        qj, qw = SIZES.get(width, (68, 55))
        height = round(h0 * width / w0)
        im = src if width == w0 else src.resize((width, height), Image.LANCZOS)
        jpg = os.path.join(out_dir, "%s-%d.jpg" % (name, width))
        webp = os.path.join(out_dir, "%s-%d.webp" % (name, width))
        im.save(jpg, "JPEG", quality=qj, optimize=True, progressive=True)
        im.save(webp, "WEBP", quality=qw, method=6)
        made += [jpg, webp]

    for path in made:
        print("  %-34s %6.1f KB" % (path, os.path.getsize(path) / 1024))
    print("\n  widths: %s" % ", ".join(str(w) for w in widths))
    print("  Now add '%s' to data-hero-slides in index.html." % name)


if __name__ == "__main__":
    main(sys.argv)
