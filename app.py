"""
Aryos Group — single-process web + Telegram bot server.

Run locally:
  TELEGRAM_BOT_TOKEN=... ADMIN_IDS=123456789 python app.py
Windows PowerShell:
  $env:TELEGRAM_BOT_TOKEN="..."; $env:ADMIN_IDS="123456789"; py -3 app.py

Hosted deployments:
  Set TELEGRAM_BOT_TOKEN and ADMIN_IDS as environment variables.
  The app listens on PORT (default 8787) and serves both the website and
  /status. No Cloudflare tunnel, webhook, or separate frontend server is used.
"""
import os
import posixpath
import re
import threading

# Load the local .env file without requiring third-party packages.
ROOT_FOR_ENV = os.path.dirname(os.path.abspath(__file__))
ENV_FOR_APP = os.path.join(ROOT_FOR_ENV, ".env")
if os.path.exists(ENV_FOR_APP):
    with open(ENV_FOR_APP, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("\"", "'"):
                value = value[1:-1]
            os.environ.setdefault(key, value)

os.environ["DISABLE_STATUS_SERVER"] = "1"
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import bot.bot as telegram_bot
import admin_dashboard

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "10000"))

# Python's mimetypes table predates woff2 on some platforms, and the wrong
# Content-Type makes browsers refuse the font.
import mimetypes
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/avif", ".avif")

