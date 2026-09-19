"""
ARYOS GROUP — Telegram intake bot (local version)
=============================================================================
Runs on your own PC. No account, no hosting, no installing anything — it uses
only what comes with Python.

    py -3 bot.py

It does two things at once:
  * talks to Telegram, so admins create and update client files with buttons
  * serves http://localhost:8787/status?key=... so the website can read a status

BEFORE THE FIRST RUN
  1. Open bot/token.txt in Notepad
  2. Paste your bot token from @BotFather on the first line, and save
  3. Double-click start-bot.bat  (or run the command above)

The bot and website talk over localhost, so run this on the same computer that
serves the website. Clients check their key on the website, which reads the
status from this bot automatically while it is running.
"""

import io
import json
import os
import random
import re
import secrets
import shutil
import ssl
import sys
import threading
import time
import urllib.parse
import urllib.request
from datetime import date
from http.server import BaseHTTPRequestHandler, HTTPServer

from bot.i18n import T, TF, stats as lang_stats
from bot import postgres_store as pg_store

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TOKEN_FILE = os.path.join(HERE, "token.txt")
ENV_FILE = os.path.join(ROOT, ".env")

# --------------------------------------------------------------------------- storage location
#
# Everything the bot writes lives under DATA_DIR. Set DATA_DIR to a mounted
# volume (Railway, Fly, a Render disk) and client files, vacancies,
# applications and their photographs survive a redeploy. Leave it unset and
# the data sits next to the code, which is fine locally but is wiped every
# time a hosted container restarts.
#
# Uploaded images have to be reachable by the browser as well, so when a
# volume is used the app serves /media from there instead of the repo copy.

DATA_DIR = os.environ.get("DATA_DIR", "").strip()
USING_VOLUME = bool(DATA_DIR)
USING_POSTGRES = pg_store.ENABLED

if USING_VOLUME:
    os.makedirs(DATA_DIR, exist_ok=True)
    STORE = DATA_DIR
    MEDIA_ROOT = os.path.join(DATA_DIR, "media")
else:
    STORE = HERE
    MEDIA_ROOT = os.path.join(ROOT, "media")

DB_FILE = os.path.join(STORE, "clients.json")

# Job vacancies are edited from Telegram and read by the website.
JOBS_FILE = os.path.join(STORE, "jobs.json")
SEED_FILE = os.path.join(HERE, "jobs.seed.json")     # ships with the code
MEDIA_DIR = os.path.join(MEDIA_ROOT, "jobs")

# Applications submitted from the website's Apply wizard.
APPS_FILE = os.path.join(STORE, "applications.json")
APPS_MEDIA = os.path.join(MEDIA_ROOT, "applications")

# Reviews written by candidates on the website. Nothing here reaches the public
# page until an admin taps Publish in Telegram — an open review box on a
# recruitment site is otherwise an open door for spam and abuse.
REVIEWS_FILE = os.path.join(STORE, "reviews.json")

for _d in (MEDIA_DIR, APPS_MEDIA):
    try:
        os.makedirs(_d, exist_ok=True)
    except OSError:
        pass


def load_dotenv_file():
    """Load simple KEY=VALUE entries from the project .env file.

    This avoids requiring python-dotenv and works on Windows, Linux, and hosted servers.
    Existing environment variables always win.
    """
    if not os.path.exists(ENV_FILE):
        return
    try:
        with open(ENV_FILE, "r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in ("\"", "'"):
                    value = value[1:-1]
                os.environ.setdefault(key, value)
    except OSError:
        pass


load_dotenv_file()
STATUS_PORT = 8787

# Only these Telegram accounts may use the bot. Add more ids separated by commas.
def read_admin_ids():
    raw = os.environ.get("ADMIN_IDS", "1431899753")
    ids = set()
    for part in raw.split(","):
        part = part.strip()
        if part.isdigit():
            ids.add(int(part))
    return ids

ADMIN_IDS = read_admin_ids()

STATUSES = {
    "review":   ("Under Review", 2),
    "action":   ("Need More Documents", 2),
    "approved": ("Approved", 3),
    "issued":   ("Issued", 4),
}

EDUCATION = ["No formal schooling", "Primary school", "Secondary / high school",
             "Vocational / diploma", "Bachelor's degree", "Master's degree or higher"]

NATIONALITIES = ["Iraq", "Iraq - Kurdistan Region", "Syria", "Iran", "Turkey", "Jordan"]

ROUTES = [
    "Germany - Work Visa (Type D)",
    "Netherlands - GVVA Permit",
    "Belgium - Single Permit",
    "United Kingdom - Skilled Worker",
    "United Kingdom - Health and Care Worker",
    "Poland - Work Permit Type A",
    "Austria - Red-White-Red Card",
    "Sweden - Work Permit",
    "Norway - Skilled Worker Permit",
    "Finland - Residence Permit for Work",
    "Italy - Decreto Flussi",
    "Spain - Work and Residence Permit",
    "Portugal - Work Visa (D1)",
    "Greece - Seasonal Work Visa",
    "USA - H-2B Seasonal",
    "USA - EB-3 Skilled Worker",
    "Canada - LMIA Work Permit",
]

# The interview, in order.
STEPS = [
    {"id": "nameEn",        "kind": "text",   "prompt": T("Full name in <b>English</b>?")},
    {"id": "nameKu",        "kind": "text",   "prompt": T("Full name in <b>Kurdish or Arabic</b>?"), "skip": True},
    {"id": "phone",         "kind": "text",   "prompt": T("Phone number?")},
    {"id": "nationality",   "kind": "choice", "prompt": T("Nationality?"), "options": NATIONALITIES, "other": True},
    {"id": "age",           "kind": "number", "prompt": T("Age?"), "min": 16, "max": 70},
    {"id": "education",     "kind": "choice", "prompt": T("Education?"), "options": EDUCATION},
    {"id": "experience",    "kind": "text",   "prompt": T("Previous work experience?\n<i>Trade, years, employers, countries.</i>")},
    {"id": "arrested",      "kind": "choice", "prompt": T("Has the client been arrested before?"), "options": ["No", "Yes"]},
    {"id": "arrestDetails", "kind": "text",   "prompt": T("Details of the arrest?\n<i>Year, country, charge, is the case closed.</i>"),
                            "only_if": lambda d: d.get("arrested") == "Yes"},
    {"id": "idPhoto",       "kind": "photo",  "prompt": T("Send a photo of the <b>ID or passport</b>.")},
    {"id": "clientPhoto",   "kind": "photo",  "prompt": T("Send a photo of the <b>client</b>.")},
    {"id": "route",         "kind": "choice", "prompt": T("Application route?"), "options": ROUTES, "other": True},
    {"id": "status",        "kind": "status", "prompt": T("Starting status?")},
    {"id": "note",          "kind": "text",   "prompt": T("Message the client will see under the status?"), "skip": True},
]

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"   # no 0/O/1/I - easy to read aloud

# --------------------------------------------------------------------------- job vocabulary

# Country -> region, used to group the country cards on the website homepage.
COUNTRY_REGION = {
    "Germany": "Europe", "Netherlands": "Europe", "Belgium": "Europe",
    "United Kingdom": "Europe", "Poland": "Europe", "Austria": "Europe",
    "Sweden": "Europe", "Norway": "Europe", "Finland": "Europe",
    "Italy": "Europe", "Spain": "Europe", "Portugal": "Europe",
    "Greece": "Europe", "USA": "North America", "Canada": "North America",
}
JOB_COUNTRIES = list(COUNTRY_REGION)

JOB_CATEGORIES = ["Agriculture & Food", "Cleaning & Facilities", "Construction",
                  "Healthcare", "Hospitality", "Logistics", "Technical & Trades"]

JOB_TYPES = ["Full-time", "Part-time", "Seasonal", "Contract"]

# The vacancy interview, in order. Same engine as the client interview.
JOB_STEPS = [
    {"id": "title",     "kind": "text",   "prompt": T("Job <b>title</b>?\n<i>For example: Warehouse Operative</i>")},
    {"id": "country",   "kind": "choice", "prompt": T("Which <b>country</b>?"), "options": JOB_COUNTRIES, "other": True},
    {"id": "city",      "kind": "text",   "prompt": T("Which <b>city</b>?")},
    {"id": "category",  "kind": "choice", "prompt": T("<b>Category</b>?"), "options": JOB_CATEGORIES, "other": True},
    {"id": "type",      "kind": "choice", "prompt": T("Contract <b>type</b>?"), "options": JOB_TYPES},
    {"id": "salary",    "kind": "text",   "prompt": T("<b>Salary</b> as the client should see it?\n<i>For example: €2,300 – €2,700 / month</i>")},
    {"id": "salaryUsd", "kind": "number", "prompt": T("Same salary as a <b>monthly minimum in USD</b>?\n<i>Digits only. Used by the salary filter on the website.</i>"),
                        "min": 0, "max": 100000},
    {"id": "hours",     "kind": "text",   "prompt": T("<b>Working hours</b>?\n<i>For example: 40 hrs / week · Monday to Friday</i>")},
    {"id": "tags",      "kind": "text",   "prompt": T("<b>Benefits</b>, separated by commas?\n<i>For example: Housing arranged, Overtime paid</i>"), "skip": True},
    {"id": "desc",      "kind": "text",   "prompt": T("<b>Description</b> of the role?")},
    {"id": "photo",     "kind": "photo",  "prompt": T("Send a <b>photo for the job card</b>."), "skip": True},
]

# Which fields the edit menu offers, and how each one is re-asked.
JOB_FIELDS = [(s["id"], s["prompt"].split("?")[0].replace("<b>", "").replace("</b>", "")
               .replace("<i>", "").strip()) for s in JOB_STEPS]

_lock = threading.Lock()
_states = {}          # user id -> in-progress interview


# --------------------------------------------------------------------------- token

def read_token():
    """Finds the bot token, or returns "" if there isn't one.

    This deliberately does not exit. The module is imported by app.py, which
    also serves the public website — a missing or mistyped token on a hosted
    deployment must not take the whole site down with it. main() reports the
    problem clearly and the website keeps serving.
    """
    # KARWAN_BOT_TOKEN is still read last so a deployment configured before the
    # rename keeps working; drop it once nothing sets it any more.
    env = (os.environ.get("TELEGRAM_BOT_TOKEN")
           or os.environ.get("ARYOS_BOT_TOKEN")
           or os.environ.get("KARWAN_BOT_TOKEN")
           or "").strip()
    if env:
        return env
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#"):
                    return line
    return ""


TOKEN = read_token()
API = f"https://api.telegram.org/bot{TOKEN}/" if TOKEN else ""


# --------------------------------------------------------------------------- storage

