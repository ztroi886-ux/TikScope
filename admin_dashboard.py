"""Secure, dependency-free administration dashboard for Aryos Group."""
import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, urlparse

import bot.bot as store

COOKIE = "aryos_admin"
SESSION_TTL = 8 * 60 * 60
MAX_BODY = 15 * 1024 * 1024
_login_hits = {}
_login_lock = threading.Lock()


def configured():
    return bool(os.environ.get("ADMIN_DASHBOARD_PASSWORD", "").strip())


def _key():
    explicit = os.environ.get("ADMIN_SESSION_SECRET", "").encode("utf-8")
    if explicit:
        return hashlib.sha256(explicit).digest()
    password = os.environ.get("ADMIN_DASHBOARD_PASSWORD", "").encode("utf-8")
    return hashlib.sha256(b"aryos-admin-session-v1\0" + password).digest()


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def new_session():
    payload = {
        "exp": int(time.time()) + SESSION_TTL,
        "csrf": secrets.token_urlsafe(24),
        "nonce": secrets.token_urlsafe(16),
    }
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    body = _b64(raw)
    sig = _b64(hmac.new(_key(), body.encode("ascii"), hashlib.sha256).digest())
    return body + "." + sig, payload


def session(handler):
    try:
        jar = SimpleCookie(handler.headers.get("Cookie") or "")
        token = jar[COOKIE].value
        body, supplied = token.split(".", 1)
        expected = _b64(hmac.new(_key(), body.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(supplied, expected):
            return None
        payload = json.loads(_unb64(body).decode("utf-8"))
        if int(payload.get("exp", 0)) <= int(time.time()):
            return None
        return payload
    except (KeyError, ValueError, TypeError, json.JSONDecodeError):
        return None


def _json(handler, code, body, cookie=None):
    raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(raw)))
    if cookie:
        handler.send_header("Set-Cookie", cookie)
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(raw)


