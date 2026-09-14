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

**Before that workflow's first real deploy, do this once:**

1. Open the Cloudflare dashboard → Workers & Pages → `blackwire-admin` →
   Settings → Variables, and copy the current values of `SERVICE_ALLOWLIST`,
   `NAME_EXCLUDE`, and `CLUSTERS` into a `[vars]` block in `wrangler.toml`
   (alongside `BASE_PATH`, which is already there). These three weren't
   available to copy automatically during the migration — `wrangler deploy`
   treats `wrangler.toml` as the full source of truth for vars, so
   deploying without them would blank them out on the live Worker.
2. Same Settings page → Triggers → Cron Triggers: confirm the cron
   expression matches `wrangler.toml`'s `[triggers]` block (currently a
   placeholder of "every minute" — not a confirmed value).
3. Settings → Domains & Routes: confirm the `blackwiregaming.com/admin*`
   route is still there (this migration doesn't touch it).
4. Add two **GitHub Actions repo secrets** (Settings → Secrets and
   variables → Actions, on the `blackwire-gaming` repo):
   - `CLOUDFLARE_API_TOKEN` — an API token scoped to Workers edit for
     this account (Cloudflare dashboard → My Profile → API Tokens →
     Create Token → "Edit Cloudflare Workers" template).
   - `CLOUDFLARE_ACCOUNT_ID` — found on the right-hand side of the
     Workers & Pages overview page in the dashboard.

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