def load_db():
    if USING_POSTGRES:
        return pg_store.load_dict("clients")
    if not os.path.exists(DB_FILE):
        return {}
    try:
        with open(DB_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return {}


def save_db(db):
    if USING_POSTGRES:
        pg_store.save_dict("clients", db)
        return
    tmp = DB_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(db, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, DB_FILE)


def new_key(db):
    """A client's reference key.

    secrets, not random: this key is the only thing a stranger needs to read a
    candidate's name, nationality and immigration status from /status, which
    makes it a credential rather than an identifier. random is a Mersenne
    Twister — predictable once enough of its output has been seen — and it
    costs nothing to use the right generator here.
    """
    while True:
        body = "".join(secrets.choice(ALPHABET) for _ in range(8))
        key = f"ARY-{body[:4]}-{body[4:]}"
        if key not in db:
            return key


def today():
    return date.today().isoformat()


# --------------------------------------------------------------------------- jobs storage

def load_jobs():
    """Vacancies as a list, newest first.

    On the very first run the file does not exist yet, so the bundled sample
    vacancies are copied in. That way a fresh deployment shows a populated
    website immediately and every sample is editable like any other job.
    """
    if USING_POSTGRES:
        rows = pg_store.load_list("jobs")
        if rows:
            return rows
        if os.path.exists(SEED_FILE):
            try:
                with open(SEED_FILE, "r", encoding="utf-8") as fh:
                    seed = json.load(fh)
                save_jobs(seed)
                print(f"  seeded {len(seed)} sample vacancies into PostgreSQL")
                return seed
            except (json.JSONDecodeError, OSError) as err:
                print(f"  ! could not seed PostgreSQL jobs: {err}")
        return []
    if not os.path.exists(JOBS_FILE) and os.path.exists(SEED_FILE):
        try:
            with open(SEED_FILE, "r", encoding="utf-8") as fh:
                seed = json.load(fh)
            save_jobs(seed)
            print(f"  seeded {len(seed)} sample vacancies into {JOBS_FILE}")
        except (json.JSONDecodeError, OSError) as err:
            print(f"  ! could not seed jobs: {err}")

    if not os.path.exists(JOBS_FILE):
        return []
    try:
        with open(JOBS_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def save_jobs(jobs):
    if USING_POSTGRES:
        pg_store.save_list("jobs", jobs)
        return
    tmp = JOBS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(jobs, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, JOBS_FILE)


def find_job(jobs, job_id):
    for j in jobs:
        if j.get("id") == job_id:
            return j
    return None


def new_job_id(jobs):
    """Sequential ARY-1xxx ids, continuing after the highest one in use."""
    highest = 1000
    for j in jobs:
        m = re.fullmatch(r"ARY-(\d{4})", j.get("id", ""))
        if m:
            highest = max(highest, int(m.group(1)))
    return f"ARY-{highest + 1}"


def posted_label(iso):
    """'today' / '3 days ago' / '2 weeks ago' for the website card."""
    try:
        y, m, d = (int(x) for x in iso.split("-"))
        days = (date.today() - date(y, m, d)).days
    except (ValueError, AttributeError):
        return ""
    if days <= 0:
        return "today"
    if days == 1:
        return "yesterday"
    if days < 14:
        return TF("{n} days ago", n=days)
    weeks = days // 7
    return T("1 week ago") if weeks == 1 else TF("{n} weeks ago", n=weeks)


def download_photo(file_id, job_id):
    """Pulls a Telegram photo onto disk and returns its path relative to media/.

    Telegram only hands out a file_id; the actual bytes live behind a
    short-lived URL from getFile. We fetch once and store the file next to the
    website so the browser loads it directly with no round trip to Telegram.
    The file_id is kept in the record too, so a wiped disk can be re-synced.
    """
    info = api("getFile", {"file_id": file_id}, timeout=30)
    if not info or not info.get("ok"):
        return ""

    remote = info["result"].get("file_path") or ""
    ext = os.path.splitext(remote)[1].lower() or ".jpg"
    if ext not in (".jpg", ".jpeg", ".png", ".webp"):
        ext = ".jpg"

    os.makedirs(MEDIA_DIR, exist_ok=True)
    name = f"{job_id}{ext}"
    dest = os.path.join(MEDIA_DIR, name)
    url = f"https://api.telegram.org/file/bot{TOKEN}/{remote}"

    try:
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(url, timeout=60, context=ctx) as res, \
                open(dest + ".tmp", "wb") as out:
            shutil.copyfileobj(res, out)
        os.replace(dest + ".tmp", dest)
    except Exception as err:
        print(f"  ! photo download failed for {job_id}: {err}")
        return ""

    # Drop any older image for this job that used a different extension.
    for other in (".jpg", ".jpeg", ".png", ".webp"):
        if other != ext:
            stale = os.path.join(MEDIA_DIR, f"{job_id}{other}")
            if os.path.exists(stale):
                try:
                    os.remove(stale)
                except OSError:
                    pass

    return f"jobs/{name}"


def set_job_photo(job, path):
    """Points a vacancy at a photograph that just arrived from Telegram.

    Only tools/make-job-photos.py writes the responsive copies, and it records
    photoWidths to say so. A picture uploaded here has none, so that field has
    to leave with the file it described -- otherwise the website would offer
    the browser -600 and .webp derivatives of a photograph that is gone, and
    every card holding one would break rather than fall back.
    """
    job["photo"] = path
    job.pop("photoWidths", None)


# --------------------------------------------------------------------------- applications

APP_FIELDS = [
    ("fullName",       "Full name"),
    ("phone",          "Phone"),
    # The website collects a date of birth and derives the age from it, then
    # sends both: the date is what consulate forms ask for and it never goes
    # stale, the age is what the case officer reads at a glance.
    ("dob",            "Date of birth"),
    ("age",            "Age"),
    ("gender",         "Gender"),
    ("nationality",    "Nationality"),
    ("maritalStatus",  "Marital status"),
    ("familyMembers",  "Family members"),
    ("education",      "Education"),
    ("currentJob",     "Current job"),
    ("experience",     "Work experience"),
    ("skills",         "Skills"),
    ("languages",      "Languages"),
    ("criminalRecord", "Arrested / convicted"),
    ("criminalDetails", "Case details"),
]

APP_PHOTOS = [("selfie", T("Selfie")), ("idFront", T("National ID — front")),
              ("idBack", T("National ID — back"))]

# Simple in-memory throttle: at most 5 applications per IP per hour. Enough to
# stop a script hammering the endpoint without blocking a shared office wifi.
#
# Buckets are kept apart on purpose. Writing an application and reading a visa
# status are different actions with different budgets, and sharing one counter
# would mean a candidate who checked their status a few times could no longer
# apply.
_hits = {}
_app_lock = threading.Lock()

# Looser than the write limit: a candidate refreshing their status while they
# wait is normal behaviour, and only a script runs it hundreds of times.
STATUS_LOOKUP_LIMIT = 60
STATUS_LOOKUP_WINDOW = 600


def rate_limited(ip, limit=5, window=3600, bucket="apply"):
    now = time.time()
    key = (bucket, ip)
    with _app_lock:
        hits = [t for t in _hits.get(key, []) if now - t < window]
        if len(hits) >= limit:
            _hits[key] = hits
            return True
        hits.append(now)
        _hits[key] = hits
    return False


def load_apps():
    if USING_POSTGRES:
        return pg_store.load_list("applications")
    if not os.path.exists(APPS_FILE):
        return []
    try:
        with open(APPS_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def save_apps(apps):
    if USING_POSTGRES:
        pg_store.save_list("applications", apps)
        return
    tmp = APPS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(apps, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, APPS_FILE)


# --------------------------------------------------------------------------- hero images
#
# The pictures behind the homepage headline. They used to be files in the repo
# listed in index.html, which meant a code change to swap one. Now they are
# uploaded in Telegram and the site reads the list from /hero.
#
# Production runs the standard library only, so there is no Pillow to resize
# with. Telegram already caps a photo at about 1280px when it is sent as a
# photo rather than a file, which is a reasonable hero width — so one file per
# slide is what normally ships. Where Pillow *is* available the responsive set
# is generated as a bonus and the site uses it.

HERO_FILE = os.path.join(STORE, "hero.json")
HERO_MEDIA = os.path.join(MEDIA_ROOT, "hero")
HERO_WIDTHS = (480, 750, 1080)

try:
    os.makedirs(HERO_MEDIA, exist_ok=True)
except OSError:
    pass


def load_hero():
    if USING_POSTGRES:
        return pg_store.load_list("hero")
    if not os.path.exists(HERO_FILE):
        return []
    try:
        with open(HERO_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def save_hero(rows):
    if USING_POSTGRES:
        pg_store.save_list("hero", rows)
        return
    tmp = HERO_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(rows, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, HERO_FILE)


def new_hero_id(rows):
    highest = 0
    for r in rows:
        m = re.fullmatch(r"HERO-(\d+)", r.get("id", ""))
        if m:
            highest = max(highest, int(m.group(1)))
    return "HERO-%04d" % (highest + 1)


def hero_variants(path, stem):
    """Responsive copies beside the original, when Pillow is installed.

    Returns the widths written. An empty list is not a failure — it just means
    the site will use the single full-size file, which is what happens on the
    host.
    """
    try:
        from PIL import Image
    except ImportError:
        return []

    try:
        src = Image.open(path).convert("RGB")
    except Exception as err:
        print(f"  ! hero resize skipped for {stem}: {err}")
        return []

    w0, h0 = src.size
    made = []
    for width in HERO_WIDTHS:
        if width > w0:
            continue
        try:
            im = src.resize((width, round(h0 * width / w0)), Image.LANCZOS)
            im.save(os.path.join(HERO_MEDIA, f"{stem}-{width}.jpg"),
                    "JPEG", quality=62, optimize=True, progressive=True)
            made.append(width)
        except Exception as err:
            print(f"  ! hero resize {width}px failed: {err}")
    return made


def download_hero(file_id, hero_id):
    """Pulls a Telegram photo into media/hero/ and returns (relpath, widths)."""
    info = api("getFile", {"file_id": file_id}, timeout=30)
    if not info or not info.get("ok"):
        return "", []

    remote = info["result"].get("file_path") or ""
    ext = os.path.splitext(remote)[1].lower()
    if ext not in (".jpg", ".jpeg", ".png", ".webp"):
        ext = ".jpg"

    os.makedirs(HERO_MEDIA, exist_ok=True)
    name = f"{hero_id}{ext}"
    dest = os.path.join(HERO_MEDIA, name)
    url = f"https://api.telegram.org/file/bot{TOKEN}/{remote}"

    try:
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(url, timeout=60, context=ctx) as res, \
                open(dest + ".tmp", "wb") as out:
            shutil.copyfileobj(res, out)
        os.replace(dest + ".tmp", dest)
    except Exception as err:
        print(f"  ! hero download failed for {hero_id}: {err}")
        return "", []

    # Clear anything left from a previous upload under this id.
    for other in (".jpg", ".jpeg", ".png", ".webp"):
        if other != ext:
            stale = os.path.join(HERO_MEDIA, f"{hero_id}{other}")
            if os.path.exists(stale):
                try:
                    os.remove(stale)
                except OSError:
                    pass
    for width in HERO_WIDTHS:
        stale = os.path.join(HERO_MEDIA, f"{hero_id}-{width}.jpg")
        if os.path.exists(stale):
            try:
                os.remove(stale)
            except OSError:
                pass

    return f"hero/{name}", hero_variants(dest, hero_id)


def hero_payload():
    """What the website needs to build its slideshow, in display order.

    `srcset` is only sent when the responsive copies actually exist, so the
    browser is never pointed at a file that was never written.
    """
    out = []
    for r in sorted(load_hero(), key=lambda x: x.get("order", 0)):
        if not r.get("published", True) or not r.get("file"):
            continue
        slide = {"id": r.get("id"), "src": "media/" + r["file"]}
        widths = r.get("widths") or []
        if widths:
            slide["srcset"] = ", ".join(
                f"media/hero/{r['id']}-{w}.jpg {w}w" for w in widths)
        out.append(slide)
    return out


def hero_reorder(hero_id, delta):
    """Moves one slide up or down and renumbers the whole list."""
    with _lock:
        rows = sorted(load_hero(), key=lambda x: x.get("order", 0))
        idx = next((i for i, r in enumerate(rows) if r.get("id") == hero_id), None)
        if idx is None:
            return False
        target = idx + delta
        if not 0 <= target < len(rows):
            return False
        rows[idx], rows[target] = rows[target], rows[idx]
        for i, r in enumerate(rows):
            r["order"] = i
        save_hero(rows)
        return True


def delete_hero(hero_id):
    with _lock:
        rows = load_hero()
        keep = [r for r in rows if r.get("id") != hero_id]
        if len(keep) == len(rows):
            return False
        for i, r in enumerate(sorted(keep, key=lambda x: x.get("order", 0))):
            r["order"] = i
        save_hero(keep)

    for ext in (".jpg", ".jpeg", ".png", ".webp"):
        path = os.path.join(HERO_MEDIA, f"{hero_id}{ext}")
        if os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass
    for width in HERO_WIDTHS:
        path = os.path.join(HERO_MEDIA, f"{hero_id}-{width}.jpg")
        if os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass
    return True


def load_reviews():
    if USING_POSTGRES:
        return pg_store.load_list("reviews")
    if not os.path.exists(REVIEWS_FILE):
        return []
    try:
        with open(REVIEWS_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def save_reviews(rows):
    if USING_POSTGRES:
        pg_store.save_list("reviews", rows)
        return
    tmp = REVIEWS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(rows, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, REVIEWS_FILE)


def new_review_id(rows):
    highest = 0
    for r in rows:
        m = re.fullmatch(r"REV-(\d+)", r.get("id", ""))
        if m:
            highest = max(highest, int(m.group(1)))
    return "REV-%04d" % (highest + 1)


def reviews_payload():
    """Approved reviews, newest first, in the shape the cards expect.

    Only the initial of the surname goes out, never the phone number the
    reviewer was matched on.
    """
    out = []
    for r in load_reviews():
        if not r.get("published"):
            continue
        out.append({
            "name": r.get("name", ""),
            "place": r.get("place", ""),
            "role": r.get("role", ""),
            "country": r.get("country", ""),
            "rating": r.get("rating", 5),
            "lang": r.get("lang", "en"),
            "date": str(r.get("received", ""))[:7],
            "text": r.get("text", ""),
        })
    out.reverse()
    return out


def store_review(payload, ip=""):
    """Validates and files a review. Returns the stored record, unpublished."""
    text = str(payload.get("text") or "").strip()
    name = str(payload.get("name") or "").strip()

    if len(text) < 10:
        raise ValueError("review too short")
    if len(name) < 2:
        raise ValueError("missing name")

    try:
        rating = int(payload.get("rating") or 0)
    except (TypeError, ValueError):
        rating = 0
    if not 1 <= rating <= 5:
        raise ValueError("rating out of range")

    lang = str(payload.get("lang") or "en").strip()[:12]
    if not re.fullmatch(r"[A-Za-z-]{2,12}", lang):
        lang = "en"

    record = {
        "id": "",
        "name": name[:60],
        "place": str(payload.get("place") or "")[:60],
        "role": str(payload.get("role") or "")[:80],
        "country": str(payload.get("country") or "")[:60],
        "rating": rating,
        "lang": lang,
        "text": text[:1200],
        "appId": str(payload.get("appId") or "")[:40],
        "received": today(),
        "ip": ip,
        "published": False,
    }

    with _lock:
        rows = load_reviews()
        record["id"] = new_review_id(rows)
        rows.append(record)
        save_reviews(rows)

    return record


def new_app_id(apps):
    """An application's reference.

    Unguessable rather than sequential. The id names the files under
    media/applications/ — "{id}-idFront.jpg" and so on — and while app.py no
    longer serves that directory, APP-0001, APP-0002, ... meant a single
    mistake anywhere in front of it exposed every candidate's identity
    documents at once. Random ids make each file its own secret, so nothing
    else has to be perfect.

    Old sequential ids still load and display; only new ones take this shape.
    """
    taken = {a.get("id") for a in apps}
    while True:
        body = "".join(secrets.choice(ALPHABET) for _ in range(8))
        app_id = f"APP-{body[:4]}-{body[4:]}"
        if app_id not in taken:
            return app_id


def save_data_url(data_url, app_id, slot):
    """Writes a base64 data URL from the browser to media/applications/.

    Returns the path relative to media/, or "" if the payload is not a plain
    image data URL. Anything that is not image/jpeg|png|webp is rejected
    outright rather than trusted.
    """
    import base64

    m = re.match(r"^data:image/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$",
                 data_url or "", re.I)
    if not m:
        return ""

    ext = {"jpeg": ".jpg", "jpg": ".jpg", "png": ".png", "webp": ".webp"}[m.group(1).lower()]
    try:
        raw = base64.b64decode(m.group(2), validate=False)
    except Exception:
        return ""

    if len(raw) > 8 * 1024 * 1024:          # 8 MB ceiling per image
        return ""

    os.makedirs(APPS_MEDIA, exist_ok=True)
    name = f"{app_id}-{slot}{ext}"
    with open(os.path.join(APPS_MEDIA, name), "wb") as fh:
        fh.write(raw)
    return f"applications/{name}"


def application_text(a):
    ans = a.get("answers", {})
    out = [T("\U0001F4E5 <b>NEW APPLICATION</b>"), rule()]

    if a.get("jobTitle"):
        out.append(f"\U0001F4BC <b>{esc(a['jobTitle'])}</b>")
        out.append(f"📍 {esc(a.get('jobCity'))}, {esc(a.get('jobCountry'))}"
                   f"   ·   <code>{esc(a.get('jobId'))}</code>")
    else:
        out.append(T("\U0001F4BC <i>Open application (no specific job)</i>"))
    out.append(rule())

    for key, label in APP_FIELDS:
        v = ans.get(key)
        if v in (None, "", []):
            continue
        if isinstance(v, list):
            v = ", ".join(str(x) for x in v)
        if key == "criminalRecord":
            v = T("⚠️ Yes") if str(v).lower() == "yes" else choice_label("No")
        # APP_FIELDS pairs a stored key with its caption. The key is data, the
        # caption is copy, so only the caption is translated — and only here.
        label = T(label)
        if key in ("experience", "skills", "criminalDetails"):
            out.append(f"\n<b>{label}</b>\n{esc(v)}")
        else:
            out.append(f"<b>{label}:</b> {esc(v)}")

    out += [rule()]
    if a.get("consent"):
        stamp = esc(a.get("consentAt", "")[:19].replace("T", " "))
        out.append("✅ " + TF("Accepted the terms of use — {when} UTC", when=stamp))
    else:
        out.append(T("⚠️ <b>No record of the terms being accepted</b>"))
    out.append(TF("Reference <code>{id}</code> · received {when}",
                  id=a["id"], when=a.get("received", "")))
    return "\n".join(out)


def notify_admins(app):
    """Sends the application and its photos to every admin."""
    text = application_text(app)
    keyboard = [[{"text": T("\U0001F5C2  Create client file"), "callback_data": f"aconv:{app['id']}"}],
                [{"text": T("\U0001F4E5  All applications"), "callback_data": "alist:0"}]]

    for admin in ADMIN_IDS:
        try:
            send(admin, text, keyboard)
            for slot, label in APP_PHOTOS:
                rel = app.get("photos", {}).get(slot)
                if not rel:
                    continue
                path = os.path.join(MEDIA_ROOT, rel)
                if os.path.exists(path):
                    send_photo_file(admin, path, f"{label} — {app['id']}")
        except Exception as err:
            print(f"  ! could not notify admin {admin}: {err}")


def review_text(r):
    stars = "★" * int(r.get("rating") or 0) + "☆" * (5 - int(r.get("rating") or 0))
    lines = [
        TF("<b>New review — {id}</b>", id=esc(r["id"])),
        f"{stars}  ({r.get('rating')}/5)",
        "",
        f"<b>{esc(r.get('name'))}</b>",
    ]
    meta = " · ".join(x for x in (r.get("role"), r.get("place")) if x)
    if meta:
        lines.append(esc(meta) + (f" → {esc(r.get('country'))}" if r.get("country") else ""))
    if r.get("appId"):
        lines.append(TF("From application {id}", id=esc(r["appId"])))
    lines += ["", f"<i>{esc(r.get('text'))}</i>", "",
              T("Nothing appears on the website until you publish it.")]
    return "\n".join(lines)


def notify_admins_review(r):
    """A review is held back until an admin approves it, so every admin gets
    the text with the two buttons that decide its fate."""
    keyboard = [[{"text": T("✅  Publish"), "callback_data": f"rpub:{r['id']}"},
                 {"text": T("✖  Reject"), "callback_data": f"rrej:{r['id']}"}],
                [{"text": T("⭐  All reviews"), "callback_data": "rlist:0"}]]
    for admin in ADMIN_IDS:
        try:
            send(admin, review_text(r), keyboard)
        except Exception as err:
            print(f"  ! could not notify admin {admin} of review: {err}")


def send_photo_file(chat_id, path, caption):
    """Uploads a local file to Telegram as multipart/form-data."""
    boundary = "----aryos" + "".join(random.choice(ALPHABET) for _ in range(16))
    name = os.path.basename(path)
    with open(path, "rb") as fh:
        blob = fh.read()

    parts = []
    for key, value in (("chat_id", str(chat_id)), ("caption", caption)):
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n"
            .encode("utf-8"))
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"{name}\"\r\n"
        f"Content-Type: image/jpeg\r\n\r\n".encode("utf-8"))
    parts.append(blob)
    parts.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))
    body = b"".join(parts)

    req = urllib.request.Request(
        API + "sendPhoto", data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                 "Content-Length": str(len(body))})
    try:
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=90, context=ctx) as res:
            return json.loads(res.read().decode("utf-8"))
    except Exception as err:
        print(f"  ! photo upload failed ({name}): {err}")
        return None


