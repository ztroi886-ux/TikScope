"""Build the responsive job-card photographs from the originals.

Usage:
    python tools/make-job-photos.py "job photos"

Reads every PNG in the source folder, matches it to a vacancy by filename
(see MAP below), and writes into media/jobs/ for each one:

    ARY-1042.jpg        1200w, the canonical file bot/jobs.json points at
    ARY-1042.webp       1200w
    ARY-1042-600.jpg    600w
    ARY-1042-600.webp   600w

then records "photoWidths": [600, 1200] on the vacancy so the site knows the
responsive copies exist. Widths that were never generated must never be listed
-- the browser would simply 404 them, exactly as tools/make-hero.py warns.

Photographs a Telegram admin uploads have no derivatives, so they carry no
photoWidths and the card falls back to a plain <img>. That is the whole
contract: the field is present only when the files behind it are.

The card frames every photograph 16:9 and crops to fill, so the crop happens
here once rather than shipping pixels the browser throws away.
"""
import json
import os
import re
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required:  pip install pillow")

# Photo filename (without .png) -> vacancy id. The two duplicated roles carry
# two photographs each and are handed out in job-id order.
MAP = {
    "Construction Worker":              "ARY-1042",
    "CNC machine Operator":             "ARY-1043",
    "Warehouse Assistant":              "ARY-1051",
    "Welder MIG-MAG":                   "ARY-1052",
    "Order Picker - Distribution":      "ARY-1061",
    "Greenhouse Horticulture Worker":   "ARY-1062",
    "Warehouse Operative":              "ARY-1071",
    "Hotel housekeeping":               "ARY-1072",
    "Agricultural Harvest worker":      "ARY-1081",
    "Kitchen Assistant":                "ARY-1082",
    "Hotel housekeeper":                "ARY-1091",
    "Construction Finisher":            "ARY-1092",
    "Restaurant Waiter":                "ARY-1101",
    "Truck Driver":                     "ARY-1102",
    "Hotel housekeeping - season":      "ARY-1111",
    "Chef de Partie":                   "ARY-1112",
    "Hotel Breakfast service":          "ARY-1121",
    "Carpenter":                        "ARY-1122",
    "Nurse - Elderly Care":             "ARY-1131",
    "Cleaner - Facility Services":      "ARY-1132",
    "Construction Carpenter":           "ARY-1141",
    "Fish Processing Operative":        "ARY-1142",
    "Cleaner - Facility Services2":     "ARY-1151",
    "Welder TIG":                       "ARY-1152",
    "Warehouse Operative2":             "ARY-1161",
    "Care Assistant":                   "ARY-1162",
    "Commercial Electrician":           "ARY-1171",
    "CDL Truck Driver":                 "ARY-1172",
    "Heavy Duty Mechanic":              "ARY-1181",
    "Long-Haul Truck driver":           "ARY-1182",
}

# Photo filename (without .png) -> the job title it illustrates. These roles
# are advertised in five countries at once, so one photograph serves every
# vacancy with that title rather than being tied to a single reference. The
# uploads arrived URL-encoded (%20, %28) and a few lost their % along the way,
# which is why the keys look the way they do -- they are matched literally.
ROLES = {
    "Accountant-Auditor":               "Accountant/Auditor",
    "Chef-Cook":                        "Chef/Cook",
    "Civil Engineer":                   "Civil Engineer",
    "Construction Laborer":             "Construction Laborer",
    "Customer20Representative":         "Customer Service Representative",
    "Cybersecurity%20Analyst":          "Cybersecurity Analyst",
    "Data%20Scientist":                 "Data Scientist",
    "Electrician":                      "Electrician",
    "General-Operations%20Manager":     "General/Operations Manager",
    "Graphic Designer":                 "Graphic Designer",
    "HVAC%20Technician":                "HVAC Technician",
    "Home20Care%20Aide":                "Home Health/Personal Care Aide",
    "Janitor-Cleaner":                  "Janitor/Cleaner",
    "Lawyer":                           "Lawyer",
    "Manufacturing-Machine%20Operator": "Manufacturing/Machine Operator",
    "Mechanical Engineer":              "Mechanical Engineer",
    "Pharmacist":                       "Pharmacist",
    "Physician28Specialist%29":         "Physician (Specialist)",
    "Police%20Officer":                 "Police Officer",
    "Registered%20Nurse":               "Registered Nurse",
    "Sales%20Representative":           "Sales Representative",
    "Secondary20Teacher":               "Secondary School Teacher",
    "Social%20Worker":                  "Social Worker",
    "Software%20Developer":             "Software Developer",
}

# width -> (jpeg quality, webp quality). Unlike the hero these sit unscrimmed
# at the top of a card, so quality is held higher than make-hero.py uses.
SIZES = {600: (80, 76), 1200: (82, 80)}
RATIO = (16, 9)

DEST = os.path.join("media", "jobs")
ROLE_DEST = os.path.join(DEST, "roles")
JOB_FILES = (os.path.join("bot", "jobs.json"),
             os.path.join("bot", "jobs.seed.json"))


