# BlackWire Gaming — website + live server status

This folder is the whole site: the pages, the styling, and a small script
that polls your ARK and Palworld servers every 5 minutes and updates the
"who's online right now" data automatically. Nothing here needs a droplet
or a server you have to maintain — GitHub runs the poller for you, on a
schedule, for free.

You don't need to know git or the command line for any of this. Everything
below is drag-and-drop through GitHub's website.

This README assumes your domain is **blackwiregaming.com**, registered
through Cloudflare — the steps at the end are written for that setup
specifically.

---

## What you're about to do, in plain terms

1. Create a free GitHub account (skip if you have one).
2. Create a new repository and upload this folder's contents into it.
3. Add four secret values (your Nitrado token and server passwords) into
   GitHub's Secrets page — never into any file.
4. Turn on GitHub Pages for the repo. Your site is now live at a
   `github.io` address.
5. Point blackwiregaming.com at it, using Cloudflare's DNS settings.

Total time: maybe 20 minutes, most of it waiting for DNS to propagate.

---

## 1. Create a GitHub account

Go to [github.com](https://github.com) and sign up if you don't already
have an account. Free tier is all you need.

## 2. Create the repository

- Click the **+** in the top right → **New repository**.
- Name it whatever you like — `blackwire-gaming` is a reasonable choice.
- Set it to **Public**. (It needs to be public for free GitHub Pages
  hosting. Nothing secret lives in this repo — see the security note
  below if you want the details on why that's safe.)
- Don't check any of the "initialize with README" boxes — leave it empty.
- Click **Create repository**.

## 3. Upload the files

On the empty repo's page, click **uploading an existing file**.

Drag the *contents* of this folder in — not the folder itself, but
everything inside it (`index.html`, `guides.html`, `shared.css`, the
`backend` folder, the `.github` folder, all of it). GitHub's upload box
accepts whole folder structures dropped in at once, and preserves them.

**Important:** make sure `.github` and `backend` come through as actual
folders in the repo (GitHub will show them as folders in the file list
after upload). If your browser hides dot-folders from the drag-and-drop,
you can instead upload everything except `.github/workflows/poll-servers.yml`
first, then navigate into "Add file → Create new file" and type the path
`.github/workflows/poll-servers.yml` to create it, pasting in that file's
contents.

Scroll down, add a commit message like "Initial upload," and click
**Commit changes**.

## 4. Add your secrets

Go to the repo's **Settings** tab → **Secrets and variables** → **Actions**
→ **New repository secret**. Add these four, one at a time:

| Secret name | Value |
|---|---|
| `NITRADO_TOKEN` | Your Nitrado API token |
| `ARK_RCON_PASSWORD` | Your ARK cluster's shared RCON password |
| `PALWORLD_1_PASSWORD` | The admin password for Palworld Server 1 |
| `PALWORLD_2_PASSWORD` | The admin password for Palworld Server 2 |

These never appear in any file in the repo — GitHub stores them encrypted
and only decrypts them inside the automated job that runs the poller, for
the few seconds it's running.

## 5. Turn on GitHub Pages

Repo **Settings** → **Pages** (left sidebar). Under "Build and
deployment," set **Source** to **Deploy from a branch**, branch
**main**, folder **/ (root)**. Save.

Give it a minute, then refresh that page — it'll show you a live URL like
`https://yourusername.github.io/blackwire-gaming/`. Open it and confirm
the site loads.

## 6. Run the poller once, manually, to check it works

Repo → **Actions** tab → click **Poll BlackWire servers** in the left
list → **Run workflow** button → **Run workflow** (confirm). Wait about
30–60 seconds, then refresh — you should see a green checkmark. Click into
the run if you want to see exactly what it did.

If it goes red instead, click in to see which step failed — it's almost
always a typo in one of the four secrets. Fix the secret and re-run.

Once that run succeeds, reload your `github.io` site — the live server
counts and player names should now be showing real data instead of the
static placeholder numbers.

From here it re-runs automatically every 5 minutes, forever, with no
further action from you.

## 7. Point blackwiregaming.com at your new site

Your domain is already registered through Cloudflare, so this is done
from the same dashboard where you saw the domain settings screen:

- In Cloudflare, go to **DNS** → **Records** for blackwiregaming.com.
- Add two records:
  - Type **A**, name **@**, value `185.199.108.153` (GitHub Pages' IP —
    add three more A records the same way for `185.199.109.153`,
    `185.199.110.153`, and `185.199.111.153`, so there are four total).
  - Type **CNAME**, name **www**, value `yourusername.github.io`.
- Set the **Proxy status** toggle to **DNS only** (grey cloud, not
  orange) on all of these, at least at first — GitHub Pages needs to
  issue its own SSL certificate for your domain, and Cloudflare's proxy
  can interfere with that step until it's done.
- Back in GitHub: repo **Settings** → **Pages** → under "Custom domain,"
  type `blackwiregaming.com` and save. Check **Enforce HTTPS** once
  GitHub shows the certificate as ready (can take up to a few hours,
  usually much faster).
- Add a file named `CNAME` (no extension) to the root of your repo
  containing just `blackwiregaming.com` — GitHub's Pages settings screen
  usually creates this for you automatically when you save the custom
  domain above, but it's worth checking it exists.

Once HTTPS shows as enforced, you can switch the Cloudflare proxy back to
**Proxied** (orange cloud) if you want Cloudflare's CDN/DDoS protection in
front of the site — optional, not required for it to work.

---

## Why this is safe (the short version)

- The repo being public only exposes server **IPs and ports** — the same
  kind of information anyone sees when they connect to your server in-game.
  It contains zero passwords or tokens in any committed file.
- `backend/config.template.json` has all your server info but no
  credentials at all.
- `backend/build_config.py` builds the real config at run time,
  reading credentials only from the GitHub Secrets you added in step 4 —
  those secrets are encrypted at rest and only decrypted inside that one
  automated job.
- The automated job deletes its generated `config.json` (the one with
  real passwords in it) immediately after the poller runs, whether the
  poller succeeded or failed.
- `live-data.js` (what runs in every visitor's browser) only ever reads
  the already-public `status.json` output — player counts and names, the
  same info visible to anyone playing on the server. It never has access
  to your token or passwords.

## If you ever add or change a server

Edit `backend/config.template.json` directly in GitHub (click the file,
pencil/edit icon, make the change, commit) — no need to re-upload
anything. If it's a new Palworld server, you'll also want to add a new
secret for its password and one more line in `backend/build_config.py`'s
`palworld_password_env` dictionary mapping its service ID to that secret's
name.
