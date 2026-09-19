"""Small PostgreSQL document store used by the Aryos data access functions."""
import json
import os
import threading

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
ENABLED = bool(DATABASE_URL)
_schema_ready = False
_schema_lock = threading.Lock()


def _driver():
    try:
        import psycopg
        return psycopg
    except ImportError as exc:
        raise RuntimeError("DATABASE_URL is set but psycopg is not installed") from exc


def _connect():
    return _driver().connect(DATABASE_URL, connect_timeout=10)


def ensure_schema():
    global _schema_ready
    if not ENABLED or _schema_ready:
        return
    with _schema_lock:
        if _schema_ready:
            return
        with _connect() as conn, conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS aryos_records (
                    collection TEXT NOT NULL,
                    record_id TEXT NOT NULL,
                    position INTEGER NOT NULL DEFAULT 0,
                    data JSONB NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (collection, record_id)
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS aryos_records_collection_position_idx ON aryos_records (collection, position)")
        _schema_ready = True


def load_list(collection):
    ensure_schema()
    with _connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT data FROM aryos_records WHERE collection=%s ORDER BY position, record_id", (collection,))
        return [row[0] for row in cur.fetchall()]


def load_dict(collection):
    ensure_schema()
    with _connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT record_id, data FROM aryos_records WHERE collection=%s", (collection,))
        return {row[0]: row[1] for row in cur.fetchall()}


def save_list(collection, rows):
    prepared = []
    for position, row in enumerate(rows):
        record_id = str(row.get("id") or row.get("key") or position)
        prepared.append((collection, record_id, position, json.dumps(row, ensure_ascii=False)))
    _replace(collection, prepared)


def save_dict(collection, records):
    prepared = []
    for position, (record_id, row) in enumerate(records.items()):
        prepared.append((collection, str(record_id), position, json.dumps(row, ensure_ascii=False)))
    _replace(collection, prepared)


def _replace(collection, prepared):
    ensure_schema()
    with _connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("aryos:" + collection,))
        cur.execute("DELETE FROM aryos_records WHERE collection=%s", (collection,))
        if prepared:
            cur.executemany("""
                INSERT INTO aryos_records (collection, record_id, position, data)
                VALUES (%s, %s, %s, %s::jsonb)
            """, prepared)


def healthcheck():
    if not ENABLED:
        return False
    ensure_schema()
    with _connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1")
        return cur.fetchone()[0] == 1