def _read_json(handler):
    try:
        length = int(handler.headers.get("Content-Length") or 0)
    except ValueError:
        length = 0
    if length <= 0 or length > MAX_BODY:
        raise ValueError("invalid request size")
    try:
        body = json.loads(handler.rfile.read(length).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("invalid JSON")
    if not isinstance(body, dict):
        raise ValueError("JSON object required")
    return body


def _remote_ip(handler):
    return handler.client_address[0]


def _login_limited(ip):
    now = time.time()
    with _login_lock:
        hits = [x for x in _login_hits.get(ip, []) if now - x < 15 * 60]
        if len(hits) >= 8:
            _login_hits[ip] = hits
            return True
        hits.append(now)
        _login_hits[ip] = hits
        return False


def _clear_login_hits(ip):
    with _login_lock:
        _login_hits.pop(ip, None)


def _cookie(handler, token):
    forwarded = (handler.headers.get("X-Forwarded-Proto") or "").split(",")[0]
    secure = forwarded == "https"
    bits = [f"{COOKIE}={token}", "Path=/", f"Max-Age={SESSION_TTL}",
            "HttpOnly", "SameSite=Strict"]
    if secure:
        bits.append("Secure")
    return "; ".join(bits)


def _expired_cookie():
    return f"{COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"


def _require(handler, csrf=False):
    auth = session(handler)
    if not auth:
        _json(handler, 401, {"ok": False, "error": "unauthorized"})
        return None
    if csrf:
        supplied = handler.headers.get("X-CSRF-Token") or ""
        if not hmac.compare_digest(str(auth.get("csrf", "")), supplied):
            _json(handler, 403, {"ok": False, "error": "csrf"})
            return None
    return auth


def _summary():
    jobs = store.load_jobs()
    apps = store.load_apps()
    reviews = store.load_reviews()
    heroes = store.load_hero()
    clients = store.load_db()
    return {
        "jobs": len(jobs),
        "liveJobs": sum(bool(x.get("published")) for x in jobs),
        "applications": len(apps),
        "pendingApplications": sum(not x.get("converted") for x in apps),
        "reviews": len(reviews),
        "pendingReviews": sum(not x.get("published") for x in reviews),
        "images": len(heroes),
        "liveImages": sum(x.get("published", True) for x in heroes),
        "clients": len(clients),
        "approvedClients": sum(x.get("status") in ("approved", "issued") for x in clients.values()),
    }


def _diagnostics():
    return {
        "storagePersistent": bool(store.USING_VOLUME or store.USING_POSTGRES),
        "database": "PostgreSQL" if store.USING_POSTGRES else "JSON",
        "dataDirectory": "PostgreSQL" if store.USING_POSTGRES else (store.DATA_DIR or "ephemeral/local"),
        "mediaPersistent": bool(store.USING_VOLUME),
        "telegramConfigured": bool(store.TOKEN),
        "adminCount": len(store.ADMIN_IDS),
        "sessionHours": SESSION_TTL // 3600,
        "maxUploadMb": 10,
        "serverTime": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
    }


def _backup_payload():
    return {"created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "jobs": store.load_jobs(), "applications": store.load_apps(),
            "clients": store.load_db(), "reviews": store.load_reviews(),
            "hero": store.load_hero()}


def _job_payload(row):
    keep = ("id", "title", "country", "city", "region", "category", "salary",
            "salaryUsd", "hours", "type", "tags", "desc", "photo",
            "photoWidths", "published", "created", "updated")
    return {key: row.get(key) for key in keep}


def _application_payload(row):
    return {
        "id": row.get("id"), "received": row.get("received"),
        "converted": bool(row.get("converted")), "jobId": row.get("jobId"),
        "jobTitle": row.get("jobTitle"), "jobCountry": row.get("jobCountry"),
        "jobCity": row.get("jobCity"), "consent": bool(row.get("consent")),
        "answers": row.get("answers") or {},
        "photoSlots": sorted((row.get("photos") or {}).keys()),
    }


def _clients_payload():
    rows = []
    for key, row in store.load_db().items():
        item = dict(row)
        item["key"] = key
        item.pop("photo", None)
        item.pop("idPhoto", None)
        rows.append(item)
    rows.sort(key=lambda x: str(x.get("updated") or x.get("created") or ""), reverse=True)
    return rows


def handle_get(handler):
    parsed = urlparse(handler.path)
    if not parsed.path.startswith("/admin/api/"):
        return False
    handler._admin_response = True
    auth = _require(handler)
    if not auth:
        return True
    resource = parsed.path.removeprefix("/admin/api/")
    if resource == "session":
        _json(handler, 200, {"ok": True, "csrf": auth["csrf"], "expires": auth["exp"]})
    elif resource == "summary":
        _json(handler, 200, {"ok": True, "data": _summary()})
    elif resource == "jobs":
        _json(handler, 200, {"ok": True, "data": [_job_payload(x) for x in store.load_jobs()]})
    elif resource == "applications":
        _json(handler, 200, {"ok": True, "data": [_application_payload(x) for x in store.load_apps()]})
    elif resource == "clients":
        _json(handler, 200, {"ok": True, "data": _clients_payload()})
    elif resource == "reviews":
        _json(handler, 200, {"ok": True, "data": store.load_reviews()})
    elif resource == "images":
        rows = sorted(store.load_hero(), key=lambda x: x.get("order", 0))
        _json(handler, 200, {"ok": True, "data": rows})
    elif resource == "diagnostics":
        _json(handler, 200, {"ok": True, "data": _diagnostics()})
    elif resource == "backup":
        _json(handler, 200, {"ok": True, "data": _backup_payload()})
    else:
        _json(handler, 404, {"ok": False, "error": "not_found"})
    return True


def _save_job(data):
    required = ("title", "country", "city", "category", "salary")
    if any(not str(data.get(k) or "").strip() for k in required):
        raise ValueError("title, country, city, category and salary are required")
    with store._lock:
        jobs = store.load_jobs()
        job_id = str(data.get("id") or "").strip().upper()
        current = store.find_job(jobs, job_id) if job_id else None
        if not current:
            job_id = store.new_job_id(jobs)
            current = {"id": job_id, "created": store.today(), "photo": "", "photoFileId": ""}
            jobs.insert(0, current)
        for key, limit in (("title", 120), ("country", 60), ("city", 80),
                           ("region", 40), ("category", 80), ("salary", 100),
                           ("hours", 100), ("type", 40), ("desc", 1200)):
            if key in data:
                current[key] = str(data.get(key) or "").strip()[:limit]
        try:
            current["salaryUsd"] = max(0, int(data.get("salaryUsd") or 0))
        except (TypeError, ValueError):
            current["salaryUsd"] = 0
        current["tags"] = [str(x).strip()[:80] for x in (data.get("tags") or []) if str(x).strip()][:8]
        current["published"] = data.get("published") is True
        current["updated"] = store.today()
        store.save_jobs(jobs)
    return _job_payload(current)


def _toggle(collection, saver, item_id, field="published"):
    with store._lock:
        rows = collection()
        row = next((x for x in rows if x.get("id") == item_id), None)
        if not row:
            return None
        row[field] = not bool(row.get(field))
        saver(rows)
        return row


def _delete_job(item_id):
    with store._lock:
        rows = store.load_jobs()
        keep = [x for x in rows if x.get("id") != item_id]
        if len(keep) == len(rows):
            return False
        store.save_jobs(keep)
        return True


def _duplicate_job(item_id):
    with store._lock:
        rows = store.load_jobs()
        source = store.find_job(rows, item_id)
        if not source:
            return None
        copy = dict(source)
        copy["id"] = store.new_job_id(rows)
        copy["title"] = str(copy.get("title") or "") + " (Copy)"
        copy["published"] = False
        copy["created"] = copy["updated"] = store.today()
        copy["photoFileId"] = ""
        rows.insert(0, copy)
        store.save_jobs(rows)
        return _job_payload(copy)


def _upload_job_photo(data):
    job_id = str(data.get("id") or "").strip().upper()
    raw, ext = _decode_image(data.get("image"))
    with store._lock:
        jobs = store.load_jobs()
        job = store.find_job(jobs, job_id)
        if not job:
            return None
        os.makedirs(store.MEDIA_DIR, exist_ok=True)
        for suffix in (".jpg", ".jpeg", ".png", ".webp"):
            stale = os.path.join(store.MEDIA_DIR, job_id + suffix)
            if os.path.exists(stale):
                try:
                    os.remove(stale)
                except OSError:
                    pass
        path = os.path.join(store.MEDIA_DIR, job_id + ext)
        with open(path + ".tmp", "wb") as fh:
            fh.write(raw)
        os.replace(path + ".tmp", path)
        store.set_job_photo(job, "jobs/" + job_id + ext)
        job["updated"] = store.today()
        store.save_jobs(jobs)
        return _job_payload(job)


def _convert_application(item_id):
    with store._lock:
        apps = store.load_apps()
        app = store.find_app(apps, item_id)
        if not app:
            return None
        if app.get("converted") and app.get("clientKey"):
            return {"key": app["clientKey"], "existing": True}
        answers = app.get("answers") or {}
        db = store.load_db()
        key = store.new_key(db)
        languages = answers.get("languages") or ""
        if isinstance(languages, list):
            languages = ", ".join(str(x) for x in languages)
        experience = str(answers.get("experience") or "")
        for caption, field in (("Skills", "skills"), ("Languages", None),
                               ("Current job", "currentJob")):
            value = languages if field is None else answers.get(field)
            if value:
                experience += f"\n{caption}: {value}"
        db[key] = {"key": key, "nameEn": str(answers.get("fullName") or "Applicant")[:120],
                   "phone": str(answers.get("phone") or "")[:40],
                   "nationality": str(answers.get("nationality") or "")[:80],
                   "age": str(answers.get("age") or "")[:10],
                   "dob": str(answers.get("dob") or "")[:20],
                   "education": str(answers.get("education") or "")[:100],
                   "experience": experience.strip()[:3000],
                   "route": str(app.get("jobCountry") or "")[:80], "status": "review",
                   "note": ("Application received for " + str(app.get("jobTitle")))[:1000],
                   "created": store.today(), "updated": store.today(),
                   "by": "dashboard", "fromApplication": item_id}
        store.save_db(db)
        app["converted"] = True
        app["clientKey"] = key
        store.save_apps(apps)
        return {"key": key, "existing": False}


def _bulk_action(data):
    kind = str(data.get("kind") or "")
    ids = {str(x) for x in (data.get("ids") or []) if str(x)}
    operation = str(data.get("operation") or "")
    if not ids or kind not in {"jobs", "applications", "reviews", "images"}:
        raise ValueError("valid records are required")
    if kind == "applications" and operation == "delete":
        changed = sum(bool(_delete_application(item_id)) for item_id in ids)
        return {"changed": changed}
    loaders = {"jobs": (store.load_jobs, store.save_jobs, "published"),
               "applications": (store.load_apps, store.save_apps, "converted"),
               "reviews": (store.load_reviews, store.save_reviews, "published"),
               "images": (store.load_hero, store.save_hero, "published")}
    loader, saver, field = loaders[kind]
    with store._lock:
        rows = loader()
        existing = [row for row in rows if str(row.get("id")) in ids]
        if operation == "delete":
            rows = [row for row in rows if str(row.get("id")) not in ids]
        elif operation in {"enable", "disable"}:
            for row in rows:
                if str(row.get("id")) in ids:
                    row[field] = operation == "enable"
        else:
            raise ValueError("invalid bulk operation")
        saver(rows)
    return {"changed": len(existing)}


def _save_client(data):
    statuses = {"review", "action", "approved", "issued"}
    with store._lock:
        db = store.load_db()
        key = str(data.get("key") or "").strip().upper()
        row = db.get(key) if key else None
        if row is None:
            key = store.new_key(db)
            row = {"key": key, "created": store.today(), "by": "dashboard"}
        name = str(data.get("nameEn") or "").strip()
        if len(name) < 2:
            raise ValueError("client name is required")
        row["nameEn"] = name[:120]
        for field, limit in (("phone", 40), ("nationality", 80), ("route", 80),
                             ("note", 1000), ("dob", 20), ("education", 100),
                             ("experience", 3000)):
            if field in data:
                row[field] = str(data.get(field) or "").strip()[:limit]
        status = str(data.get("status") or "review")
        row["status"] = status if status in statuses else "review"
        row["updated"] = store.today()
        db[key] = row
        store.save_db(db)
    item = dict(row)
    item["key"] = key
    return item


def _delete_client(key):
    with store._lock:
        db = store.load_db()
        if key not in db:
            return False
        del db[key]
        store.save_db(db)
        return True


def _decode_image(data_url):
    import re
    match = re.fullmatch(r"data:image/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)",
                         str(data_url or ""), re.I)
    if not match:
        raise ValueError("JPEG, PNG or WebP image required")
    try:
        raw = base64.b64decode(match.group(2), validate=False)
    except Exception:
        raise ValueError("invalid image")
    if not 100 <= len(raw) <= 10 * 1024 * 1024:
        raise ValueError("image must be smaller than 10 MB")
    signatures = ((b"\xff\xd8\xff", ".jpg"), (b"\x89PNG\r\n\x1a\n", ".png"),
                  (b"RIFF", ".webp"))
    ext = next((suffix for sig, suffix in signatures if raw.startswith(sig)), None)
    if ext == ".webp" and raw[8:12] != b"WEBP":
        ext = None
    if not ext:
        raise ValueError("file contents are not a supported image")
    return raw, ext


def _upload_hero(data):
    raw, ext = _decode_image(data.get("image"))
    with store._lock:
        rows = store.load_hero()
        hero_id = store.new_hero_id(rows)
        os.makedirs(store.HERO_MEDIA, exist_ok=True)
        name = hero_id + ext
        path = os.path.join(store.HERO_MEDIA, name)
        with open(path + ".tmp", "wb") as fh:
            fh.write(raw)
        os.replace(path + ".tmp", path)
        record = {"id": hero_id, "file": "hero/" + name,
                  "widths": store.hero_variants(path, hero_id),
                  "published": True, "order": len(rows), "added": store.today()}
        rows.append(record)
        store.save_hero(rows)
    return record


def _delete_application(item_id):
    with store._lock:
        rows = store.load_apps()
        row = next((x for x in rows if x.get("id") == item_id), None)
        if not row:
            return False
        store.save_apps([x for x in rows if x.get("id") != item_id])
    for rel in (row.get("photos") or {}).values():
        path = os.path.normpath(os.path.join(store.MEDIA_ROOT, rel))
        if os.path.commonpath((path, store.MEDIA_ROOT)) == os.path.normpath(store.MEDIA_ROOT):
            try:
                os.remove(path)
            except OSError:
                pass
    return True


def handle_post(handler):
    parsed = urlparse(handler.path)
    if not parsed.path.startswith("/admin/api/"):
        return False
    handler._admin_response = True
    action = parsed.path.removeprefix("/admin/api/")
    if action == "login":
        if not configured():
            _json(handler, 503, {"ok": False, "error": "dashboard_not_configured"})
            return True
        ip = _remote_ip(handler)
        if _login_limited(ip):
            _json(handler, 429, {"ok": False, "error": "too_many_attempts"})
            return True
        try:
            data = _read_json(handler)
        except ValueError as err:
            _json(handler, 400, {"ok": False, "error": str(err)})
            return True
        expected = os.environ.get("ADMIN_DASHBOARD_PASSWORD", "")
        if not hmac.compare_digest(str(data.get("password") or ""), expected):
            time.sleep(0.25)
            _json(handler, 401, {"ok": False, "error": "invalid_credentials"})
            return True
        _clear_login_hits(ip)
        token, auth = new_session()
        _json(handler, 200, {"ok": True, "csrf": auth["csrf"]}, _cookie(handler, token))
        return True
    auth = _require(handler, csrf=True)
    if not auth:
        return True
    if action == "logout":
        _json(handler, 200, {"ok": True}, _expired_cookie())
        return True
    try:
        data = _read_json(handler)
        item_id = str(data.get("id") or "").strip()
        if action == "jobs/save":
            result = _save_job(data)
        elif action == "jobs/duplicate":
            result = _duplicate_job(item_id)
        elif action == "jobs/toggle":
            result = _toggle(store.load_jobs, store.save_jobs, item_id)
        elif action == "jobs/photo":
            result = _upload_job_photo(data)
        elif action == "jobs/delete":
            result = _delete_job(item_id)
        elif action == "applications/toggle":
            result = _toggle(store.load_apps, store.save_apps, item_id, "converted")
        elif action == "applications/delete":
            result = _delete_application(item_id)
        elif action == "applications/convert":
            result = _convert_application(item_id)
        elif action == "clients/save":
            result = _save_client(data)
        elif action == "clients/delete":
            result = _delete_client(item_id)
        elif action == "reviews/toggle":
            result = store.set_review_published(item_id, not bool(data.get("published")))
        elif action == "reviews/delete":
            result = store.delete_review(item_id)
        elif action == "images/toggle":
            result = _toggle(store.load_hero, store.save_hero, item_id)
        elif action == "images/delete":
            result = store.delete_hero(item_id)
        elif action == "images/upload":
            result = _upload_hero(data)
        elif action == "images/up":
            result = store.hero_reorder(item_id, -1)
        elif action == "images/down":
            result = store.hero_reorder(item_id, 1)
        elif action == "bulk":
            result = _bulk_action(data)
        else:
            _json(handler, 404, {"ok": False, "error": "not_found"})
            return True
        if not result:
            _json(handler, 404, {"ok": False, "error": "not_found"})
        else:
            _json(handler, 200, {"ok": True, "data": result})
    except ValueError as err:
        _json(handler, 400, {"ok": False, "error": str(err)})
    except Exception as err:
        print(f"  ! admin action failed: {err}")
        _json(handler, 500, {"ok": False, "error": "server"})
    return True