class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _send(self, code, body):
        # The bot's StatusHandler methods run with an AppHandler as self, so
        # /status, /jobs and /apply all reply through here. /jobs is fetched on
        # every page view and is mostly repeated JSON keys, which means it
        # gzips to roughly a fifth of its size.
        import json
        raw = json.dumps(body).encode("utf-8")
        encoding = None
        if len(raw) > 512 and "gzip" in (self.headers.get("Accept-Encoding") or "").lower():
            import gzip as _gzip
            packed = _gzip.compress(raw, 6)
            if len(packed) < len(raw):
                raw, encoding = packed, "gzip"

        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        if encoding:
            self.send_header("Content-Encoding", encoding)
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    # API routes are matched on the exact path, never a prefix: "/jobs" is the
    # vacancies endpoint, but "/jobs.html" is a page and must fall through to
    # the static file server.
    API_PATHS = ("/status", "/jobs", "/reviews", "/hero", "/apply", "/review", "/health")

    def _api_path(self):
        from urllib.parse import urlparse
        path = urlparse(self.path).path
        return path if path in self.API_PATHS else None

    # ---------------------------------------------------------------- security
    #
    # The static handler would otherwise serve the entire project directory —
    # including .env, the bot source, and (without a volume) clients.json and
    # applications.json. Nothing is public unless it is named here.

    PUBLIC_FILES = {
        "/", "/index.html", "/jobs.html", "/visa.html", "/employers.html",
        "/contact.html", "/terms.html", "/404.html",
        "/style.css", "/script.js",
        "/admin", "/admin.html", "/admin.css", "/admin.js",
        "/favicon.ico", "/robots.txt", "/sitemap.xml",
    }
    MEDIA_TYPES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg",
                   ".ico", ".mp4", ".webm", ".txt", ".woff2"}

    # Under media/, but never served over HTTP. See _is_public below.
    PRIVATE_MEDIA = "/media/applications/"

    def _is_public(self):
        from urllib.parse import urlparse, unquote
        path = unquote(urlparse(self.path).path)

        # Normalise first, so /media/../app.py cannot masquerade as media.
        path = posixpath.normpath(path)
        if not path.startswith("/") or ".." in path.split("/"):
            return False

        if path in self.PUBLIC_FILES:
            return True

        # Applicant selfies and identity documents. They are written under
        # media/ only so the bot can read them off disk and upload the bytes to
        # Telegram; no page, script or template ever links to one. Left to the
        # rule below they would be served to anyone who asked, and the names
        # are not secrets -- ids run APP-0001, APP-0002, ... and each file is
        # "{id}-{slot}.jpg", so a single loop would harvest every candidate's
        # national ID. This check must stay above the /media/ allow.
        #
        # Case-folded because Windows and macOS resolve /media/Applications/ to
        # the same directory: a case-sensitive test passes the request straight
        # through to a filesystem that then serves the file.
        if path.lower().startswith(self.PRIVATE_MEDIA):
            return False

        if path.startswith("/media/"):
            return os.path.splitext(path)[1].lower() in self.MEDIA_TYPES

        # Translation files. Only .json, and only directly inside /lang/, so
        # this cannot be walked into anything else.
        if path.startswith("/lang/"):
            rest = path[len("/lang/"):]
            return "/" not in rest and rest.endswith(".json")

        return False

    def translate_path(self, path):
        """Serve uploaded images from the volume, everything else from the repo.

        Job and applicant photographs are written to DATA_DIR when a volume is
        mounted, so a request for /media/jobs/ARY-1042.jpg has to be answered
        from there. Images that ship with the code (the founder portrait, the
        KYC examples, the hero poster) still live in the repo, so we fall back
        to it whenever the volume has no such file.
        """
        if telegram_bot.USING_VOLUME:
            from urllib.parse import urlparse, unquote
            clean = unquote(urlparse(path).path)
            if clean.startswith("/media/"):
                rel = clean[len("/media/"):].lstrip("/")
                # Refuse anything trying to climb out of the media directory.
                candidate = os.path.normpath(
                    os.path.join(telegram_bot.MEDIA_ROOT, rel))
                if candidate.startswith(os.path.normpath(telegram_bot.MEDIA_ROOT)):
                    if os.path.exists(candidate):
                        return candidate
        return super().translate_path(path)

    # ---------------------------------------------------------------- delivery
    #
    # Most candidates open this site on a phone, often on mobile data, so how
    # many bytes leave the server matters more than anything else on the page.
    # SimpleHTTPRequestHandler ships files raw: style.css alone was 124 KB on
    # the wire, and it gzips to 23 KB.

    COMPRESSIBLE = (
        ".css", ".js", ".html", ".htm", ".json", ".svg", ".txt", ".xml", ".webmanifest",
    )
    # Photographs and video are already compressed — gzipping them burns CPU
    # for nothing and can even make them larger.
    IMMUTABLE = (
        ".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".mp4", ".woff", ".woff2",
    )

    def _accepts_gzip(self):
        return "gzip" in (self.headers.get("Accept-Encoding") or "").lower()

    def _cache_header_for(self, ext):
        """Filenames here are not content-hashed, so anything that changes on a
        redeploy must revalidate or returning visitors would be stuck on an old
        stylesheet. `no-cache` still lets the browser keep the file — it just
        asks first, and the answer is a ~200 byte 304.

        Photographs and fonts are only ever replaced under a new name, so they
        can be held for a week and cost nothing on repeat visits."""
        # Translation files change whenever wording is corrected, so they
        # revalidate like the code does rather than sticking for a week.
        if ext in (".html", ".htm", ".css", ".js", ".json"):
            return "no-cache"
        if ext in self.IMMUTABLE:
            return "public, max-age=604800"
        return "public, max-age=86400"

    def send_error(self, code, message=None, explain=None):
        """Answer a missing page with the site's own 404, not Python's.

        The stock page is unstyled English on a white background, which on a
        site that flips to Arabic and Kurdish and carries its own header is a
        dead end. Only whole-page requests get it: an image or a fetch that
        404s still gets the plain reply, and so does a request that arrives
        while 404.html is somehow missing.
        """
        page = os.path.join(ROOT, "404.html")
        wants_html = "text/html" in (self.headers.get("Accept") or "")
        if code != 404 or not wants_html or not os.path.isfile(page):
            return super().send_error(code, message, explain)

        try:
            with open(page, "rb") as fh:
                body = fh.read()
        except OSError:
            return super().send_error(code, message, explain)

        self.send_response(404, message)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    # Pages that belong in the sitemap, with how often each is worth recrawling.
    SITEMAP = (
        ("index.html", "weekly"),
        ("jobs.html", "daily"),
        ("visa.html", "monthly"),
        ("employers.html", "monthly"),
        ("contact.html", "monthly"),
        ("terms.html", "yearly"),
    )

    def _origin(self):
        """The absolute origin this request arrived on.

        No production domain is committed anywhere — Railway, Render and a
        custom domain all serve these same files — so the canonical, Open
        Graph and sitemap URLs are resolved from the request instead of being
        hard-coded. SITE_ORIGIN overrides it when the site sits behind a proxy
        that rewrites Host.
        """
        fixed = os.environ.get("SITE_ORIGIN", "").strip().rstrip("/")
        if fixed:
            return fixed
        host = (self.headers.get("X-Forwarded-Host")
                or self.headers.get("Host") or "localhost").split(",")[0].strip()
        proto = (self.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip()
        if not proto:
            proto = "http" if host.startswith(("localhost", "127.0.0.1")) else "https"
        return f"{proto}://{host}"

    def _send_sitemap(self):
        """Built here rather than kept as a file, for the same reason: absolute
        URLs are required in a sitemap and the domain is only known per
        request."""
        origin = self._origin()
        rows = "".join(
            f"<url><loc>{origin}/{page}</loc>"
            f"<changefreq>{freq}</changefreq></url>"
            for page, freq in self.SITEMAP)
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            f"{rows}</urlset>").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/xml; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=3600")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_head(self):
        """Serve static files gzipped when the browser accepts it.

        Overriding send_head rather than do_GET keeps HEAD requests correct:
        the base class calls this for both, and it already resolved the path,
        the 404s and the directory redirects for us.
        """
        path = self.translate_path(self.path)

        # "/" resolves to a directory, and the base class would find index.html
        # inside it and stream the file untouched — placeholders and all. Since
        # "/" is the most-shared URL on the site, resolve the index here so it
        # goes through the same rewriting as every other page.
        if os.path.isdir(path):
            for candidate in ("index.html", "index.htm"):
                probe = os.path.join(path, candidate)
                if os.path.isfile(probe):
                    path = probe
                    break

        ext = os.path.splitext(path)[1].lower()

        cache = self._cache_header_for(ext)
        on_disk = os.path.isfile(path)
        # These always come through this path, gzip or not, because they carry
        # the {{ORIGIN}} placeholder that has to be filled in before they
        # leave: the pages for their canonical and Open Graph URLs, robots.txt
        # for its Sitemap line, which the spec requires to be absolute.
        templated = on_disk and (
            ext in (".html", ".htm")
            or os.path.basename(path).lower() == "robots.txt")
        packing = ext in self.COMPRESSIBLE and self._accepts_gzip() and on_disk
        if not (templated or packing):
            # Nothing to compress or rewrite — let the base class stream it,
            # but still attach the cache header on the way out.
            if cache:
                self._extra_cache = cache
            return super().send_head()

        try:
            st = os.stat(path)
            with open(path, "rb") as fh:
                raw = fh.read()
        except OSError:
            self.send_error(404, "File not found")
            return None

        # Compressing by hand means the base class never gets to run its own
        # conditional-request logic, so do it here: with `no-cache` on CSS and
        # JS every visit revalidates, and without this each one would re-send
        # the whole file instead of a 304.
        import email.utils
        last_modified = email.utils.formatdate(st.st_mtime, usegmt=True)
        ims = self.headers.get("If-Modified-Since")
        if ims:
            try:
                if email.utils.parsedate_to_datetime(ims).timestamp() >= int(st.st_mtime):
                    self.send_response(304)
                    self.send_header("Last-Modified", last_modified)
                    if cache:
                        self.send_header("Cache-Control", cache)
                    self.send_header("Vary", "Accept-Encoding")
                    self.end_headers()
                    return None
            except (TypeError, ValueError, OverflowError):
                pass  # unparseable header — just send the file

        if templated:
            raw = raw.replace(b"{{ORIGIN}}", self._origin().encode("ascii", "ignore"))

        if packing:
            import gzip as _gzip
            body = _gzip.compress(raw, 6)
            # A tiny file can come out bigger compressed than it went in.
            if len(body) >= len(raw):
                body, encoding = raw, None
            else:
                encoding = "gzip"
        else:
            body, encoding = raw, None

        import io
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(path))
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Last-Modified", last_modified)
        self.send_header("Vary", "Accept-Encoding")
        if cache:
            self.send_header("Cache-Control", cache)
        self.end_headers()
        return io.BytesIO(body)

    # Sent on every response, including the API replies the bot's handler
    # writes through this class.
    #
    # There is deliberately no script-src here. The pages carry an inline
    # <script> that sets lang and direction before first paint, inline
    # onerror handlers on the job photographs, and inline style="--stagger"
    # attributes; a script-src or style-src rule would break all three, and a
    # CSP that has to be disabled again is worth less than none. Adding one
    # properly means hashing that bootstrap script and moving the handlers
    # into script.js. frame-ancestors stands on its own and costs nothing.
    SECURITY_HEADERS = (
        # An uploaded file must never be executed as something it is not.
        ("X-Content-Type-Options", "nosniff"),
        # Keep full URLs out of third-party referer logs — a visa-status or
        # application URL should not travel with an outbound click.
        ("Referrer-Policy", "strict-origin-when-cross-origin"),
        # The apply wizard collects identity documents; it must not be
        # frameable by anyone. X-Frame-Options is the same rule for browsers
        # that predate frame-ancestors.
        ("Content-Security-Policy", "frame-ancestors 'none'"),
        ("X-Frame-Options", "DENY"),
    )

    def end_headers(self):
        cache = getattr(self, "_extra_cache", None)
        if cache:
            self.send_header("Cache-Control", cache)
            self._extra_cache = None
        for name, value in self.SECURITY_HEADERS:
            self.send_header(name, value)
        if getattr(self, "_admin_response", False):
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self'; "
                "img-src 'self' data:; connect-src 'self'; base-uri 'none'; "
                "form-action 'self'; frame-ancestors 'none'")
        super().end_headers()

    def do_GET(self):
        from urllib.parse import urlparse
        if urlparse(self.path).path.startswith("/admin"):
            self._admin_response = True
        if admin_dashboard.handle_get(self):
            return
        if urlparse(self.path).path == "/admin":
            self.send_response(302)
            self.send_header("Location", "/admin.html")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        route = self._api_path()
        if route == "/health":
            self._send(200, {"ok": True})
            return
        if route in ("/status", "/jobs", "/reviews", "/hero"):
            # Reuse the bot's endpoints: /status for a single client file,
            # /jobs for the vacancies the admin manages from Telegram.
            telegram_bot.StatusHandler.do_GET(self)
            return

        if not self._is_public():
            self.send_error(404, "Not Found")
            return

        from urllib.parse import urlparse
        if urlparse(self.path).path == "/sitemap.xml":
            self._send_sitemap()
            return

        super().do_GET()

    def do_HEAD(self):
        from urllib.parse import urlparse
        if urlparse(self.path).path == "/admin":
            self._admin_response = True
            self.send_response(302)
            self.send_header("Location", "/admin.html")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        if urlparse(self.path).path.startswith("/admin"):
            self._admin_response = True
        if self._api_path() or self._is_public():
            super().do_HEAD()
            return
        self.send_error(404, "Not Found")

    def do_POST(self):
        if admin_dashboard.handle_post(self):
            return
        # Applications submitted from the website's Apply wizard.
        if self._api_path() in ("/apply", "/review"):
            telegram_bot.StatusHandler.do_POST(self)
            return
        self._send(404, {"error": "not_found"})

    def do_OPTIONS(self):
        if self._api_path():
            telegram_bot.StatusHandler.do_OPTIONS(self)
            return
        self.send_response(204)
        self.end_headers()

    # A visa reference key is a credential — it is all /status asks for. The
    # request line carries it in the query string, and these lines go to the
    # hosting platform's log store, where they are retained and searchable.
    # Logging it there is the same mistake as logging a session token.
    _REDACT_QUERY = re.compile(r"([?&](?:key)=)[^&\s]+", re.I)

    def log_message(self, format, *args):
        line = format % args
        print("%s - %s" % (self.address_string(),
                           self._REDACT_QUERY.sub(r"\1[redacted]", line)))

