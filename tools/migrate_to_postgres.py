"""Import the current Aryos JSON records into DATABASE_URL exactly once."""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

env_path = os.path.join(ROOT, ".env")
if os.path.exists(env_path):
    with open(env_path, "r", encoding="utf-8") as env_file:
        for raw in env_file:
            line = raw.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip("\"'"))

from bot import postgres_store


def read_json(path, fallback):
    if not os.path.exists(path):
        return fallback
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def main():
    if not postgres_store.ENABLED:
        raise SystemExit("Set DATABASE_URL before running this importer.")
    bot_dir = os.path.join(ROOT, "bot")
    sources = {
        "jobs": ("jobs.json", []),
        "applications": ("applications.json", []),
        "reviews": ("reviews.json", []),
        "hero": ("hero.json", []),
    }
    for collection, (filename, fallback) in sources.items():
        rows = read_json(os.path.join(bot_dir, filename), fallback)
        postgres_store.save_list(collection, rows)
        print(f"Imported {len(rows)} {collection}")
    clients = read_json(os.path.join(bot_dir, "clients.json"), {})
    postgres_store.save_dict("clients", clients)
    print(f"Imported {len(clients)} clients")
    print("PostgreSQL migration complete.")


if __name__ == "__main__":
    main()