def norm(s):
    """Loose title match, for the sanity check only."""
    s = s.lower().replace("/", " ").replace("-", " ")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", s)).strip()


def check_titles(jobs):
    """Refuse to run if a filename and the vacancy it claims disagree."""
    by_id = {j["id"]: j for j in jobs}
    bad = []
    for name, jid in MAP.items():
        job = by_id.get(jid)
        if not job:
            bad.append("%s -> %s: no such vacancy" % (name, jid))
            continue
        a, b = norm(re.sub(r"\d+$", "", name)), norm(job["title"])
        # "Truck Driver" is the Category CE role: the title carries the extra
        # words, the filename does not. Containment either way is enough.
        if a not in b and b not in a:
            bad.append("%s -> %s (%s)" % (name, jid, job["title"]))
    return bad


def slug(title):
    """'Home Health/Personal Care Aide' -> 'home-health-personal-care-aide'."""
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", title.lower())).strip("-")


def render(source, stem, dest):
    """Write all four files for one photograph; returns the bytes written."""
    src = Image.open(source).convert("RGB")

    # Cover-crop to 16:9 about the centre, then step down to each width.
    want = RATIO[0] / RATIO[1]
    have = src.width / src.height
    if have > want:
        w = round(src.height * want)
        box = ((src.width - w) // 2, 0, (src.width - w) // 2 + w, src.height)
    else:
        h = round(src.width / want)
        box = (0, (src.height - h) // 2, src.width, (src.height - h) // 2 + h)
    src = src.crop(box)

    written = 0
    for width, (jq, wq) in sorted(SIZES.items()):
        if width > src.width:
            # Never enlarge: upscaling bakes softness into the file.
            continue
        img = src.resize((width, round(width / want)), Image.LANCZOS)
        # 1200 is the canonical copy bot/jobs.json already points at, so it
        # keeps the bare name; anything smaller is suffixed like the heroes.
        name = stem if width == max(SIZES) else "%s-%d" % (stem, width)
        for ext, kwargs in (("jpg", dict(format="JPEG", quality=jq,
                                         optimize=True, progressive=True)),
                            ("webp", dict(format="WEBP", quality=wq, method=6))):
            path = os.path.join(dest, "%s.%s" % (name, ext))
            img.save(path, **kwargs)
            written += os.path.getsize(path)
    return written


def main(argv):
    source_dir = argv[1] if len(argv) > 1 else "job photos"
    if not os.path.isdir(source_dir):
        sys.exit("No such folder: %s" % source_dir)

    found = {os.path.splitext(f)[0].strip(): f
             for f in os.listdir(source_dir) if f.lower().endswith(".png")}
    known = set(MAP) | set(ROLES)
    missing = sorted(known - set(found))
    extra = sorted(set(found) - known)
    if missing or extra:
        sys.exit("photo/vacancy mismatch:\n  missing: %s\n  unmapped: %s"
                 % (missing, extra))

    books = []
    for path in JOB_FILES:
        with open(path, encoding="utf-8") as fh:
            books.append((path, json.load(fh)))

    problems = check_titles(books[0][1])
    if problems:
        sys.exit("filename/vacancy mismatch:\n  " + "\n  ".join(problems))

    # A role photo that matches no advertised title would never be shown.
    advertised = {j.get("title") for j in books[0][1]}
    orphans = sorted(t for t in ROLES.values() if t not in advertised)
    if orphans:
        sys.exit("role photo for a title no vacancy uses:\n  " + "\n  ".join(orphans))

    os.makedirs(DEST, exist_ok=True)
    os.makedirs(ROLE_DEST, exist_ok=True)
    total = 0

    print("  vacancy photographs")
    for name, jid in sorted(MAP.items(), key=lambda kv: kv[1]):
        total += render(os.path.join(source_dir, found[name]), jid, DEST)
        print("    %-34s -> %s" % (name, jid))

    print("\n  role photographs")
    for name, title in sorted(ROLES.items(), key=lambda kv: kv[1]):
        total += render(os.path.join(source_dir, found[name]), slug(title), ROLE_DEST)
        print("    %-34s -> roles/%s" % (title, slug(title)))

    widths = sorted(SIZES)
    for path, jobs in books:
        for job in jobs:
            if job["id"] in MAP.values():
                job["photo"] = "jobs/%s.jpg" % job["id"]
                job["photoWidths"] = widths
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(jobs, fh, ensure_ascii=False, indent=2)
        print("\n  updated %s" % path)

    n = len(MAP) + len(ROLES)
    print("\n  %d photographs, %d files, %.1f MB on disk"
          % (n, n * len(widths) * 2, total / 1048576))

    print("\n  paste into ROLE_PHOTO in script.js:")
    for title in sorted(ROLES.values()):
        print("    %-36s 'roles/%s'," % ("'%s':" % title, slug(title)))


if __name__ == "__main__":
    main(sys.argv)
