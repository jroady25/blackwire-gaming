# BlackWire Server Control

A Cloudflare Worker admin panel for starting, stopping, and restarting the
BlackWire Nitrado gameservers (ARK, Palworld, ...), without needing a
droplet or any server to patch. Live at `blackwiregaming.com/admin`.

## Layout

- `src/worker.js` — the Worker entry point: routes `/api/*`, `/auth/discord*`,
  and serves everything else as a static asset from `public/`.
- `src/nitrado.js` — talks to the Nitrado API (list services, read live
  status, start/stop/restart).
- `src/auth.js` — signed-cookie sessions, password login, Discord OAuth
  login, login rate-limiting.
- `src/schedule.js` — KV-backed delayed actions ("restart in 15 min") and
  the audit log.
- `public/` — the static dashboard (`index.html`, `styles.css`, `app.js`).
  No build step, no framework.

## Moved here from a standalone Cloudflare deploy

This panel originally lived only in Cloudflare (pushed via `wrangler deploy`
directly, not from a git repo). It's been moved into the `blackwiregaming`
site repo, under `admin/`, so future changes are pushed through normal git +
review instead of a one-off local deploy — see
`.github/workflows/deploy-admin.yml`.

**One-time migration steps — status:**

1. ~~Copy `SERVICE_ALLOWLIST`, `NAME_EXCLUDE`, and `CLUSTERS` from the
   Cloudflare dashboard into `wrangler.toml`'s `[vars]` block.~~ **Done** —
   copied from the live Worker's Settings → Variables and committed
   alongside `BASE_PATH`.
2. ~~Confirm the cron expression in `wrangler.toml`'s `[triggers]` block
   matches the live Worker's Settings → Triggers → Cron Triggers.~~
   **Done** — confirmed as every minute, matching `crons = ["* * * * *"]`.
3. ~~Confirm the `blackwiregaming.com/admin*` route is still bound to the
   Worker (Settings → Domains & Routes).~~ **Done** — confirmed still
   bound; this migration doesn't touch routes either way.
4. **Still needed** — add two GitHub Actions repo secrets (Settings →
   Secrets and variables → Actions, on the `blackwire-gaming` repo):
   - `CLOUDFLARE_API_TOKEN` — an API token scoped to Workers edit for
     this account (Cloudflare dashboard → My Profile → API Tokens →
     Create Token → "Edit Cloudflare Workers" template).
   - `CLOUDFLARE_ACCOUNT_ID` — found on the right-hand side of the
     Workers & Pages overview page in the dashboard.

   These two need to be entered directly in GitHub's Settings UI by
   someone with access to both the Cloudflare account and this repo —
   they can't be added through this migration.

Everything else — `NITRADO_TOKEN`, `SESSION_SECRET`, `ADMIN_PASSWORD`,
`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_GUILD_ID`,
`DISCORD_ADMIN_ROLE_IDS`, `NITRADO_BASE_URL` — are Worker **secrets**
(`wrangler secret put ...`), not plain vars. They already live in
Cloudflare, aren't stored in this repo, and a normal `wrangler deploy`
doesn't touch them, so there's nothing to do for those.

The deploy workflow triggers on `workflow_dispatch` (manual) only, not on
every push, until the steps above are done once. After that, flip it to
`on: push` (see the comment in the workflow file) if you want pushes to
`admin/**` to deploy automatically.

## Local development

```
npm install
npx wrangler dev
```

Discord login and Nitrado calls need the relevant secrets set locally too
(`wrangler secret put NITRADO_TOKEN`, etc., or a `.dev.vars` file — see
[Wrangler's docs on secrets](https://developers.cloudflare.com/workers/configuration/secrets/)).
