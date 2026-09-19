# Aryos Group

A recruitment website, secure admin dashboard, PostgreSQL storage, and the
Telegram bot that runs it, in one Python service.

**Deploying for the first time? Start with [DEPLOY.md](DEPLOY.md).**

## Deploying

**See [DEPLOY.md](DEPLOY.md) for the full step-by-step guide** — creating the
bot with BotFather, pushing to GitHub, and setting up Railway with a
persistent volume.

Short version. One service runs the website and the bot together:

| Setting | Value |
| --- | --- |
| Start command | `python app.py` |
| Health check | `/health` |
| Replicas | **1** (Telegram allows only one poller) |

Environment variables:

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | From @BotFather. Without it the site runs but the bot does not. |
| `ADMIN_IDS` | Telegram user IDs allowed to use the bot, comma-separated. |
| `ADMIN_DASHBOARD_PASSWORD` | A unique 20+ character password for `/admin`. Omit it to disable the dashboard. |
| `ADMIN_SESSION_SECRET` | A separate random secret used to sign dashboard sessions. |
| `DATABASE_URL` | PostgreSQL connection URL for permanent records. JSON is used when unset. |
| `DATA_DIR` | Persistent path for uploaded photos, e.g. `/data`. |

`PORT` is supplied by the host — do not set it. Never commit `.env` or a real
token; `.gitignore` already excludes them.

The `Dockerfile` installs `requirements.txt`, copies the code, and starts the
service. `railway.json` points Railway at it; `render.yaml` and `Procfile` are
there for other hosts.

## Local

You can also create a `.env` file beside `app.py`:

```env
TELEGRAM_BOT_TOKEN=your_token_here
ADMIN_IDS=7621546358
ADMIN_DASHBOARD_PASSWORD=replace_with_a_long_unique_password
ADMIN_SESSION_SECRET=replace_with_a_long_random_secret
```

Run:

```text
python app.py
```

The default local address is `http://127.0.0.1:10000`. Hosts supply their own `PORT`.

Opening `index.html` by double-clicking will not work — the job list and the
apply wizard need the server running.

## Bot

After deployment, open the bot in Telegram and send `/start`. Only IDs listed in `ADMIN_IDS` can use the staff menu.

## Managing jobs from Telegram

The admin controls every vacancy on the website from the bot — no code edits.

| Command | What it does |
| --- | --- |
| `/job` | Add a vacancy: title, country, city, category, type, salary, filter value, hours, benefits, description, photo |
| `/jobs` | Browse every vacancy and open one to edit |
| `/drafts` | Only the vacancies that are not published yet |
| `/resync` | Re-download job photos that went missing from disk |

Opening a vacancy gives you **Edit a field**, **Photo**, **Publish / Unpublish**, **Duplicate** and **Delete**. Editing a field re-asks just that one question and saves immediately. Deleting always asks for confirmation.

Publishing is what puts a job on the website. Drafts stay invisible to visitors. The site reads the live list from `/jobs`; if the bot is unreachable it falls back to the bundled sample listings so the jobs page is never empty.

Adding a country or category that the site has never seen is enough — the filter menus and the homepage region blocks rebuild themselves from the job data.

## Applications from the website

When a candidate taps **Apply Now** on a job card the site opens a step-by-step wizard and asks for:

full name · phone · age · gender · nationality · married or single · family members · education · current job · work experience · skills · languages · any arrest or conviction (with details if yes) · **selfie** · **national ID front** · **national ID back**

The selfie step shows a correct and a rejected example side by side so people photograph themselves properly the first time.

On submit the answers and photos are posted to `/apply`. The bot files them, saves the images to `media/applications/`, and messages every admin with the full application plus the three photos. Each notification carries a **Create client file** button that turns the application into a client record with a visa key in one tap — name, phone, nationality, age, education, experience, skills, languages and arrest declaration are copied across.

| Command | What it does |
| --- | --- |
| `/applications` | Browse everything received — 🆕 new, ✅ already converted |

Applications are rate limited to 5 per IP per hour. Photos are re-encoded in the browser to about 1400px before upload, and anything that is not a real JPEG, PNG or WebP is discarded server-side.

## Where the data lives

When `DATABASE_URL` is set, clients, jobs, applications, reviews and hero
metadata live in PostgreSQL. Import existing JSON data once with:

```bash
python tools/migrate_to_postgres.py
```

Uploaded image files still need a mounted volume. Set `DATA_DIR` to a persistent
path; PostgreSQL stores their metadata while the files live under:

```
$DATA_DIR/media/jobs/               job card photos
$DATA_DIR/media/applications/       applicant selfies and ID documents
$DATA_DIR/media/hero/               uploaded homepage images
```

Without `DATABASE_URL`, the original JSON storage remains available for local
development. Without `DATA_DIR`, uploaded files remain local and can be lost on
a hosted redeploy even when PostgreSQL is enabled.

Job photos survive a wipe because each vacancy also stores its Telegram
`file_id`; `/resync` pulls them back. Client records, applications and
applicant ID photos cannot be recovered. Mount the volume.

On first run `bot/jobs.json` is created from `bot/jobs.seed.json` (30 sample vacancies across 15 countries). Delete `bot/jobs.json` to reset back to those samples; edit or delete the seed file if you would rather start empty.