def run_bot():
    """The bot runs beside the website. A crash here must never take the
    website with it, so everything is caught and reported."""
    try:
        telegram_bot.main()
    except Exception as err:                       # noqa: BLE001 - last resort
        print(f"  ! Telegram bot stopped: {err!r}")
        print("  ! The website is unaffected. Fix the cause and redeploy.")

def banner():
    admins = ", ".join(str(i) for i in sorted(telegram_bot.ADMIN_IDS)) or "NONE SET"
    store = "PostgreSQL" if telegram_bot.USING_POSTGRES else (telegram_bot.DATA_DIR if telegram_bot.USING_VOLUME else "(ephemeral — inside the app)")
    jobs = len(telegram_bot.load_jobs())

    print("=" * 60)
    print("  ARYOS GROUP")
    print("=" * 60)
    print(f"  Website     : listening on port {PORT}")
    print(f"  Data store  : {store}")
    print(f"  Vacancies   : {jobs} on file")
    print(f"  Admin IDs   : {admins}")
    print(f"  Bot token   : {'set' if telegram_bot.TOKEN else 'MISSING — bot disabled'}")
    if not telegram_bot.USING_VOLUME and not telegram_bot.USING_POSTGRES:
        print()
        print("  ! No DATA_DIR set. Client files, applications and uploaded")
        print("  ! photos will be LOST on the next redeploy. Mount a volume")
        print("  ! and set DATA_DIR to its path before going live.")
    elif telegram_bot.USING_POSTGRES and not telegram_bot.USING_VOLUME:
        print()
        print("  ! Records are safe in PostgreSQL, but uploaded photos are local.")
        print("  ! Set DATA_DIR to persistent storage before accepting uploads.")
    print("=" * 60)


if __name__ == "__main__":
    banner()

    threading.Thread(target=run_bot, name="telegram-bot", daemon=True).start()

    server = ThreadingHTTPServer(("0.0.0.0", PORT), AppHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