def store_application(payload, ip=""):
    """Validates and files an application. Returns the stored record."""
    ans = payload.get("answers") or {}
    if not isinstance(ans, dict):
        raise ValueError("bad answers")

    name = str(ans.get("fullName") or "").strip()
    phone = str(ans.get("phone") or "").strip()
    if len(name) < 3 or len(re.sub(r"\D", "", phone)) < 7:
        raise ValueError("missing name or phone")

    with _lock:
        apps = load_apps()
        app_id = new_app_id(apps)

    clean = {}
    for key, _ in APP_FIELDS:
        v = ans.get(key)
        if isinstance(v, list):
            clean[key] = [str(x)[:80] for x in v][:20]
        elif v is not None:
            clean[key] = str(v)[:2000]

    photos = {}
    for slot, _ in APP_PHOTOS:
        rel = save_data_url(ans.get(slot), app_id, slot)
        if rel:
            photos[slot] = rel

    record = {
        "id": app_id,
        "consent": payload.get("consent") is True,
        "consentAt": str(payload.get("consentAt") or "")[:40],
        "jobId": str(payload.get("jobId") or "")[:40],
        "jobTitle": str(payload.get("jobTitle") or "")[:120],
        "jobCountry": str(payload.get("jobCountry") or "")[:60],
        "jobCity": str(payload.get("jobCity") or "")[:60],
        "answers": clean,
        "photos": photos,
        "received": today(),
        "ip": ip,
        "converted": False,
    }

    with _lock:
        apps = load_apps()
        apps.insert(0, record)
        save_apps(apps)

    return record


def resync_photos():
    """Re-downloads any job image missing from disk. Returns (fixed, failed)."""
    jobs = load_jobs()
    fixed = failed = 0
    for j in jobs:
        fid = j.get("photoFileId")
        if not fid:
            continue
        rel = j.get("photo") or ""
        on_disk = rel and os.path.exists(os.path.join(MEDIA_ROOT, rel))
        if on_disk:
            continue
        path = download_photo(fid, j["id"])
        if path:
            set_job_photo(j, path)
            fixed += 1
        else:
            failed += 1
    if fixed:
        with _lock:
            save_jobs(jobs)
    return fixed, failed


# --------------------------------------------------------------------------- telegram

def api(method, payload, timeout=70):
    """Returns Telegram's reply as a dict, or None if the network failed.

    The difference matters: a dict with ok=false means Telegram answered and
    rejected us (bad token), while None means we never reached Telegram at all
    (no internet, or the connection is being filtered).
    """
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(API + method, data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as err:          # Telegram answered with an error
        try:
            return json.loads(err.read().decode("utf-8"))
        except Exception:
            return {"ok": False, "description": f"HTTP {err.code}"}
    except Exception as err:                       # never got there
        print(f"  ! {method} failed: {err}")
        return None


# --------------------------------------------------------------------------- the always-there keyboard
#
# Inline buttons live on one message, so they scroll away as soon as the chat
# moves on. These sit under the text box permanently, which means every part
# of the bot is one tap away without remembering a single command.

NAV_MENU      = T("🗂 Menu")
NAV_VACANCIES = T("💼 Vacancies")
NAV_APPS      = T("📥 Applications")
NAV_REVIEWS   = T("⭐ Reviews")
NAV_CLIENTS   = T("📋 Clients")
NAV_HELP      = T("❓ Help")

NAV_LABELS = {NAV_MENU, NAV_VACANCIES, NAV_APPS, NAV_REVIEWS, NAV_CLIENTS, NAV_HELP}

HOME_KEYBOARD = {
    "keyboard": [[{"text": NAV_MENU}, {"text": NAV_VACANCIES}],
                 [{"text": NAV_APPS}, {"text": NAV_REVIEWS}],
                 [{"text": NAV_CLIENTS}, {"text": NAV_HELP}]],
    "resize_keyboard": True,
    "is_persistent": True,
    "input_field_placeholder": T("Tap a button, or type /help"),
}

# Telegram's own ⌘ menu beside the text box. Without this the admin has to
# remember what exists; with it, every command is listed and described.
BOT_COMMANDS = [
    ("start",        T("Open the control panel")),
    ("jobs",         T("Browse and edit vacancies")),
    ("job",          T("Add a new vacancy")),
    ("drafts",       T("Vacancies not published yet")),
    ("applications", T("People who applied on the website")),
    ("reviews",      T("Publish or hide candidate reviews")),
    ("new",          T("Start a new client file")),
    ("list",         T("Browse client files")),
    ("find",         T("Open a client file by its key")),
    ("hero",         T("Change the homepage pictures")),
    ("resync",       T("Re-download missing job photos")),
    ("cancel",       T("Stop what you are filling in")),
    ("help",         T("What every command does")),
]


def publish_commands():
    """Registers the command list with Telegram so it appears in the ⌘ menu.

    Registered twice. The default list carries whatever BOT_LANG is set to, and
    a second list is filed under language_code="ckb" — Telegram then shows each
    admin the descriptions in the language their own Telegram app is set to,
    rather than the language the server happens to be configured with. An admin
    reading Telegram in Kurdish gets Kurdish; one reading it in English gets
    English, from the same deployment.
    """
    def payload(translate):
        return [{"command": c, "description": translate(d)} for c, d in BOT_COMMANDS]

    # BOT_COMMANDS descriptions are already passed through T() at import time,
    # so they hold the configured language; ask the table directly for the rest.
    api("setMyCommands", {"commands": payload(lambda d: d)}, timeout=15)

    try:
        table = json.load(io.open(os.path.join(HERE, "lang", "ckb.json"), encoding="utf-8"))
    except (OSError, ValueError):
        table = {}
    if table:
        api("setMyCommands", {"commands": payload(lambda d: table.get(d) or d),
                              "language_code": "ckb"}, timeout=15)

    api("setChatMenuButton", {"menu_button": {"type": "commands"}}, timeout=15)


def send(chat_id, text, keyboard=None, home=False):
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML",
               "disable_web_page_preview": True}
    if keyboard:
        payload["reply_markup"] = {"inline_keyboard": keyboard}
    elif home:
        payload["reply_markup"] = HOME_KEYBOARD
    return api("sendMessage", payload)


def edit(chat_id, message_id, text, keyboard=None):
    """Replaces an existing message instead of sending another one.

    Used for anything the admin navigates through repeatedly (the menu, the
    client list) so a long session does not turn into a wall of duplicates.
    Falls back to a normal send if Telegram refuses the edit.
    """
    payload = {"chat_id": chat_id, "message_id": message_id, "text": text,
               "parse_mode": "HTML", "disable_web_page_preview": True}
    payload["reply_markup"] = {"inline_keyboard": keyboard or []}
    res = api("editMessageText", payload)
    if res is None:
        return send(chat_id, text, keyboard)
    if not res.get("ok"):
        # Tapping Refresh when nothing has changed is not an error — Telegram
        # simply refuses the no-op edit. Re-sending would duplicate the screen.
        if "not modified" in (res.get("description") or "").lower():
            return res
        return send(chat_id, text, keyboard)
    return res


def typing(chat_id, action="typing"):
    """Shows "Aryos Group is typing…" so a slow step never looks frozen."""
    api("sendChatAction", {"chat_id": chat_id, "action": action}, timeout=10)


