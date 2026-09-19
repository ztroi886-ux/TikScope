"""Replace the whole hero slideshow from five source pictures.

    python tools/import-heroes.py

Put your five originals in hero-sources/ named exactly:

    stockholm.jpg   london.jpg   newyork.jpg   paris.jpg   rome.jpg

(.png / .jpeg / .webp work too — only the stem matters.)

The script then:
  * generates media/<name>-{480,750,1080,1280}.{jpg,webp} for each,
  * deletes the old derivatives it is replacing,
  * rewrites data-hero-slides in index.html with the widths it really made.

Stockholm becomes hero-poster because that is the first slide — the one in
the <picture> block that loads before anything else. Keeping the name means
index.html's markup needs no edit.

Quality is deliberately low: the hero sits under a 74-92% dark scrim, so
artefacts are invisible and the bytes are what matter.
"""
import os
import re
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required:  pip install pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Deliberately NOT under media/: everything in media/ is publicly served, so
# originals kept there would be downloadable in full (several MB each).
SOURCE_DIR = os.path.join(ROOT, "hero-sources")
MEDIA_DIR = os.path.join(ROOT, "media")
INDEX = os.path.join(ROOT, "index.html")

# source stem -> hero base name, in the order the slideshow should cycle
MAPPING = [
    ("stockholm", "hero-poster"),
    ("rome",      "hero-rome"),
    ("london",    "hero-london"),
    ("paris",     "hero-paris"),
    ("newyork",   "hero-newyork"),
]

# width -> (jpeg quality, webp quality)
SIZES = {480: (62, 46), 750: (60, 44), 1080: (64, 50), 1280: (68, 55)}

# A source narrower than 1280 adds its own native width as the top step. That
# step is the biggest file and, on a retina phone, the one most visitors
# actually download — so it gets the *lowest* quality, not the default high
# one. Under the hero's dark scrim the difference is invisible.
ODD_WIDTH_QUALITY = (56, 40)
EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff")


def find_source(stem):
    for ext in EXTS:
        for candidate in (stem + ext, stem + ext.upper()):
            path = os.path.join(SOURCE_DIR, candidate)
            if os.path.isfile(path):
                return path
    return None


def clear_old(name):
    """Remove previous derivatives so a shorter new set leaves nothing stale."""
    pattern = re.compile(re.escape(name) + r"-\d+\.(jpg|webp)$", re.I)
    for f in os.listdir(MEDIA_DIR):
        if pattern.fullmatch(f):
            try:
                os.remove(os.path.join(MEDIA_DIR, f))
            except OSError:
                pass


def build(path, name):
    src = Image.open(path).convert("RGB")
    w0, h0 = src.size

    # Never enlarge: upscaling bakes in softness and costs bytes for detail
    # that is not in the file. The srcset just stops at what the source has.
    widths = sorted(w for w in SIZES if w <= w0)
    if not widths or max(widths) < w0:
        widths.append(w0)
    widths = sorted(set(widths))

    clear_old(name)

    total = 0
    for width in widths:
        qj, qw = SIZES.get(width, ODD_WIDTH_QUALITY)
        height = round(h0 * width / w0)
        im = src if width == w0 else src.resize((width, height), Image.LANCZOS)
        jpg = os.path.join(MEDIA_DIR, "%s-%d.jpg" % (name, width))
        webp = os.path.join(MEDIA_DIR, "%s-%d.webp" % (name, width))
        im.save(jpg, "JPEG", quality=qj, optimize=True, progressive=True)
        im.save(webp, "WEBP", quality=qw, method=6)
        total += os.path.getsize(jpg) + os.path.getsize(webp)

    note = ""
    if w0 < 1280:
        note = "  (source only %dpx wide — will look soft on desktop)" % w0
    print("  %-14s %-16s %s%s" % (
        os.path.basename(path), name,
        "|".join(str(w) for w in widths), note))
    return widths, total


def update_index(pairs):
    """Rewrite data-hero-slides AND the first slide's <picture> srcsets.

    The <picture> block is hand-written markup listing hero-poster at four
    fixed widths. If the new source cannot supply all four, those entries
    point at files that no longer exist — the browser picks one, gets a 404,
    and the hero above the fold is blank. So both are rewritten together.
    """
    if not os.path.isfile(INDEX):
        return None
    with open(INDEX, "r", encoding="utf-8") as fh:
        html = fh.read()

    value = ", ".join("%s:%s" % (n, "|".join(str(w) for w in ws)) for n, ws in pairs)
    html, count = re.subn(r'data-hero-slides="[^"]*"',
                          'data-hero-slides="%s"' % value, html, count=1)
    if not count:
        return None

    first_name, first_widths = pairs[0]

    for ext in ("webp", "jpg"):
        srcset = ",\n                        ".join(
            "media/%s-%d.%s %dw" % (first_name, w, ext, w) for w in first_widths)
        html = re.sub(
            r'srcset="\s*media/%s-\d+\.%s \d+w(?:\s*,\s*media/%s-\d+\.%s \d+w)*\s*"'
            % (re.escape(first_name), ext, re.escape(first_name), ext),
            'srcset="%s"' % srcset, html)

    # The plain src fallback must exist too — point it at the middle step.
    fallback = first_widths[len(first_widths) // 2]
    html = re.sub(r'src="media/%s-\d+\.jpg"' % re.escape(first_name),
                  'src="media/%s-%d.jpg"' % (first_name, fallback), html)

    # width/height keep the aspect ratio honest, so the page does not jump.
    src_path = os.path.join(MEDIA_DIR, "%s-%d.jpg" % (first_name, first_widths[-1]))
    if os.path.isfile(src_path):
        w, h = Image.open(src_path).size
        html = re.sub(r'width="\d+" height="\d+"', 'width="%d" height="%d"' % (w, h), html, count=1)

    with open(INDEX, "w", encoding="utf-8") as fh:
        fh.write(html)
    return value


def main():
    os.makedirs(SOURCE_DIR, exist_ok=True)

    missing = [stem for stem, _ in MAPPING if not find_source(stem)]
    if missing:
        print("Nothing to do — these are not in hero-sources/ yet:\n")
        for stem in missing:
            print("    %s.jpg" % stem)
        print("\nSave the five pictures there with those exact names, then run")
        print("this again. Accepted types: jpg, jpeg, png, webp.")
        return 1

    print("Building hero images\n")
    pairs, total = [], 0
    for stem, name in MAPPING:
        widths, size = build(find_source(stem), name)
        pairs.append((name, widths))
        total += size

    value = update_index(pairs)
    print("\n  %d slides, %.1f KB of derivatives on disk" % (len(pairs), total / 1024))
    if value:
        print("  index.html updated:\n    data-hero-slides=\"%s\"" % value)
    else:
        print("  ! could not find data-hero-slides in index.html — set it by hand:")
        print("    %s" % value)
    print("\n  Hard-refresh the site (Ctrl+F5) to see them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
