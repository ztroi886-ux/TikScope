# Deploying Aryos Group to Railway

One service runs both the website and the Telegram bot. Follow this once and
everything is live: the public site, the job board, the visa lookup, the apply
wizard, and the bot you manage it all from.

Budget about 20 minutes.

---

## Step 1 — Create the Telegram bot

1. Open Telegram and message **@BotFather**.
2. Send `/newbot`.
3. Give it a display name, e.g. `Aryos Group`.
4. Give it a username ending in `bot`, e.g. `aryos_group_bot`.
5. BotFather replies with a token that looks like
   `8123456789:AAF1x2Yz...`. **Copy it. Treat it like a password** — anyone
   holding it controls your bot.

While you are there, two optional touches:

- `/setdescription` — what the bot is for.
- `/setcommands` — paste this so the commands appear in Telegram's menu:

```
start - Open the menu
new - Start a client file
list - Browse client files
find - Open one file by visa key
job - Add a vacancy
jobs - Browse and edit vacancies
drafts - Vacancies not yet published
applications - Applications from the website
resync - Re-download missing job photos
help - Show all commands
cancel - Stop what you are filling in
```

## Step 2 — Find your Telegram user ID

Message **@userinfobot** and send anything. It replies with your numeric ID,
e.g. `7621546358`. Only IDs you list can use the bot; everyone else is turned
away.

For several staff, collect each person's ID and separate them with commas.

## Step 3 — Put the code on GitHub

Railway deploys from a repository.

```bash
cd aryos-group-render-ready
git init
git add .
git commit -m "Aryos Group website and Telegram bot"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/aryos-group.git
git push -u origin main
```

`.gitignore` already excludes `.env`, `bot/token.txt`, all client and
application data and every uploaded photo — so none of that reaches GitHub.
Check with `git status` before you push: if you see `.env` listed, stop.

## Step 4 — Create the Railway service

1. Go to [railway.app](https://railway.app) and sign in with GitHub.
2. **New Project → Deploy from GitHub repo**, and pick your repository.
3. Railway sees the `Dockerfile` and builds from it. The first build takes a
   couple of minutes.

The build installs nothing — the project uses only the Python standard
library — so there is no dependency step that can fail.

## Step 5 — Add a volume (do this before you go live)

Without a volume, every redeploy wipes your client files, applications and
uploaded ID photos. With one, they persist.

1. In the service, open the **Variables / Settings** area and choose
   **+ New Volume**.
2. Mount path: `/data`
3. Size: 1 GB is plenty to start — that is thousands of applications.

## Step 6 — Set the variables

Service → **Variables** → add these three:

| Variable | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | the token from step 1 |
| `ADMIN_IDS` | your ID from step 2, comma-separated for several |
| `ADMIN_DASHBOARD_PASSWORD` | a unique password of at least 20 characters for `/admin` |
| `ADMIN_SESSION_SECRET` | a separate random secret of at least 32 bytes for signing sessions |
| `DATA_DIR` | `/data` — must match the volume mount path |

Do **not** set `PORT`. Railway provides it and the app reads it automatically.

Railway redeploys when you save.

## Step 7 — Turn on the public URL

Service → **Settings → Networking → Generate Domain**.

You get something like `aryos-group-production.up.railway.app`. Open it — the
website should load.

To use your own domain, add it under **Custom Domain** and create the CNAME
record Railway shows you at your registrar.

## Step 8 — Check it worked

Open the deploy logs. A healthy start looks like:

```
============================================================
  ARYOS GROUP
============================================================
  Website     : listening on port 8080
  Data store  : /data
  Vacancies   : 30 on file
  Admin IDs   : 7621546358
  Bot token   : set
============================================================
Connected as @aryos_group_bot
```

If you see the warning about `DATA_DIR` not being set, go back to steps 5 and 6.

Then walk through this list:

- [ ] The homepage loads and the job cards appear
- [ ] `https://your-url/health` returns `{"ok": true}`
- [ ] `https://your-url/jobs` returns the vacancy list as JSON
- [ ] Telegram: send `/start` to your bot — the control panel appears
- [ ] Bot: `/jobs` lists the 30 seeded vacancies
- [ ] Website: press **Apply Now**, accept the terms, complete the wizard
- [ ] Telegram: the application arrives with all three photos
- [ ] Tap **Create client file** — you get a visa key
- [ ] Website: enter that key on the Visa Status page and see the status

---

## Things that will bite you

**Keep replicas at 1.** Telegram allows only one connection polling for
updates. A second replica causes a `409 Conflict` loop and the bot stops
responding. `railway.json` sets `numReplicas: 1` — leave it.

**The bot and the website are one service.** Do not split them; the website
reads the bot's data directly off the same disk.

**A missing token no longer breaks the site.** If `TELEGRAM_BOT_TOKEN` is
absent or wrong, the website still serves and the logs explain the problem.
Fix the variable and redeploy.

**Job photos after a redeploy.** With a volume they persist. If you ever
migrate and images go missing, send `/resync` to the bot — each vacancy also
stores its Telegram `file_id`, so photos can be pulled back from Telegram.
Applicant photos cannot be recovered this way, which is another reason the
volume matters.

**Seeding.** On first run `jobs.json` is created from `bot/jobs.seed.json`
(30 sample vacancies across 15 countries) so the site is not empty. Edit or
delete them from Telegram once your real vacancies are in.

---

## Running it locally

```bash
cp .env.example .env        # then paste your real token into .env
python app.py
```

Open `http://127.0.0.1:10000`. Leave `DATA_DIR` commented out locally and the
data stays in the project folder.

Opening `index.html` directly by double-clicking will **not** work properly —
the job list and apply wizard need the server running.

---

## Updating the site later

```bash
git add .
git commit -m "what changed"
git push
```

Railway rebuilds and redeploys automatically. Your volume is untouched, so no
data is lost.