def esc(value):
    return (str(value if value is not None else "")
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def clip(text, limit):
    """Shorten a value for a button caption, breaking on a space.

    A plain slice cut titles mid-word and left no ellipsis, so 'Order Picker —
    Distribution' arrived as 'Order Picker — Distributio' and read like a
    typo rather than a shortened title. Falls back to a hard cut for a single
    word longer than the limit.
    """
    text = str(text)
    if len(text) <= limit:
        return text
    head = text[:limit].rstrip()
    space = head.rfind(" ")
    if space >= limit // 2:
        head = head[:space]
    return head.rstrip(" -—·") + "…"


# --------------------------------------------------------------------------- display

STATUS_ICON = {"review": "\U0001F7E1", "action": "\U0001F534",
               "approved": "\U0001F7E2", "issued": "\U0001F535"}

BAR_FULL = "▰"
BAR_EMPTY = "▱"


def progress_bar(done, total, width=10):
    """A text progress bar, e.g. ▰▰▰▰▱▱▱▱▱▱  4/14."""
    total = max(total, 1)
    filled = int(round(width * min(done, total) / total))
    return f"{BAR_FULL * filled}{BAR_EMPTY * (width - filled)}  {min(done, total)}/{total}"


def status_label(code, fallback="?"):
    """The status as an admin reads it — translated.

    Only here. STATUSES itself stays English because the code writes those
    labels into client records and hands them to the website through /status,
    where the site does its own translating. Translating the table instead of
    the display would put Kurdish inside the data.
    """
    name = STATUSES.get(code, (None, 0))[0] or fallback
    icon = STATUS_ICON.get(code, "⚪")
    return f"{icon} {T(name)}"


def choice_label(value):
    """The reading for a stored option value — nationality, education, route,
    job category, Yes/No.

    Same rule as status_label(): the option lists are data. A route is written
    into the client's record and read back by /status; a category is what the
    website's job filter matches on. So the value travelling through the code
    stays English and only the button caption is translated. A value with no
    entry in the table simply shows as it is stored.
    """
    return T(value) if isinstance(value, str) else value


def rule():
    return "─────────────────"


def chunk(buttons, per_row=2):
    """Lays inline buttons out in rows so tall option lists stay readable."""
    return [buttons[i:i + per_row] for i in range(0, len(buttons), per_row)]


# --------------------------------------------------------------------------- screens

def menu_keyboard():
    """Built per call so the two inboxes can carry their waiting count — an
    admin should see there is something to deal with without opening it."""
    waiting_apps = sum(1 for a in load_apps() if not a.get("converted"))
    waiting_revs = sum(1 for r in load_reviews() if not r.get("published"))

    apps_label = T("\U0001F4E5  Applications")
    if waiting_apps:
        apps_label += f"  ({waiting_apps})"
    revs_label = T("⭐  Reviews")
    if waiting_revs:
        revs_label += f"  ({waiting_revs})"

    return [[{"text": T("➕  New client file"), "callback_data": "new"},
             {"text": T("\U0001F4CB  Client list"), "callback_data": "list:0"}],
            [{"text": T("➕  New vacancy"), "callback_data": "jnew"},
             {"text": T("\U0001F4BC  Vacancies"), "callback_data": "jlist:0"}],
            [{"text": apps_label, "callback_data": "alist:0"},
             {"text": revs_label, "callback_data": "rlist:0"}],
            [{"text": T("⚙️  Tools"), "callback_data": "tools"},
             {"text": T("\U0001F504  Refresh"), "callback_data": "menu"}]]


def help_text():
    """Built from the command table so the list can never drift from what the
    bot actually accepts, and so every description is translated once rather
    than being retyped inside one long English paragraph."""
    groups = [
        (T("<b>Clients</b>"), ["new", "list", "find"]),
        (T("<b>Vacancies</b>"), ["job", "jobs", "drafts", "resync"]),
        (T("<b>Website</b>"), ["hero"]),
        (T("<b>Applications</b>"), ["applications"]),
        (T("<b>Reviews</b>"), ["reviews"]),
        (T("<b>Anywhere</b>"), ["start", "cancel"]),
    ]
    described = dict(BOT_COMMANDS)

    lines = [T("❓ <b>Commands</b>"), rule()]
    for title, names in groups:
        lines.append("")
        lines.append(title)
        for name in names:
            if name in described:
                lines.append("/%s — %s" % (name, described[name]))
    lines.append("")
    lines.append(T("<i>You never have to type any of these — the buttons under "
                   "the text box and the ⌘ menu reach everything.</i>"))
    return "\n".join(lines)


# The persistent keyboard sends plain text, so each label maps to a screen.
def route_nav(chat_id, user_id, label):
    if label == NAV_MENU:
        main_menu(chat_id)
    elif label == NAV_VACANCIES:
        list_jobs_screen(chat_id, user_id=user_id)
    elif label == NAV_APPS:
        list_apps_screen(chat_id)
    elif label == NAV_REVIEWS:
        list_reviews_screen(chat_id)
    elif label == NAV_CLIENTS:
        list_clients(chat_id)
    elif label == NAV_HELP:
        send(chat_id, help_text(), BACK)


def list_hero_screen(chat_id, page=0, message_id=None):
    rows_all = sorted(load_hero(), key=lambda x: x.get("order", 0))

    if not rows_all:
        body = (T("🖼 <b>Hero images</b>\n") + rule() +
                T("\nNone uploaded yet — the website is using the pictures that "
                  "shipped with it.\n\n<i>Add one and it replaces them straight "
                  "away. Send several and they fade from one to the next.</i>"))
        rows = [[{"text": T("➕  Add hero image"), "callback_data": "hadd"}],
                [{"text": T("⚙️  Tools"), "callback_data": "tools"},
                 {"text": T("⬅  Menu"), "callback_data": "menu"}]]
        if message_id:
            edit(chat_id, message_id, body, rows)
        else:
            send(chat_id, body, rows)
        return

    rows = []
    for i, r in enumerate(rows_all):
        mark = "🟢" if r.get("published", True) else "⚪"
        first = T("  · first") if i == 0 else ""
        rows.append([{"text": f"{mark} {i + 1}. {r.get('id')}{first}",
                      "callback_data": f"hopen:{r['id']}"}])

    rows.append([{"text": T("➕  Add hero image"), "callback_data": "hadd"}])
    rows.append([{"text": T("⚙️  Tools"), "callback_data": "tools"},
                 {"text": T("⬅  Menu"), "callback_data": "menu"}])

    live = sum(1 for r in rows_all if r.get("published", True))
    parts = [T("🖼 <b>Hero images</b>"), rule(),
             f"🟢 {live} " + T("showing on the website") +
             (f" · ⚪ {len(rows_all) - live} " + T("hidden")
              if len(rows_all) - live else ""),
             T("<i>The first one is what a visitor sees before the slideshow "
               "starts. Tap any to replace, reorder or remove it.</i>")]
    body = "\n".join(parts)
    if message_id:
        edit(chat_id, message_id, body, rows)
    else:
        send(chat_id, body, rows)


def show_hero(chat_id, hero_id, message_id=None):
    rows_all = sorted(load_hero(), key=lambda x: x.get("order", 0))
    r = next((x for x in rows_all if x.get("id") == hero_id), None)
    if not r:
        send(chat_id, T("⚠️ That hero image no longer exists."),
             [[{"text": T("🖼  Hero images"), "callback_data": "hlist"}]])
        return

    pos = rows_all.index(r)
    state = T("🟢 Showing on the website") if r.get("published", True) \
        else T("⚪ Hidden — not on the website")
    widths = r.get("widths") or []
    sizes = (", ".join(f"{w}px" for w in widths) if widths
             else T("one size (no resizing available on this server)"))

    parts = [f"🖼 <b>{esc(hero_id)}</b>", rule(), state,
             T("Position:") + f" <b>{pos + 1}</b> " + T("of") + f" {len(rows_all)}" +
             (T("  — this is the first one visitors see") if pos == 0 else ""),
             T("Sizes:") + " " + sizes,
             f"<i>{T('Uploaded')} {r.get('added', '?')}</i>"]

    buttons = [[{"text": T("🔄  Replace photo"), "callback_data": f"hrep:{hero_id}"}]]
    move = []
    if pos > 0:
        move.append({"text": T("⬆  Move up"), "callback_data": f"hup:{hero_id}"})
    if pos < len(rows_all) - 1:
        move.append({"text": T("⬇  Move down"), "callback_data": f"hdown:{hero_id}"})
    if move:
        buttons.append(move)
    buttons.append([
        {"text": T("⚪  Hide") if r.get("published", True) else T("🟢  Show"),
         "callback_data": f"hpub:{hero_id}"},
        {"text": T("🗑  Delete"), "callback_data": f"hdel:{hero_id}"}])
    buttons.append([{"text": T("🖼  Hero images"), "callback_data": "hlist"},
                    {"text": T("⬅  Menu"), "callback_data": "menu"}])

    body = "\n".join(parts)
    if message_id:
        edit(chat_id, message_id, body, buttons)
    else:
        send(chat_id, body, buttons)

    if r.get("fileId"):
        api("sendPhoto", {"chat_id": chat_id, "photo": r["fileId"],
                          "caption": f"{hero_id} — {T('position')} {pos + 1}"})


def tools_screen(chat_id, message_id=None):
    """Everything that used to be typed-only lives here, so no command has to
    be remembered to reach any part of the bot."""
    jobs = load_jobs()
    drafts = sum(1 for j in jobs if not j.get("published"))
    missing = sum(1 for j in jobs
                  if (j.get("photoFileId") and not j.get("photo")))

    rows = [
        [{"text": T("🖼  Hero images") + (f"  ({len(load_hero())})" if load_hero() else ""),
          "callback_data": "hlist"}],
        [{"text": T("⚪  Draft vacancies") + (f"  ({drafts})" if drafts else ""),
          "callback_data": "jdrafts"}],
        [{"text": T("\U0001F504  Re-sync job photos") + (f"  ({missing})" if missing else ""),
          "callback_data": "resync"}],
        [{"text": T("\U0001F511  Open a client by key"), "callback_data": "findkey"}],
        [{"text": T("❓  Help"), "callback_data": "help"}],
        [{"text": T("⬅  Menu"), "callback_data": "menu"}],
    ]

    parts = [T("⚙️ <b>Tools</b>"), rule(),
             T("Everything here can also be typed as a command — "
               "the buttons just save you remembering them.")]
    body = "\n".join(parts)
    if message_id:
        edit(chat_id, message_id, body, rows)
    else:
        send(chat_id, body, rows)

BACK = [[{"text": T("⬅  Menu"), "callback_data": "menu"}]]


def menu_text():
    db = load_db()
    total = len(db)
    counts = {}
    for c in db.values():
        counts[c.get("status")] = counts.get(c.get("status"), 0) + 1

    jobs = load_jobs()
    live = sum(1 for j in jobs if j.get("published"))

    lines = [
        T("\U0001F5C2 <b>ARYOS GROUP</b>"),
        T("<i>Control panel</i>"),
        rule(),
        T("\U0001F4CB <b>CLIENT FILES</b>"),
    ]
    # Every count below is a TF template, never an f-string: an f-string bakes
    # the number in before the translation table is consulted, which is what
    # left the dashboard half English while the buttons around it were not.
    if total:
        lines.append(TF("   <b>{n}</b> files on record", n=total))
        for code in STATUSES:
            n = counts.get(code, 0)
            if n:
                lines.append(f"   {status_label(code)} — <b>{n}</b>")
    else:
        lines.append(T("   No files yet."))

    lines += ["", T("\U0001F4BC <b>VACANCIES</b>"),
              TF("   🟢 <b>{n}</b> live on the website", n=live)]
    if len(jobs) - live:
        lines.append(TF("   ⚪ <b>{n}</b> draft", n=len(jobs) - live))
    if not jobs:
        lines.append(T("   None yet."))

    apps = load_apps()
    new = sum(1 for a in apps if not a.get("converted"))
    lines += ["", T("\U0001F4E5 <b>APPLICATIONS</b>")]
    if new:
        lines.append(TF("   🆕 <b>{n}</b> waiting for review", n=new))
    if apps and len(apps) - new:
        lines.append(TF("   ✅ <b>{n}</b> converted to client files", n=len(apps) - new))
    if not apps:
        lines.append(T("   None yet."))

    revs = load_reviews()
    waiting = sum(1 for r in revs if not r.get("published"))
    lines += ["", T("⭐ <b>REVIEWS</b>")]
    if waiting:
        lines.append(TF("   🕒 <b>{n}</b> waiting to be published", n=waiting))
    if revs and len(revs) - waiting:
        lines.append(TF("   ✅ <b>{n}</b> live on the website", n=len(revs) - waiting))
    if not revs:
        lines.append(T("   None yet."))

    lines += [rule(), T("Choose an action:")]
    return "\n".join(lines)


def main_menu(chat_id, title=None, message_id=None):
    text = title or menu_text()
    if message_id:
        edit(chat_id, message_id, text, menu_keyboard())
    else:
        send(chat_id, text, menu_keyboard())


# --------------------------------------------------------------------------- interview engine
#
# One engine drives three things: creating a client file, creating a vacancy,
# and re-asking a single field when a vacancy is edited. A state carries the
# step list it is walking, so the functions below never need to know which.

FLOWS = {
    "client": {"steps": STEPS,     "title": T("\U0001F4DD <b>New client file</b>")},
    "job":    {"steps": JOB_STEPS, "title": T("\U0001F4BC <b>New vacancy</b>")},
}


def flow_steps(state):
    """The step list this state is walking — a single field when editing."""
    if state.get("one"):
        return [state["one"]]
    return FLOWS[state.get("flow", "client")]["steps"]


def flow_title(state):
    if state.get("one"):
        return "✏️ " + TF("<b>Editing {field}</b>", field=esc(state.get("editing", "")))
    return FLOWS[state.get("flow", "client")]["title"]


# The interview keyboard always ends with the same navigation row, so the admin
# is never stuck mid-file with no way out.
def nav_row(state, step):
    row = []
    if state["i"] > 0:
        row.append({"text": T("⬅  Back"), "callback_data": "back"})
    if step.get("skip"):
        row.append({"text": T("⏭  Skip"), "callback_data": "pick:__skip"})
    row.append({"text": T("✖  Cancel"), "callback_data": "cancel"})
    return row


def ask(chat_id, state):
    steps = flow_steps(state)
    step = steps[state["i"]]
    typing(chat_id, "upload_photo" if step["kind"] == "photo" else "typing")

    header = flow_title(state) + "\n"
    if len(steps) > 1:
        header += f"<code>{progress_bar(state['i'], len(steps))}</code>\n"
    header += f"{rule()}\n"

    keyboard = []

    if step["kind"] == "choice":
        # The caption is translated, the payload keeps the stored English value.
        buttons = [{"text": choice_label(o), "callback_data": f"pick:{o}"[:64]}
                   for o in step["options"]]
        # Short labels sit two per row; long ones get a row each. Measured on
        # what is actually drawn, since a translation changes the width.
        per_row = 2 if max(len(choice_label(o)) for o in step["options"]) <= 22 else 1
        keyboard = chunk(buttons, per_row)
        if step.get("other"):
            keyboard.append([{"text": T("✏️  Other — type it"), "callback_data": "pick:__other"}])
    elif step["kind"] == "status":
        keyboard = chunk([{"text": status_label(c), "callback_data": f"pick:{c}"}
                          for c in STATUSES], 2)
    elif step["kind"] == "photo":
        header += T("<i>Send the image as a photo or a file.</i>\n")

    keyboard.append(nav_row(state, step))
    send(chat_id, header + step["prompt"], keyboard)


def tick(value):
    return "✅" if value else "⬜"


def summary(d):
    out = [T("\U0001F50E <b>CHECK THE FILE</b>"), rule()]

    out.append(f"👤 <b>{esc(d.get('nameEn') or '(no name)')}</b>")
    if d.get("nameKu"):
        out.append(f"     <i>{esc(d['nameKu'])}</i>")

    out += [
        "",
        f"📞 Phone: <b>{esc(d.get('phone'))}</b>",
        f"🌍 Nationality: {esc(d.get('nationality'))}",
        f"🎂 Age: {esc(d.get('age'))}",
        f"🎓 Education: {esc(d.get('education'))}",
        "",
        T("🛠 <b>Experience</b>"),
        esc(d.get("experience")),
        "",
        "⚖️ " + TF("Arrested before: <b>{answer}</b>",
                   answer=esc(choice_label(d.get("arrested")))),
    ]
    if d.get("arrestDetails"):
        out.append(f"     {esc(d['arrestDetails'])}")

    out += [
        "",
        "✈️ %s: %s" % (T("Route"), esc(choice_label(d.get("route")))),
        "📌 %s: %s" % (T("Status"), status_label(d.get("status"))),
    ]
    if d.get("note"):
        out.append("💬 %s: %s" % (T("Note"), esc(d["note"])))

    out += [
        rule(),
        "%s %s     %s %s" % (tick(d.get("idPhoto")), T("ID / passport"),
                             tick(d.get("clientPhoto")), T("Client photo")),
    ]
    return "\n".join(out)


def next_index(state, start):
    """First step at or after `start` whose only_if condition still holds."""
    steps = flow_steps(state)
    i = start
    while i < len(steps):
        step = steps[i]
        if "only_if" in step and not step["only_if"](state["data"]):
            i += 1
            continue
        return i
    return len(steps)


def prev_index(state, start):
    """Nearest earlier step that was actually asked."""
    steps = flow_steps(state)
    i = start - 1
    while i >= 0:
        step = steps[i]
        if "only_if" in step and not step["only_if"](state["data"]):
            i -= 1
            continue
        return i
    return 0


def confirm_screen(chat_id, state):
    if state.get("flow") == "job":
        send(chat_id,
             job_summary(state["data"]) + T("\n\n<b>Publish this vacancy?</b>"),
             [[{"text": T("✅  Publish now"), "callback_data": "jsave:1"}],
              [{"text": T("\U0001F4DD  Save as draft"), "callback_data": "jsave:0"}],
              [{"text": T("⬅  Change last answer"), "callback_data": "back"}],
              [{"text": T("🗑  Discard"), "callback_data": "cancel"}]])
        return

    send(chat_id,
         summary(state["data"]) + T("\n\n<b>Save this file?</b>"),
         [[{"text": T("✅  Save and create key"), "callback_data": "save"}],
          [{"text": T("⬅  Change last answer"), "callback_data": "back"}],
          [{"text": T("🗑  Discard"), "callback_data": "cancel"}]])


def advance(chat_id, user_id, state):
    steps = flow_steps(state)
    state["i"] = next_index(state, state["i"] + 1)

    if state["i"] < len(steps):
        ask(chat_id, state)
        return

    # Editing a single field commits straight away — there is nothing to review.
    if state.get("one"):
        commit_field(chat_id, user_id, state)
        return

    typing(chat_id)
    confirm_screen(chat_id, state)


def go_back(chat_id, user_id, state):
    """Steps one question backwards and clears that answer so it is re-asked.

    From the confirmation screen (state["i"] == len(steps)) this lands on the
    last question that was actually asked, skipping any conditional step whose
    condition no longer holds.
    """
    steps = flow_steps(state)
    state["i"] = prev_index(state, min(state["i"], len(steps)))
    state["data"].pop(steps[state["i"]]["id"], None)
    ask(chat_id, state)


def save_client(chat_id, user_id):
    state = _states.get(user_id)
    if not state:
        send(chat_id, T("Nothing to save."), BACK)
        return

    with _lock:
        db = load_db()
        key = new_key(db)
        record = dict(state["data"])
        record.update({"key": key, "created": today(), "updated": today(), "by": user_id})
        db[key] = record
        save_db(db)

    _states.pop(user_id, None)
    typing(chat_id)
    send(chat_id,
         T("🎉 <b>FILE CREATED</b>") + "\n" + rule() + "\n"
         + T("Visa key for the client:") + "\n\n"
         + f"<code>{key}</code>\n\n"
         + T("Tap the key to copy it. The client enters it on the website to "
             "see their status."))
    show_client(chat_id, key)


# --------------------------------------------------------------------------- vacancy screens

def split_tags(raw):
    """'Housing arranged, Overtime paid' -> ['Housing arranged', 'Overtime paid']"""
    if isinstance(raw, list):
        return [t for t in raw if t]
    return [t.strip() for t in str(raw or "").replace(";", ",").split(",") if t.strip()]


def resync_report(fixed, failed):
    """The result panel after re-downloading job photos. Written out at both
    places re-sync can be started - the /resync command and the Tools button -
    so it lives here instead of being kept in step by hand."""
    return (T("🖼 <b>Photo re-sync</b>") + "\n" + rule() + "\n"
            + TF("Restored: <b>{fixed}</b>", fixed=fixed) + "\n"
            + TF("Failed: <b>{failed}</b>", failed=failed) + "\n\n"
            + T("<i>Run this after a redeploy if job photos stopped showing.</i>"))


def wizard_intro(flow):
    """The line shown before the first question of an interview.

    It was written out at all four places a wizard can start - two of them for
    vacancies, two for client files - so the wording had four copies to keep in
    step and four to translate. One helper instead.
    """
    if flow == "job":
        return (T("\U0001F4BC <b>New vacancy</b>") + "\n" + rule() + "\n"
                + TF("{n} questions. Tap <b>⬅ Back</b> to fix an answer, "
                     "or <b>✖ Cancel</b> to stop.", n=len(JOB_STEPS)))
    return (T("➕ <b>New client file</b>") + "\n" + rule() + "\n"
            + TF("{n} short questions. Tap <b>⬅ Back</b> to fix an answer, "
                 "or <b>✖ Cancel</b> to stop.", n=len(STEPS)))


def job_summary(d, heading=T("\U0001F50E <b>CHECK THE VACANCY</b>")):
    tags = split_tags(d.get("tags"))
    out = [heading, rule(),
           f"💼 <b>{esc(d.get('title') or '(no title)')}</b>",
           f"📍 {esc(d.get('city'))}, {esc(d.get('country'))}",
           ""]
    out += [
        "🏷 %s: %s" % (T("Category"), esc(choice_label(d.get("category")))),
        "📄 %s: %s" % (T("Type"), esc(choice_label(d.get("type")))),
        "💶 %s: <b>%s</b>" % (T("Salary"), esc(d.get("salary"))),
        "🔢 " + TF("Filter value: {amount} USD / month",
                   amount=esc(d.get("salaryUsd"))),
        "🕒 %s: %s" % (T("Hours"), esc(d.get("hours"))),
    ]
    if tags:
        out += ["", "✅ " + "\n✅ ".join(esc(t) for t in tags)]
    out += ["", T("📝 <b>Description</b>"), esc(d.get("desc"))]
    out += [rule(),
            "%s %s" % (tick(d.get("photo") or d.get("photoFileId")), T("Job photo"))]
    return "\n".join(out)


def job_state_to_record(d, jobs, job_id=None):
    """Turns interview answers into the record shape the website consumes."""
    country = (d.get("country") or "").strip()
    return {
        "id": job_id or new_job_id(jobs),
        "title": (d.get("title") or "").strip(),
        "country": country,
        "city": (d.get("city") or "").strip(),
        "region": COUNTRY_REGION.get(country, "Other"),
        "category": (d.get("category") or "").strip(),
        "salary": (d.get("salary") or "").strip(),
        "salaryUsd": int(d.get("salaryUsd") or 0),
        "hours": (d.get("hours") or "").strip(),
        "type": (d.get("type") or "Full-time").strip(),
        "tags": split_tags(d.get("tags")),
        "desc": (d.get("desc") or "").strip(),
        "photo": "",
        "photoFileId": d.get("photo") or "",
        "published": True,
        "created": today(),
        "updated": today(),
    }


def save_job(chat_id, user_id, publish=True):
    state = _states.get(user_id)
    if not state or state.get("flow") != "job":
        send(chat_id, T("Nothing to save."), BACK)
        return

    with _lock:
        jobs = load_jobs()
        record = job_state_to_record(state["data"], jobs)
        record["published"] = bool(publish)
        jobs.insert(0, record)
        save_jobs(jobs)

    _states.pop(user_id, None)

    # The photo arrives as a Telegram file_id; pull the bytes onto disk so the
    # website can serve the image itself.
    if record["photoFileId"]:
        typing(chat_id, "upload_photo")
        path = download_photo(record["photoFileId"], record["id"])
        if path:
            with _lock:
                jobs = load_jobs()
                target = find_job(jobs, record["id"])
                if target:
                    set_job_photo(target, path)
                    save_jobs(jobs)

    typing(chat_id)
    send(chat_id,
         (T("🎉 <b>VACANCY PUBLISHED</b>") if publish else T("\U0001F4DD <b>DRAFT SAVED</b>")) +
         "\n" + rule() + "\n"
         + f"<b>{esc(record['title'])}</b> — {esc(record['city'])}, {esc(record['country'])}\n"
         + TF("Reference: <code>{id}</code>", id=record["id"]) + "\n\n" +
         (T("<i>It is live on the website now.</i>") if publish
          else T("<i>Hidden from the website until you publish it.</i>")))
    show_job(chat_id, record["id"])


# --------------------------------------------------------------------------- vacancy filters
#
# With 150+ vacancies, Previous/Next alone means 26 pages of tapping to reach
# the end. Each admin keeps a small view of their own — a status, a country, a
# category and a search term — which narrows the list before it is paged.

_jobview = {}


def jobview(user_id):
    return _jobview.setdefault(user_id, {"status": "", "country": "", "category": "", "q": ""})


def apply_jobview(jobs, view):
    if view.get("status") == "live":
        jobs = [j for j in jobs if j.get("published")]
    elif view.get("status") == "draft":
        jobs = [j for j in jobs if not j.get("published")]
    if view.get("country"):
        jobs = [j for j in jobs if j.get("country") == view["country"]]
    if view.get("category"):
        jobs = [j for j in jobs if j.get("category") == view["category"]]
    if view.get("q"):
        q = view["q"].lower()
        jobs = [j for j in jobs if q in " ".join(
            str(j.get(k, "")) for k in ("title", "country", "city", "category")).lower()]
    return jobs


def jobview_line(view):
    """One line naming what is currently being hidden, or nothing at all."""
    bits = []
    if view.get("status"):
        bits.append(T("🟢 live") if view["status"] == "live" else T("⚪ drafts"))
    if view.get("country"):
        bits.append("📍 " + view["country"])
    if view.get("category"):
        bits.append("🏷 " + view["category"])
    if view.get("q"):
        bits.append(f"🔎 “{view['q']}”")
    return " · ".join(bits)


def list_jobs_screen(chat_id, page=0, message_id=None, only=None, user_id=None):
    jobs = load_jobs()
    if only == "draft":
        jobs = [j for j in jobs if not j.get("published")]
    elif only == "live":
        jobs = [j for j in jobs if j.get("published")]
    elif user_id is not None:
        jobs = apply_jobview(jobs, jobview(user_id))

    if not jobs:
        text = (T("\U0001F4BC <b>Vacancies</b>\n") + rule() +
                T("\nNothing here yet.\n\nUse ➕ New vacancy to add one."))
        rows = [[{"text": T("➕  New vacancy"), "callback_data": "jnew"}],
                [{"text": T("\U0001F4BC  All vacancies"), "callback_data": "jlist:0"}]] + BACK
        if message_id:
            edit(chat_id, message_id, text, rows)
        else:
            send(chat_id, text, rows)
        return

    per_page = 6
    pages = (len(jobs) + per_page - 1) // per_page
    page = max(0, min(page, pages - 1))
    window = jobs[page * per_page:(page + 1) * per_page]

    rows = []
    for j in window:
        mark = "🟢" if j.get("published") else "⚪"
        cam = "📷" if j.get("photo") or j.get("photoFileId") else "　"
        label = (f"{mark}{cam} {clip(j.get('title', '?'), 26)}"
                 f" · {choice_label(j.get('country', ''))}")
        rows.append([{"text": label, "callback_data": f"jopen:{j['id']}"}])

    # First / last jump as well as step-by-step: 26 pages of Next is not a UI.
    nav = []
    if page > 0:
        nav.append({"text": "⏮", "callback_data": "jlist:0"})
        nav.append({"text": T("◀  Prev"), "callback_data": f"jlist:{page - 1}"})
    if page < pages - 1:
        nav.append({"text": T("Next  ▶"), "callback_data": f"jlist:{page + 1}"})
        nav.append({"text": "⏭", "callback_data": f"jlist:{pages - 1}"})
    if nav:
        rows.append(nav)

    view = jobview(user_id) if user_id is not None else {}
    filtering = bool(jobview_line(view))
    filter_row = [{"text": T("🔎  Change filter") if filtering else T("🔎  Filter / search"),
                   "callback_data": "jfilter"}]
    if filtering:
        filter_row.append({"text": T("✖  Clear"), "callback_data": "jfclear"})
    rows.append(filter_row)
    rows.append([{"text": T("➕  New"), "callback_data": "jnew"},
                 {"text": T("⬅  Menu"), "callback_data": "menu"}])

    all_jobs = load_jobs()
    live = sum(1 for j in all_jobs if j.get("published"))
    total = len(all_jobs)

    parts = [T("💼 <b>Vacancies</b>"), rule()]
    if filtering:
        parts.append(jobview_line(view))
        parts.append(TF("<b>{n}</b> of {total} shown · page {page} of {pages}",
                        n=len(jobs), total=total, page=page + 1, pages=pages))
    else:
        parts.append(TF("🟢 {live} live · ⚪ {draft} draft · page {page} of {pages}",
                        live=live, draft=total - live, page=page + 1, pages=pages))
    parts.append(T("<i>📷 marks a job that has a photo. Tap one to edit it.</i>"))
    text = "\n".join(parts)

    if message_id:
        edit(chat_id, message_id, text, rows)
    else:
        send(chat_id, text, rows)


def filter_jobs_screen(chat_id, user_id, message_id=None):
    """Pick a status, country or category — each shows how many it would leave,
    so an admin never taps into an empty list."""
    view = jobview(user_id)
    jobs = load_jobs()

    def count(**over):
        probe = dict(view)
        probe.update(over)
        return len(apply_jobview(jobs, probe))

    def mark(field, value):
        return "● " if view.get(field) == value else "○ "

    rows = [[
        {"text": mark("status", "") + TF("All ({n})", n=count(status="")),
         "callback_data": "jfs:"},
        {"text": mark("status", "live") + TF("🟢 Live ({n})", n=count(status="live")),
         "callback_data": "jfs:live"},
        {"text": mark("status", "draft") + TF("⚪ Draft ({n})", n=count(status="draft")),
         "callback_data": "jfs:draft"},
    ]]

    countries = sorted({j.get("country", "") for j in jobs if j.get("country")})
    cats = sorted({j.get("category", "") for j in jobs if j.get("category")})

    rows.append([{"text": T("📍  Country…"), "callback_data": "jfclist"},
                 {"text": T("🏷  Category…"), "callback_data": "jfklist"}])
    rows.append([{"text": T("🔎  Type a search"), "callback_data": "jfq"}])
    if jobview_line(view):
        rows.append([{"text": T("✖  Clear all filters"), "callback_data": "jfclear"}])
    rows.append([{"text": T("💼  Show results"), "callback_data": "jlist:0"},
                 {"text": T("⬅  Menu"), "callback_data": "menu"}])

    shown = len(apply_jobview(jobs, view))
    parts = [T("🔎 <b>Filter vacancies</b>"), rule()]
    parts.append(jobview_line(view) or T("<i>No filter — showing everything.</i>"))
    parts.append(TF("<b>{shown}</b> of {total} vacancies match",
                    shown=shown, total=len(jobs)))
    parts.append(TF("<i>{countries} countries · {cats} categories on file.</i>",
                    countries=len(countries), cats=len(cats)))

    body = "\n".join(parts)
    if message_id:
        edit(chat_id, message_id, body, rows)
    else:
        send(chat_id, body, rows)


def pick_value_screen(chat_id, user_id, field, message_id=None):
    """The country / category chooser. Values are sent by index, because a
    callback payload is limited to 64 bytes and names like 'Technical &
    Trades' plus a prefix get close to it."""
    jobs = load_jobs()
    view = jobview(user_id)
    values = sorted({j.get(field, "") for j in jobs if j.get(field)})

    buttons = []
    for i, v in enumerate(values):
        n = len([j for j in apply_jobview(jobs, dict(view, **{field: v}))])
        dot = "● " if view.get(field) == v else ""
        code = "jfc" if field == "country" else "jfk"
        buttons.append({"text": f"{dot}{choice_label(v)} ({n})",
                        "callback_data": f"{code}:{i}"})

    rows = chunk(buttons, 2)
    clear_code = "jfc:-1" if field == "country" else "jfk:-1"
    rows.append([{"text": T("Any"), "callback_data": clear_code},
                 {"text": T("⬅  Back"), "callback_data": "jfilter"}])

    # Built as whole sentences rather than "Choose a %s" — Sorani inflects the
    # noun, so a shared template with a slot would read wrong in one of them.
    if field == "country":
        head = "📍 <b>" + T("Choose a country") + "</b>"
    else:
        head = "🏷 <b>" + T("Choose a category") + "</b>"
    body = (head + "\n" + rule() + "\n"
            + T("<i>The number is how many vacancies you would be left with.</i>"))
    if message_id:
        edit(chat_id, message_id, body, rows)
    else:
        send(chat_id, body, rows)


def show_job(chat_id, job_id, message_id=None):
    j = find_job(load_jobs(), job_id)
    if not j:
        send(chat_id, T("⚠️ That vacancy no longer exists."),
             [[{"text": T("\U0001F4BC  Vacancies"), "callback_data": "jlist:0"}]])
        return

    state = (T("🟢 Live on the website") if j.get("published")
             else T("⚪ Draft — hidden"))
    text = job_summary(j, f"\U0001F4BC <b>{esc(j.get('title'))}</b>")
    text += ("\n" + rule() + "\n" + state + "\n"
             + TF("<code>{id}</code> · updated {updated}",
                  id=j["id"], updated=j.get("updated", "?")))

    rows = [
        [{"text": T("✏️  Edit a field"), "callback_data": f"jedit:{job_id}"},
         {"text": T("🖼  Photo"), "callback_data": f"jphoto:{job_id}"}],
        [{"text": T("⚪  Unpublish") if j.get("published") else T("🟢  Publish"),
          "callback_data": f"jpub:{job_id}"},
         {"text": T("⧉  Duplicate"), "callback_data": f"jdup:{job_id}"}],
        [{"text": T("🗑  Delete"), "callback_data": f"jdel:{job_id}"}],
        [{"text": T("\U0001F4BC  Vacancies"), "callback_data": "jlist:0"},
         {"text": T("⬅  Menu"), "callback_data": "menu"}],
    ]

    if message_id:
        edit(chat_id, message_id, text, rows)
    else:
        send(chat_id, text, rows)


def edit_menu(chat_id, job_id, message_id=None):
    j = find_job(load_jobs(), job_id)
    if not j:
        send(chat_id, T("⚠️ That vacancy no longer exists."), BACK)
        return

    def preview(field):
        value = j.get(field)
        if field == "tags":
            value = ", ".join(split_tags(value))
        return clip(str(value or "—"), 22)

    labels = {
        "title": T("Title"), "country": T("Country"), "city": T("City"),
        "category": T("Category"), "type": T("Type"), "salary": T("Salary"),
        "salaryUsd": T("Filter value"), "hours": T("Hours"), "tags": T("Benefits"),
        "desc": T("Description"), "photo": T("Photo"),
    }

    rows = []
    for step in JOB_STEPS:
        f = step["id"]
        if f == "photo":
            continue
        rows.append([{"text": f"{labels[f]}: {preview(f)}",
                      "callback_data": f"jset:{job_id}:{f}"}])

    rows.append([{"text": T("🖼  Replace photo"), "callback_data": f"jphoto:{job_id}"}])
    rows.append([{"text": T("⬅  Back to vacancy"), "callback_data": f"jopen:{job_id}"}])

    text = ("✏️ " + TF("<b>Edit {title}</b>", title=esc(j.get("title")))
            + "\n" + rule() + "\n"
            + T("Tap the field you want to change. The current value is shown "
                "next to each one."))

    if message_id:
        edit(chat_id, message_id, text, rows)
    else:
        send(chat_id, text, rows)


def commit_field(chat_id, user_id, state):
    """Writes a single edited field back to the vacancy and returns to it."""
    job_id = state.get("jobId")
    field = state["one"]["id"]
    value = state["data"].get(field)

    _states.pop(user_id, None)

    with _lock:
        jobs = load_jobs()
        j = find_job(jobs, job_id)
        if not j:
            send(chat_id, T("⚠️ That vacancy no longer exists."), BACK)
            return

        if field == "tags":
            j["tags"] = split_tags(value)
        elif field == "salaryUsd":
            j["salaryUsd"] = int(value or 0)
        elif field == "photo":
            j["photoFileId"] = value or ""
        elif field == "country":
            j["country"] = (value or "").strip()
            j["region"] = COUNTRY_REGION.get(j["country"], "Other")
        else:
            j[field] = (value or "").strip()

        j["updated"] = today()
        save_jobs(jobs)

    if field == "photo" and value:
        typing(chat_id, "upload_photo")
        path = download_photo(value, job_id)
        with _lock:
            jobs = load_jobs()
            target = find_job(jobs, job_id)
            if target:
                set_job_photo(target, path)
                save_jobs(jobs)
        send(chat_id, T("🖼 Photo updated.") if path else
             T("⚠️ Saved, but the image could not be downloaded. Try /resync."))
    else:
        send(chat_id, f"✅ <b>{esc(field)}</b> updated.")

    show_job(chat_id, job_id)


# --------------------------------------------------------------------------- application screens

def list_reviews_screen(chat_id, page=0, message_id=None):
    rows_all = list(reversed(load_reviews()))       # newest first
    if not rows_all:
        text = (T("⭐ <b>Reviews</b>\n") + rule() +
                T("\nNothing yet.\n\n<i>Candidates are offered a review box after "
                "their application is sent. Anything they write waits here for "
                "you to publish.</i>"))
        if message_id:
            edit(chat_id, message_id, text, BACK)
        else:
            send(chat_id, text, BACK)
        return

    per_page = 8
    pages = (len(rows_all) + per_page - 1) // per_page
    page = max(0, min(page, pages - 1))
    window = rows_all[page * per_page:(page + 1) * per_page]

    rows = []
    for r in window:
        mark = "✅" if r.get("published") else "🕒"
        stars = "★" * int(r.get("rating") or 0)
        rows.append([{"text": f"{mark} {stars} {r.get('name', r['id'])[:20]}",
                      "callback_data": f"ropen:{r['id']}"}])

    nav = []
    if page > 0:
        nav.append({"text": T("◀  Previous"), "callback_data": f"rlist:{page - 1}"})
    if page < pages - 1:
        nav.append({"text": T("Next  ▶"), "callback_data": f"rlist:{page + 1}"})
    if nav:
        rows.append(nav)
    rows.append([{"text": T("⬅  Menu"), "callback_data": "menu"}])

    waiting = sum(1 for r in rows_all if not r.get("published"))
    text = (TF("⭐ <b>Reviews</b> ({n})", n=len(rows_all)) + "\n" + rule() + "\n"
            + TF("🕒 waiting for you: <b>{waiting}</b>   ✅ live on the site: <b>{live}</b>",
                 waiting=waiting, live=len(rows_all) - waiting))
    if message_id:
        edit(chat_id, message_id, text, rows)
    else:
        send(chat_id, text, rows)


def show_review(chat_id, review_id, message_id=None):
    r = next((x for x in load_reviews() if x.get("id") == review_id), None)
    if not r:
        send(chat_id, T("⚠️ That review no longer exists."), BACK)
        return

    state = "✅ Published — live on the website" if r.get("published") \
        else T("🕒 Waiting — not on the website yet")
    body = review_text(r).replace(
        "Nothing appears on the website until you publish it.", state)

    keyboard = [[
        {"text": "✖  Unpublish" if r.get("published") else "✅  Publish",
         "callback_data": ("rrej:" if r.get("published") else "rpub:") + r["id"]},
        {"text": T("🗑  Delete"), "callback_data": f"rdel:{r['id']}"},
    ], [{"text": T("⭐  All reviews"), "callback_data": "rlist:0"},
        {"text": T("⬅  Menu"), "callback_data": "menu"}]]

    if message_id:
        edit(chat_id, message_id, body, keyboard)
    else:
        send(chat_id, body, keyboard)


def set_review_published(review_id, published):
    with _lock:
        rows = load_reviews()
        for r in rows:
            if r.get("id") == review_id:
                r["published"] = published
                save_reviews(rows)
                return r
    return None


def delete_review(review_id):
    with _lock:
        rows = load_reviews()
        kept = [r for r in rows if r.get("id") != review_id]
        if len(kept) != len(rows):
            save_reviews(kept)
            return True
    return False


def list_apps_screen(chat_id, page=0, message_id=None):
    apps = load_apps()
    if not apps:
        text = (T("\U0001F4E5 <b>Applications</b>\n") + rule() +
                T("\nNothing yet.\n\n<i>Applications arrive here automatically when "
                "someone applies on the website.</i>"))
        if message_id:
            edit(chat_id, message_id, text, BACK)
        else:
            send(chat_id, text, BACK)
        return

    per_page = 8
    pages = (len(apps) + per_page - 1) // per_page
    page = max(0, min(page, pages - 1))
    window = apps[page * per_page:(page + 1) * per_page]

    rows = []
    for a in window:
        mark = "✅" if a.get("converted") else "🆕"
        name = a.get("answers", {}).get("fullName", a["id"])
        job = a.get("jobTitle", "")[:16]
        rows.append([{"text": f"{mark} {clip(name, 22)}" + (f" · {job}" if job else ""),
                      "callback_data": f"aopen:{a['id']}"}])

    nav = []
    if page > 0:
        nav.append({"text": T("◀  Previous"), "callback_data": f"alist:{page - 1}"})
    if page < pages - 1:
        nav.append({"text": T("Next  ▶"), "callback_data": f"alist:{page + 1}"})
    if nav:
        rows.append(nav)
    rows.append([{"text": T("⬅  Menu"), "callback_data": "menu"}])

    new = sum(1 for a in apps if not a.get("converted"))
    text = (T("\U0001F4E5 <b>Applications</b>") + "\n" + rule() + "\n"
            + TF("🆕 {new} new · ✅ {done} converted · page {page} of {pages}",
                 new=new, done=len(apps) - new, page=page + 1, pages=pages))

    if message_id:
        edit(chat_id, message_id, text, rows)
    else:
        send(chat_id, text, rows)


def find_app(apps, app_id):
    for a in apps:
        if a.get("id") == app_id:
            return a
    return None


def show_app(chat_id, app_id, with_photos=True):
    a = find_app(load_apps(), app_id)
    if not a:
        send(chat_id, T("⚠️ That application no longer exists."), BACK)
        return

    typing(chat_id)
    text = application_text(a)
    if a.get("converted"):
        text += "\n\n✅ " + TF("<i>Already converted to client file {key}</i>",
                              key=esc(a.get("clientKey", "")))

    rows = []
    if not a.get("converted"):
        rows.append([{"text": T("\U0001F5C2  Create client file"), "callback_data": f"aconv:{app_id}"}])
    rows.append([{"text": T("🗑  Delete"), "callback_data": f"adel:{app_id}"}])
    rows.append([{"text": T("\U0001F4E5  Applications"), "callback_data": "alist:0"},
                 {"text": T("⬅  Menu"), "callback_data": "menu"}])

    send(chat_id, text, rows)

    if with_photos:
        for slot, label in APP_PHOTOS:
            rel = a.get("photos", {}).get(slot)
            if not rel:
                continue
            path = os.path.join(MEDIA_ROOT, rel)
            if os.path.exists(path):
                typing(chat_id, "upload_photo")
                send_photo_file(chat_id, path, f"{label} — {app_id}")


def convert_app(chat_id, user_id, app_id):
    """Turns an application into a client file with a visa key, in one tap."""
    with _lock:
        apps = load_apps()
        a = find_app(apps, app_id)
        if not a:
            send(chat_id, T("⚠️ That application no longer exists."), BACK)
            return
        if a.get("converted"):
            send(chat_id, TF("Already converted — key <code>{key}</code>.",
                             key=esc(a.get("clientKey", ""))))
            show_client(chat_id, a.get("clientKey", ""))
            return

        ans = a.get("answers", {})
        db = load_db()
        key = new_key(db)

        langs = ans.get("languages")
        if isinstance(langs, list):
            langs = ", ".join(langs)

        experience = ans.get("experience", "")
        if ans.get("skills"):
            experience += f"\n\nSkills: {ans['skills']}"
        if langs:
            experience += f"\nLanguages: {langs}"
        if ans.get("currentJob"):
            experience += f"\nCurrent job: {ans['currentJob']}"

        db[key] = {
            "key": key,
            "nameEn": ans.get("fullName", ""),
            "phone": ans.get("phone", ""),
            "nationality": ans.get("nationality", ""),
            "age": ans.get("age", ""),
            "dob": ans.get("dob", ""),
            "education": ans.get("education", ""),
            "experience": experience.strip(),
            "arrested": ans.get("criminalRecord", "No"),
            "arrestDetails": ans.get("criminalDetails", ""),
            "route": a.get("jobCountry", ""),
            "status": "review",
            "note": (f"Application received for {a.get('jobTitle')}."
                     if a.get("jobTitle") else "Application received."),
            "created": today(),
            "updated": today(),
            "by": user_id,
            "fromApplication": app_id,
        }
        save_db(db)

        a["converted"] = True
        a["clientKey"] = key
        save_apps(apps)

    send(chat_id,
         T("\U0001F5C2 <b>CLIENT FILE CREATED</b>") + "\n" + rule() + "\n"
         + TF("From application <code>{id}</code>", id=app_id) + "\n\n"
         + T("Visa key for the client:") + f"\n<code>{key}</code>\n\n"
         + T("<i>Send them this key so they can track their status on the "
             "website. The ID photos stay on the application.</i>"))
    show_client(chat_id, key)


def list_clients(chat_id, page=0, message_id=None):
    db = load_db()
    clients = sorted(db.values(), key=lambda c: c.get("updated", c.get("created", "")),
                     reverse=True)
    if not clients:
        text = (T("\U0001F4CB <b>Client files</b>\n") + rule() +
                T("\nNo files yet.\n\nUse ➕ New client file to add the first one."))
        rows = [[{"text": T("➕  New client file"), "callback_data": "new"}]] + BACK
        edit(chat_id, message_id, text, rows) if message_id else send(chat_id, text, rows)
        return

    per_page = 8
    pages = (len(clients) + per_page - 1) // per_page
    page = max(0, min(page, pages - 1))
    window = clients[page * per_page:(page + 1) * per_page]

    rows = []
    for c in window:
        icon = STATUS_ICON.get(c.get("status"), "⚪")
        name = c.get("nameEn") or c["key"]
        rows.append([{"text": f"{icon}  {name[:34]}", "callback_data": f"open:{c['key']}"}])

    nav = []
    if page > 0:
        nav.append({"text": T("◀  Previous"), "callback_data": f"list:{page - 1}"})
    if page < pages - 1:
        nav.append({"text": T("Next  ▶"), "callback_data": f"list:{page + 1}"})
    if nav:
        rows.append(nav)
    rows.append([{"text": T("➕  New"), "callback_data": "new"},
                 {"text": T("⬅  Menu"), "callback_data": "menu"}])

    text = (T("\U0001F4CB <b>Client files</b>") + "\n" + rule() + "\n"
            + TF("{n} total · page {page} of {pages}",
                 n=len(clients), page=page + 1, pages=pages) + "\n"
            + T("<i>Newest activity first. Tap a name to open the file.</i>"))

    if message_id:
        edit(chat_id, message_id, text, rows)
    else:
        send(chat_id, text, rows)


def show_client(chat_id, key):
    db = load_db()
    c = db.get(key)
    if not c:
        send(chat_id, T("⚠️ No file with that key."), BACK)
        return

    typing(chat_id)

    lines = [
        f"\U0001F5C2 <b>{esc(c.get('nameEn') or '(no name)')}</b>",
    ]
    if c.get("nameKu"):
        lines.append(f"<i>{esc(c['nameKu'])}</i>")

    lines += [
        f"🔑 <code>{c['key']}</code>",
        f"📌 {status_label(c.get('status'))}",
        rule(),
        f"📞 {esc(c.get('phone'))}",
        f"🌍 {esc(choice_label(c.get('nationality')))}   ·   🎂 {esc(c.get('age'))}",
        f"🎓 {esc(choice_label(c.get('education')))}",
        "",
        T("🛠 <b>Experience</b>"),
        esc(c.get("experience")),
        "",
        "⚖️ " + TF("Arrested before: <b>{answer}</b>",
                   answer=esc(choice_label(c.get("arrested")))),
    ]
    if c.get("arrestDetails"):
        lines.append(f"     {esc(c['arrestDetails'])}")

    lines.append(f"✈️ {esc(choice_label(c.get('route')))}")
    if c.get("note"):
        lines += ["", T("💬 <b>Shown to the client</b>") + "\n" + esc(c["note"])]

    lines += [rule(),
              TF("<i>Created {created} · updated {updated}</i>",
                 created=c.get("created"), updated=c.get("updated")),
              "",
              T("<b>Change status:</b>")]

    # The current status is marked and is not offered as a button again.
    rows = chunk([{"text": ("✔ " if code == c.get("status") else "") + status_label(code),
                   "callback_data": f"set:{c['key']}:{code}"} for code in STATUSES], 2)
    rows.append([{"text": T("\U0001F4CB  Client list"), "callback_data": "list:0"},
                 {"text": T("⬅  Menu"), "callback_data": "menu"}])

    send(chat_id, "\n".join(lines), rows)

    for field, caption in (("idPhoto", T("🪪 ID / passport")), ("clientPhoto", T("📷 Client photo"))):
        if c.get(field):
            typing(chat_id, "upload_photo")
            api("sendPhoto", {"chat_id": chat_id, "photo": c[field],
                              "caption": f"{caption} — {c['key']}"})


# --------------------------------------------------------------------------- handlers

def normalize_key(text):
    bare = re.sub(r"[^A-Z0-9]", "", text.upper())
    bare = re.sub(r"^ARY", "", bare)
    return f"ARY-{bare[:4]}-{bare[4:]}" if len(bare) == 8 else None


def handle_message(msg):
    chat_id = msg["chat"]["id"]
    user_id = msg["from"]["id"]
    text = (msg.get("text") or "").strip()

    if user_id not in ADMIN_IDS:
        send(chat_id, T("🔒 <b>Staff only</b>\n") + rule() + "\n"
             + T("This bot manages Aryos Group client files.") + "\n\n"
             + TF("Your Telegram ID is <code>{id}</code> — send it to an "
                  "administrator if you should have access.", id=user_id))
        return

    # A hero picture arriving for the upload prompt. Handled up here because
    # the interview engine below would otherwise read it as an answer.
    hero_state = _states.get(user_id) or {}
    if hero_state.get("awaiting") in ("heroadd", "heroreplace"):
        photos = msg.get("photo") or []
        file_id = photos[-1]["file_id"] if photos else (msg.get("document") or {}).get("file_id")
        if not file_id:
            send(chat_id, T("⚠️ Send a picture, or tap Cancel."))
            return

        _states.pop(user_id, None)
        typing(chat_id, "upload_photo")

        if hero_state["awaiting"] == "heroreplace":
            hero_id = hero_state.get("hero", "")
            rel, widths = download_hero(file_id, hero_id)
            if not rel:
                send(chat_id, T("⚠️ That picture could not be saved. Try again."),
                     [[{"text": T("🖼  Hero images"), "callback_data": "hlist"}]])
                return
            with _lock:
                rows = load_hero()
                for r in rows:
                    if r.get("id") == hero_id:
                        r.update({"file": rel, "fileId": file_id, "widths": widths,
                                  "added": today()})
                        break
                save_hero(rows)
            send(chat_id, T("✅ Hero image replaced — the website shows it now."))
            show_hero(chat_id, hero_id)
            return

        with _lock:
            rows = load_hero()
            hero_id = new_hero_id(rows)
            order = max([r.get("order", 0) for r in rows], default=-1) + 1
        rel, widths = download_hero(file_id, hero_id)
        if not rel:
            send(chat_id, T("⚠️ That picture could not be saved. Try again."),
                 [[{"text": T("🖼  Hero images"), "callback_data": "hlist"}]])
            return
        with _lock:
            rows = load_hero()
            rows.append({"id": hero_id, "file": rel, "fileId": file_id,
                         "widths": widths, "order": order, "published": True,
                         "added": today()})
            save_hero(rows)

        note = ("" if widths else
                T("\n<i>Saved at the size Telegram sent. This server has no "
                  "image library, so no smaller copies were made.</i>"))
        send(chat_id, T("✅ Hero image added — it is on the website now.") + note)
        list_hero_screen(chat_id)
        return

    if text in ("/start", "/menu"):
        _states.pop(user_id, None)
        typing(chat_id)
        # Sent first and separately: a message may carry an inline keyboard or
        # a reply keyboard, not both, and the panel below needs its inline one.
        send(chat_id, T("🗂 <b>Aryos Group</b> — everything is a button now.\n"
                        "<i>The row under the text box is always here.</i>"),
             home=True)
        main_menu(chat_id)
        return
    if text in ("/help", "/commands"):
        send(chat_id, help_text(), BACK)
        return
    if text in ("/job", "/newjob"):
        _states[user_id] = {"i": 0, "data": {}, "flow": "job"}
        send(chat_id, wizard_intro("job"))
        ask(chat_id, _states[user_id])
        return
    if text == "/jobs":
        list_jobs_screen(chat_id, user_id=user_id)
        return
    if text == "/drafts":
        list_jobs_screen(chat_id, only="draft")
        return
    if text in ("/applications", "/apps"):
        list_apps_screen(chat_id)
        return
    if text in ("/reviews", "/review"):
        list_reviews_screen(chat_id)
        return
    if text in ("/hero", "/heroes"):
        list_hero_screen(chat_id)
        return
    if text == "/resync":
        send(chat_id, T("🔄 Checking job photos…"))
        fixed, failed = resync_photos()
        send(chat_id, resync_report(fixed, failed), BACK)
        return
    if text == "/cancel":
        had = _states.pop(user_id, None)
        send(chat_id, T("🗑 File discarded — nothing was saved.") if had else T("Nothing to cancel."), BACK)
        return
    if text == "/new":
        _states[user_id] = {"i": 0, "data": {}}
        send(chat_id, wizard_intro("client"))
        ask(chat_id, _states[user_id])
        return
    if text == "/list":
        list_clients(chat_id)
        return
    if text.startswith("/find"):
        key = normalize_key(text[5:])
        if key:
            show_client(chat_id, key)
        else:
            send(chat_id, T("Usage: <code>/find ARY-XXXX-XXXX</code>"))
        return

    state = _states.get(user_id)

    # A tap on the keyboard under the text box arrives as plain text. It is
    # navigation, never an answer — but the keyboard is always on screen, so a
    # stray tap mid-interview would silently bin a half-filled file. Ask first.
    if text in NAV_LABELS:
        if state and not state.get("awaiting"):
            steps = flow_steps(state)
            send(chat_id,
                 T("⚠️ <b>Leave this unfinished?</b>\n") + rule() +
                 f"\n{T('You are on question')} <b>{state['i'] + 1}</b> of "
                 f"<b>{len(steps)}</b>. " +
                 T("Nothing is saved until the last step, so leaving now loses it."),
                 [[{"text": T("↩  Keep filling it in"), "callback_data": "noop"}],
                  [{"text": T("🚪  Leave") + f" → {text}", "callback_data": f"leave:{text}"}]])
            return
        _states.pop(user_id, None)
        route_nav(chat_id, user_id, text)
        return

    # One-shot prompts, not interviews: the next thing typed is a search term
    # or a client key. Checked before the interview engine, which would treat
    # it as an answer to a question that was never asked.
    if state and state.get("awaiting") == "jobsearch":
        _states.pop(user_id, None)
        jobview(user_id)["q"] = text.strip()[:40]
        list_jobs_screen(chat_id, 0, user_id=user_id)
        return

    if state and state.get("awaiting") == "clientkey":
        _states.pop(user_id, None)
        key = normalize_key(text)
        if key and key in load_db():
            show_client(chat_id, key)
        else:
            send(chat_id, T("⚠️ No client file with that key.\n") + rule() +
                 T("\nCheck the key, or find them in the client list."),
                 [[{"text": T("📋  Client list"), "callback_data": "list:0"},
                   {"text": T("⬅  Menu"), "callback_data": "menu"}]])
        return

    if not state:
        # A bare key pasted into the chat opens that file — a common shortcut.
        key = normalize_key(text)
        if key and key in load_db():
            show_client(chat_id, key)
            return
        main_menu(chat_id)
        return

    step = flow_steps(state)[state["i"]]

    if step["kind"] == "photo":
        photos = msg.get("photo") or []
        file_id = photos[-1]["file_id"] if photos else (msg.get("document") or {}).get("file_id")
        if not file_id:
            send(chat_id, T("📷 That step needs an image. Send a photo, or attach the "
                          "scan as a file."))
            return
        state["data"][step["id"]] = file_id
        advance(chat_id, user_id, state)
        return

    if not text:
        send(chat_id, T("✍️ Please answer this step with text."))
        return

    if step["kind"] == "number":
        if not text.isdigit() or not (step["min"] <= int(text) <= step["max"]):
            send(chat_id, "🔢 " + TF("Enter a number between <b>{low}</b> and "
                                     "<b>{high}</b>.",
                                     low=step["min"], high=step["max"]))
            return

    state["data"][step["id"]] = text
    advance(chat_id, user_id, state)


def handle_callback(cb):
    source = cb.get("message") or {}
    chat = source.get("chat") or {}
    chat_id = chat.get("id") or cb["from"]["id"]
    message_id = source.get("message_id")     # None for very old messages
    user_id = cb["from"]["id"]

    def done(note=None, alert=False):
        """Clears the button's spinner, optionally with a toast in Telegram."""
        payload = {"callback_query_id": cb["id"]}
        if note:
            payload["text"] = note
            payload["show_alert"] = alert
        api("answerCallbackQuery", payload, timeout=10)

    if user_id not in ADMIN_IDS:
        done(T("Staff only."), True)
        return

    parts = (cb.get("data") or "").split(":")
    action, rest = parts[0], parts[1:]

    if action == "menu":
        _states.pop(user_id, None)
        done()
        main_menu(chat_id, message_id=message_id)
    elif action == "tools":
        done()
        tools_screen(chat_id, message_id=message_id)
    elif action == "jdrafts":
        done()
        list_jobs_screen(chat_id, 0, message_id=message_id, only="draft")
    elif action == "resync":
        done(T("Checking photos…"))
        edit(chat_id, message_id, T("🔄 Checking job photos…"), [])
        fixed, failed = resync_photos()
        edit(chat_id, message_id, resync_report(fixed, failed),
             [[{"text": T("⚙️  Tools"), "callback_data": "tools"},
               {"text": T("⬅  Menu"), "callback_data": "menu"}]])
    elif action == "findkey":
        _states[user_id] = {"awaiting": "clientkey"}
        done()
        edit(chat_id, message_id,
             T("🔑 <b>Open a client file</b>\n") + rule() +
             T("\nSend the visa key, for example <code>ARY-7K2M-9QX4</code>."
             "\n<i>Capital letters and dashes are optional.</i>"),
             [[{"text": T("📋  Client list"), "callback_data": "list:0"},
               {"text": T("⬅  Menu"), "callback_data": "menu"}]])
    elif action == "help":
        done()
        edit(chat_id, message_id, help_text(),
             [[{"text": T("⚙️  Tools"), "callback_data": "tools"},
               {"text": T("⬅  Menu"), "callback_data": "menu"}]])
    elif action == "leave":
        # Confirmed abandoning a half-finished file to navigate elsewhere.
        _states.pop(user_id, None)
        done()
        route_nav(chat_id, user_id, ":".join(rest))
    elif action == "noop":
        # "Keep filling it in" — dismiss the prompt, change nothing.
        done(T("Carry on"))
    # ---------------------------------------------------------------- hero images
    elif action == "hlist":
        done()
        list_hero_screen(chat_id, message_id=message_id)
    elif action == "hopen":
        done()
        show_hero(chat_id, ":".join(rest), message_id=message_id)
    elif action == "hadd":
        _states[user_id] = {"awaiting": "heroadd"}
        done()
        edit(chat_id, message_id,
             "🖼 <b>" + T("Send the new hero picture") + "</b>\n" + rule() +
             T("\nSend it now as a photo.\n\n"
               "<i>Landscape suits a desktop banner; a tall picture fills a "
               "phone better. Send it as a photo, not a file — Telegram sizes "
               "it for the web on the way through.</i>"),
             [[{"text": T("✖  Cancel"), "callback_data": "hlist"}]])
    elif action == "hrep":
        hid = ":".join(rest)
        _states[user_id] = {"awaiting": "heroreplace", "hero": hid}
        done()
        edit(chat_id, message_id,
             "🔄 <b>" + T("Replace") + f" {esc(hid)}</b>\n" + rule() +
             T("\nSend the new picture now. It keeps its position in the order."),
             [[{"text": T("✖  Cancel"), "callback_data": f"hopen:{hid}"}]])
    elif action in ("hup", "hdown"):
        hid = ":".join(rest)
        moved = hero_reorder(hid, -1 if action == "hup" else 1)
        done(T("Moved") if moved else T("Already at the end"))
        show_hero(chat_id, hid, message_id=message_id)
    elif action == "hpub":
        hid = ":".join(rest)
        with _lock:
            rows = load_hero()
            for r in rows:
                if r.get("id") == hid:
                    r["published"] = not r.get("published", True)
                    save_hero(rows)
                    break
        done(T("Updated"))
        show_hero(chat_id, hid, message_id=message_id)
    elif action == "hdel":
        hid = ":".join(rest)
        done()
        edit(chat_id, message_id,
             "🗑 <b>" + T("Delete this hero image?") + "</b>\n" + rule() +
             T("\nThe picture is removed from the server as well. There is no undo."
               "\n\n<i>To take it off the website but keep it, use Hide.</i>"),
             [[{"text": T("🗑  Yes, delete it"), "callback_data": f"hdelyes:{hid}"}],
              [{"text": T("↩  Keep it"), "callback_data": f"hopen:{hid}"}]])
    elif action == "hdelyes":
        ok = delete_hero(":".join(rest))
        done(T("Deleted") if ok else T("Gone"))
        list_hero_screen(chat_id, message_id=message_id)
    elif action == "new":
        done(T("Starting a new file"))
        _states[user_id] = {"i": 0, "data": {}}
        send(chat_id, wizard_intro("client"))
        ask(chat_id, _states[user_id])
    elif action == "list":
        done()
        list_clients(chat_id, int(rest[0]) if rest else 0, message_id=message_id)
    elif action == "open":
        done()
        show_client(chat_id, ":".join(rest))
    elif action == "save":
        done("Saving…")
        save_client(chat_id, user_id)
    elif action == "cancel":
        had = _states.pop(user_id, None)
        done("Discarded" if had else None)
        send(chat_id, T("🗑 File discarded — nothing was saved.") if had else "Cancelled.", BACK)
    elif action == "back":
        state = _states.get(user_id)
        if not state:
            done(T("Nothing to go back to"))
            return
        done(T("⬅ Previous question"))
        go_back(chat_id, user_id, state)
    elif action == "set":
        key, code = rest[0], rest[1]
        if code not in STATUSES:
            done()
            return
        with _lock:
            db = load_db()
            if key not in db:
                done(T("That file no longer exists"), True)
                return
            if db[key].get("status") == code:
                done(T("Already ") + STATUSES[code][0])
                return
            was = db[key].get("status")
            db[key]["status"] = code
            db[key]["updated"] = today()
            save_db(db)
        done(TF("Now {status}", status=T(STATUSES[code][0])))
        send(chat_id,
             T("✅ <b>Status updated</b>") + "\n" + rule() + "\n"
             + f"<code>{key}</code>\n"
             + f"{status_label(was, 'not set')}  ➜  {status_label(code)}\n\n"
             + T("<i>The client sees this immediately on the website.</i>"))
        show_client(chat_id, key)
    # ---------------------------------------------------------------- vacancies
    elif action == "jnew":
        done(T("Starting a new vacancy"))
        _states[user_id] = {"i": 0, "data": {}, "flow": "job"}
        send(chat_id, wizard_intro("job"))
        ask(chat_id, _states[user_id])
    elif action == "jlist":
        done()
        list_jobs_screen(chat_id, int(rest[0]) if rest and rest[0].isdigit() else 0,
                         message_id=message_id, user_id=user_id)
    elif action == "jfilter":
        done()
        filter_jobs_screen(chat_id, user_id, message_id=message_id)
    elif action == "jfs":
        jobview(user_id)["status"] = rest[0] if rest else ""
        done()
        filter_jobs_screen(chat_id, user_id, message_id=message_id)
    elif action == "jfclist":
        done()
        pick_value_screen(chat_id, user_id, "country", message_id=message_id)
    elif action == "jfklist":
        done()
        pick_value_screen(chat_id, user_id, "category", message_id=message_id)
    elif action in ("jfc", "jfk"):
        field = "country" if action == "jfc" else "category"
        values = sorted({j.get(field, "") for j in load_jobs() if j.get(field)})
        try:
            idx = int(rest[0])
        except (IndexError, ValueError):
            idx = -1
        jobview(user_id)[field] = values[idx] if 0 <= idx < len(values) else ""
        done()
        filter_jobs_screen(chat_id, user_id, message_id=message_id)
    elif action == "jfq":
        _states[user_id] = {"awaiting": "jobsearch"}
        done()
        send(chat_id, T("🔎 <b>Search vacancies</b>\n") + rule() +
             T("\nSend a word to look for — a title, a city or a country.\n"
             "<i>Example: nurse, Berlin, Poland</i>"),
             [[{"text": T("✖  Cancel"), "callback_data": "jfilter"}]])
    elif action == "jfclear":
        _jobview[user_id] = {"status": "", "country": "", "category": "", "q": ""}
        done(T("Filter cleared"))
        list_jobs_screen(chat_id, 0, message_id=message_id, user_id=user_id)
    elif action == "jopen":
        done()
        show_job(chat_id, ":".join(rest), message_id=message_id)
    elif action == "jsave":
        publish = bool(rest and rest[0] == "1")
        done("Publishing…" if publish else T("Saving draft…"))
        save_job(chat_id, user_id, publish=publish)
    elif action == "jedit":
        done()
        edit_menu(chat_id, ":".join(rest), message_id=message_id)
    elif action == "jset":
        job_id, field = rest[0], rest[1]
        step = next((s for s in JOB_STEPS if s["id"] == field), None)
        j = find_job(load_jobs(), job_id)
        if not step or not j:
            done(T("Cannot edit that"), True)
            return
        done(T("Editing ") + field)
        # A one-step interview: answer it and the value is written straight back.
        _states[user_id] = {"i": 0, "data": {}, "one": step,
                            "jobId": job_id, "editing": j.get("title", field)}
        current = j.get(field)
        if field == "tags":
            current = ", ".join(split_tags(current))
        send(chat_id, T("Current value:") + f"\n<b>{esc(current or '—')}</b>")
        ask(chat_id, _states[user_id])
    elif action == "jphoto":
        job_id = ":".join(rest)
        j = find_job(load_jobs(), job_id)
        if not j:
            done(T("That vacancy no longer exists"), True)
            return
        done(T("Send the new photo"))
        step = next(s for s in JOB_STEPS if s["id"] == "photo")
        _states[user_id] = {"i": 0, "data": {}, "one": step,
                            "jobId": job_id, "editing": j.get("title", "")}
        ask(chat_id, _states[user_id])
    elif action == "jpub":
        job_id = ":".join(rest)
        with _lock:
            jobs = load_jobs()
            j = find_job(jobs, job_id)
            if not j:
                done(T("That vacancy no longer exists"), True)
                return
            j["published"] = not j.get("published")
            j["updated"] = today()
            save_jobs(jobs)
            now_live = j["published"]
        done(T("Now live") if now_live else T("Hidden from the website"))
        show_job(chat_id, job_id, message_id=message_id)
    elif action == "jdup":
        job_id = ":".join(rest)
        with _lock:
            jobs = load_jobs()
            src = find_job(jobs, job_id)
            if not src:
                done(T("That vacancy no longer exists"), True)
                return
            copy = dict(src)
            copy["id"] = new_job_id(jobs)
            copy["title"] = (src.get("title", "") + " (copy)")[:80]
            copy["published"] = False          # never publish a copy by accident
            copy["created"] = copy["updated"] = today()
            set_job_photo(copy, "")            # re-attach an image deliberately
            copy["photoFileId"] = src.get("photoFileId", "")
            jobs.insert(0, copy)
            save_jobs(jobs)
        done(T("Copied as a draft"))
        if copy.get("photoFileId"):
            path = download_photo(copy["photoFileId"], copy["id"])
            if path:
                with _lock:
                    jobs = load_jobs()
                    t = find_job(jobs, copy["id"])
                    if t:
                        set_job_photo(t, path)
                        save_jobs(jobs)
        show_job(chat_id, copy["id"])
    elif action == "jdel":
        job_id = ":".join(rest)
        j = find_job(load_jobs(), job_id)
        if not j:
            done(T("Already gone"))
            return
        done()
        send(chat_id,
             T("🗑 <b>Delete this vacancy?</b>") + "\n" + rule() + "\n"
             + f"<b>{esc(j.get('title'))}</b> — {esc(j.get('city'))}, {esc(j.get('country'))}\n"
             + f"<code>{job_id}</code>\n\n" + T("<i>This cannot be undone.</i>"),
             [[{"text": T("🗑  Yes, delete it"), "callback_data": f"jdelyes:{job_id}"}],
              [{"text": T("⬅  Keep it"), "callback_data": f"jopen:{job_id}"}]])
    elif action == "jdelyes":
        job_id = ":".join(rest)
        with _lock:
            jobs = load_jobs()
            j = find_job(jobs, job_id)
            title = j.get("title", job_id) if j else job_id
            rel = (j or {}).get("photo")
            jobs = [x for x in jobs if x.get("id") != job_id]
            save_jobs(jobs)
        if rel:
            try:
                os.remove(os.path.join(MEDIA_ROOT, rel))
            except OSError:
                pass
        done("Deleted")
        send(chat_id, "🗑 " + TF("<b>{title}</b> deleted.", title=esc(title)))
        list_jobs_screen(chat_id, user_id=user_id)
    # ---------------------------------------------------------------- reviews
    elif action == "rlist":
        done()
        list_reviews_screen(chat_id, int(rest[0]) if rest and rest[0].isdigit() else 0,
                            message_id=message_id)
    elif action == "ropen":
        done()
        show_review(chat_id, ":".join(rest), message_id=message_id)
    elif action == "rpub":
        r = set_review_published(":".join(rest), True)
        done(T("Published — it is on the website now.") if r else T("Gone."))
        if r:
            show_review(chat_id, r["id"], message_id=message_id)
    elif action == "rrej":
        r = set_review_published(":".join(rest), False)
        done(T("Hidden from the website.") if r else T("Gone."))
        if r:
            show_review(chat_id, r["id"], message_id=message_id)
    elif action == "rdel":
        # Vacancies and applications both confirm before deleting; a review is
        # somebody's own words and cannot be recovered, so it asks too.
        rid = ":".join(rest)
        done()
        edit(chat_id, message_id,
             T("🗑 <b>Delete this review?</b>\n") + rule() +
             T("\nIt is removed for good — there is no undo.\n\n"
             "<i>To take it off the website but keep it, use Unpublish instead.</i>"),
             [[{"text": T("🗑  Yes, delete it"), "callback_data": f"rdelyes:{rid}"}],
              [{"text": T("↩  Keep it"), "callback_data": f"ropen:{rid}"}]])
    elif action == "rdelyes":
        ok = delete_review(":".join(rest))
        done(T("Deleted.") if ok else T("Gone."))
        list_reviews_screen(chat_id, message_id=message_id)
    # ---------------------------------------------------------------- applications
    elif action == "alist":
        done()
        list_apps_screen(chat_id, int(rest[0]) if rest and rest[0].isdigit() else 0,
                         message_id=message_id)
    elif action == "aopen":
        done()
        show_app(chat_id, ":".join(rest))
    elif action == "aconv":
        done(T("Creating the client file…"))
        convert_app(chat_id, user_id, ":".join(rest))
    elif action == "adel":
        app_id = ":".join(rest)
        a = find_app(load_apps(), app_id)
        if not a:
            done(T("Already gone"))
            return
        done()
        send(chat_id,
             T("🗑 <b>Delete this application?</b>") + "\n" + rule() + "\n"
             + f"<b>{esc(a.get('answers', {}).get('fullName', app_id))}</b>\n"
             + f"<code>{app_id}</code>\n\n"
             + T("<i>The photos are deleted too. This cannot be undone.</i>"),
             [[{"text": T("🗑  Yes, delete it"), "callback_data": f"adelyes:{app_id}"}],
              [{"text": T("⬅  Keep it"), "callback_data": f"aopen:{app_id}"}]])
    elif action == "adelyes":
        app_id = ":".join(rest)
        with _lock:
            apps = load_apps()
            a = find_app(apps, app_id)
            photos = list((a or {}).get("photos", {}).values())
            apps = [x for x in apps if x.get("id") != app_id]
            save_apps(apps)
        for rel in photos:
            try:
                os.remove(os.path.join(MEDIA_ROOT, rel))
            except OSError:
                pass
        done("Deleted")
        send(chat_id, "🗑 " + TF("Application <code>{id}</code> deleted.", id=app_id))
        list_apps_screen(chat_id)
    elif action == "pick":
        state = _states.get(user_id)
        if not state:
            done(T("That file was already closed"))
            return
        step = flow_steps(state)[state["i"]]
        value = ":".join(rest)
        if value == "__other":
            done()
            send(chat_id, T("✏️ Type your answer instead:"))
            return
        if value == "__skip":
            done("Skipped")
            state["data"][step["id"]] = ""
        else:
            done(value[:60])
            state["data"][step["id"]] = value
        advance(chat_id, user_id, state)
    else:
        done()


# --------------------------------------------------------------------------- public API

def jobs_payload():
    """Published vacancies in the shape the website's job cards expect.

    Drafts are withheld, and `posted` is derived here rather than stored so a
    card never claims a job was added "3 days ago" months later.
    """
    out = []
    for j in load_jobs():
        if not j.get("published"):
            continue
        country = j.get("country", "")
        out.append({
            "id": j.get("id"),
            "title": j.get("title", ""),
            "country": country,
            "city": j.get("city", ""),
            "region": j.get("region") or COUNTRY_REGION.get(country, "Other"),
            "category": j.get("category", ""),
            "salary": j.get("salary", ""),
            "salaryUsd": j.get("salaryUsd", 0),
            "hours": j.get("hours", ""),
            "type": j.get("type", "Full-time"),
            "tags": j.get("tags", []),
            "desc": j.get("desc", ""),
            "photo": ("media/" + j["photo"]) if j.get("photo") else "",
            # Sent only when the responsive copies were actually generated, so
            # the browser is never pointed at a file nobody wrote. Same rule as
            # hero_payload above.
            "photoWidths": j.get("photoWidths") or [],
            "posted": posted_label(j.get("created", "")),
            # The card shows "3 days ago"; search engines want the actual date,
            # so both go out and the page uses whichever it needs.
            "datePosted": j.get("created", ""),
        })
    return out


class StatusHandler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        raw = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path not in ("/apply", "/review"):
            self._send(404, {"error": "not_found"})
            return

        ip = (self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
              or self.client_address[0])
        if rate_limited(ip):
            self._send(429, {"ok": False, "error": "rate_limited"})
            return

        if parsed.path == "/review":
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            # Text only — no photos, so a review has no business being large.
            if length <= 0 or length > 16 * 1024:
                self._send(413, {"ok": False, "error": "too_large"})
                return
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception:
                self._send(400, {"ok": False, "error": "bad_json"})
                return
            try:
                rec = store_review(body, ip)
            except ValueError as err:
                self._send(400, {"ok": False, "error": str(err)})
                return
            except Exception as err:
                print(f"  ! review failed: {err}")
                self._send(500, {"ok": False, "error": "server"})
                return
            self._send(200, {"ok": True, "id": rec["id"]})
            threading.Thread(target=notify_admins_review, args=(rec,), daemon=True).start()
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        # Three photos at ~1400px plus the answers; 30 MB is generous but finite.
        if length <= 0 or length > 30 * 1024 * 1024:
            self._send(413, {"ok": False, "error": "too_large"})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            self._send(400, {"ok": False, "error": "bad_json"})
            return

        try:
            record = store_application(payload, ip)
        except ValueError as err:
            self._send(400, {"ok": False, "error": str(err)})
            return
        except Exception as err:
            print(f"  ! application failed: {err}")
            self._send(500, {"ok": False, "error": "server"})
            return

        # Answer the browser straight away; pushing to Telegram can take a
        # while with three photos and must not hold the candidate waiting.
        self._send(200, {"ok": True, "id": record["id"]})
        threading.Thread(target=notify_admins, args=(record,), daemon=True).start()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/jobs":
            self._send(200, jobs_payload())
            return

        if parsed.path == "/reviews":
            self._send(200, reviews_payload())
            return

        if parsed.path == "/hero":
            self._send(200, hero_payload())
            return

        if parsed.path != "/status":
            self._send(404, {"error": "not_found"})
            return

        # The only GET that answers with personal data, and the reference key
        # is the whole of its access control — so it does not get to be probed
        # without limit.
        ip = (self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
              or self.client_address[0])
        if rate_limited(ip, STATUS_LOOKUP_LIMIT, STATUS_LOOKUP_WINDOW, "status"):
            self._send(429, {"error": "rate_limited"})
            return

        key = urllib.parse.parse_qs(parsed.query).get("key", [""])[0].upper().strip()
        if not re.fullmatch(r"ARY-[A-Z0-9]{4}-[A-Z0-9]{4}", key):
            self._send(404, {"error": "not_found"})
            return

        c = load_db().get(key)
        if not c:
            self._send(404, {"error": "not_found"})
            return

        label, step = STATUSES.get(c.get("status"), STATUSES["review"])
        # Deliberately partial: no ID photo, no client photo, no phone, no arrest record.
        self._send(200, {
            "key": key,
            "name": c.get("nameEn") or c.get("nameKu") or "",
            "nationality": c.get("nationality", ""),
            "route": c.get("route", ""),
            "code": c.get("status"),
            "status": label,
            "step": step,
            "submitted": c.get("created"),
            "updated": c.get("updated"),
            "note": c.get("note") or "Your case officer will contact you with the next step.",
        })

    def log_message(self, *args):
        pass                                        # keep the console readable


def serve_status():
    HTTPServer(("127.0.0.1", STATUS_PORT), StatusHandler).serve_forever()


# --------------------------------------------------------------------------- main

def main():
    if not TOKEN:
        print("\n" + "=" * 62)
        print(T("  TELEGRAM BOT NOT STARTED — no token"))
        print("=" * 62)
        print(T("  Set the TELEGRAM_BOT_TOKEN environment variable to the token"))
        print(T("  @BotFather gave you, then restart."))
        print(T("  The website is still running; only the bot is disabled."))
        print("=" * 62 + "\n")
        return

    if not ADMIN_IDS:
        print(T("  ! ADMIN_IDS is empty — nobody will be able to use the bot."))

    print(T("Connecting to Telegram ..."))
    me = api("getMe", {}, timeout=20)
    if me and me.get("ok"):
        publish_commands()

    # These stop the bot but never the website: main() runs in a worker thread
    # under app.py, so returning here leaves the public site serving normally.
    if me is None:
        print(T("\nCould not reach Telegram from this machine.\n"
              "The token is probably fine — the connection is blocked or too slow.\n"
              "  Locally: turn on a VPN, or use your phone's hotspot.\n"
              "  Hosted:  check the platform allows outbound HTTPS.\n"
              "The website keeps running. Restart once the network is fixed.\n"))
        return

    if not me.get("ok"):
        print(f"\nTelegram rejected the token: {me.get('description', 'unknown reason')}\n"
              "Check TELEGRAM_BOT_TOKEN, or get a fresh token from @BotFather.\n"
              "The website keeps running.\n")
        return

    name = me["result"].get("username")

    # A bot cannot use long polling (getUpdates, below) while a webhook is set:
    # Telegram sends updates to the webhook instead and rejects getUpdates with
    # a 409 Conflict, so the bot connects but never sees a message and looks
    # dead. If this bot was ever pointed at a webhook (e.g. an older hosted
    # version), clear it here so polling works.
    hook = api("deleteWebhook", {}, timeout=20)
    if hook is not None and not hook.get("ok"):
        print(f"  ! could not clear an old webhook: {hook.get('description', 'unknown reason')}")

    if os.environ.get("DISABLE_STATUS_SERVER") != "1":
        threading.Thread(target=serve_status, daemon=True).start()

    print(f"Connected as @{name}")
    print(f"Admins: {', '.join(str(i) for i in ADMIN_IDS)}")
    print(f"Status API: http://localhost:{STATUS_PORT}/status?key=ARY-XXXX-XXXX")
    print(T("Open Telegram and send /start to the bot. Press Ctrl+C here to stop.\n"))

    # Long polling holds one connection open for ~25s, which is efficient but
    # many networks silently kill connections that sit idle. If that happens we
    # drop to short polling: many quick requests instead of one slow one.
    poll_seconds = 25
    failures = 0
    offset = None

    while True:
        res = api("getUpdates", {"offset": offset, "timeout": poll_seconds},
                  timeout=poll_seconds + 15)

        if res is None:                              # never reached Telegram
            failures += 1

            if failures == 3 and poll_seconds > 0:
                poll_seconds = 0
                print(T("  -> your network is dropping long connections;"
                      " switching to short polling"))
            elif failures == 12:
                print(T("\n  Still cannot reach Telegram after several tries."))
                print(T("  This network is probably filtering api.telegram.org."))
                print(T("  Turn on a VPN or use your phone's hotspot, then restart.\n"))

            time.sleep(2 if poll_seconds == 0 else 3)
            continue

        if not res.get("ok"):
            desc = res.get("description", "unknown error")
            print(f"  ! Telegram said: {desc}")
            # 409 Conflict = a webhook, or a second copy of this bot, is also
            # pulling updates. Clear any webhook and carry on. If it persists,
            # another bot.py is running - close the extra window.
            if "409" in desc or "webhook" in desc.lower() or "conflict" in desc.lower():
                api("deleteWebhook", {}, timeout=20)
            time.sleep(3)
            continue

        if failures:                                 # recovered
            print(T("  -> connected again"))
            failures = 0

        for update in res["result"]:
            offset = update["update_id"] + 1
            try:
                if "message" in update:
                    handle_message(update["message"])
                elif "callback_query" in update:
                    handle_callback(update["callback_query"])
            except Exception as err:                # one bad update must not stop the bot
                print(f"  ! update {update['update_id']} failed: {err}")

        if poll_seconds == 0:
            time.sleep(1.5)                          # short polling: don't hammer


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print(T("\nStopped."))
