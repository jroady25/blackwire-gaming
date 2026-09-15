// BlackWire Server Control — Cloudflare Worker.
//
// Serves the static dashboard (via the ASSETS binding, from ../public),
// and an API under /api/* that reads Nitrado gameserver status and issues
// start/stop/restart commands. Runs standalone at the Workers dev
// subdomain, or under /admin on blackwiregaming.com when BASE_PATH is set.

import { buildSnapshot, configure, restartServer, startServer, stopServer } from "./nitrado.js";
import {
  clearAttempts,
  createSession,
  discordAuthorizeUrl,
  discordEnabled,
  discordLogin,
  readSession,
  recordFailedAttempt,
  sessionCookie,
  timingSafeEqual,
  tooManyAttempts,
  verifySignedToken,
} from "./auth.js";
import { cancelSchedule, createSchedule, dueSchedules, listSchedules, readAudit, writeAudit } from "./schedule.js";
import { readActivity, recordPresence } from "./presence.js";
import {
  parsePlayers,
  rconConfigured,
  rconEndpoints,
  rconExec,
  sanitizeMessage,
  sanitizePlayerId,
} from "./rcon.js";

const SNAPSHOT_KEY = "status:snapshot";
const SNAPSHOT_FRESH_MS = 45000;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

const clientIp = (request) => request.headers.get("CF-Connecting-IP") || "unknown";

function csrfOk(request) {
  // A bespoke header a cross-site form post can't set, without needing a
  // separate CSRF-token round trip.
  return request.headers.get("X-BW-Request") === "1";
}

async function getSnapshot(env, { force = false } = {}) {
  const cached = await env.STORE.get(SNAPSHOT_KEY, "json");
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;
  if (cached && age < (force ? 15000 : SNAPSHOT_FRESH_MS)) return { ...cached, cached: true };

  try {
    const snapshot = await buildSnapshot(env.NITRADO_TOKEN, {
      allowlist: env.SERVICE_ALLOWLIST,
      nameExclude: env.NAME_EXCLUDE,
      clusters: env.CLUSTERS,
    });
    await env.STORE.put(SNAPSHOT_KEY, JSON.stringify(snapshot), { expirationTtl: 300 });
    return { ...snapshot, cached: false };
  } catch (err) {
    // Nitrado hiccupped — better to show a slightly stale board than none.
    if (cached) return { ...cached, cached: true, staleError: err.message };
    throw err;
  }
}

async function runAction(env, { action, serviceIds, message, actor }) {
  const results = [];
  for (const serviceId of serviceIds) {
    try {
      if (action === "restart") {
        await restartServer(env.NITRADO_TOKEN, serviceId, {
          message: `Restart by ${actor} (BlackWire admin)`,
          restartMessage: message,
        });
      } else if (action === "stop") {
        await stopServer(env.NITRADO_TOKEN, serviceId, {
          message: `Stop by ${actor} (BlackWire admin)`,
          stopMessage: message,
        });
      } else if (action === "start") {
        await startServer(env.NITRADO_TOKEN, serviceId, {
          message: `Start by ${actor} (BlackWire admin)`,
        });
      } else {
        throw new Error(`Unknown action: ${action}`);
      }
      results.push({ serviceId, ok: true });
    } catch (err) {
      results.push({ serviceId, ok: false, error: err.message });
    }
  }

  await writeAudit(env, {
    actor,
    action,
    serviceIds,
    message: message || null,
    ok: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
  });

  await env.STORE.delete(SNAPSHOT_KEY);
  return results;
}

/** ARK servers that have an RCON endpoint, named from the live snapshot. */
async function rconTargetList(env) {
  const endpoints = await rconEndpoints();
  const names = new Map();
  try {
    const snapshot = await getSnapshot(env);
    for (const server of snapshot.servers || []) names.set(String(server.serviceId), server.name);
  } catch {
    // Names are cosmetic; the config's own name is a fine fallback.
  }
  return [...endpoints.entries()]
    .map(([serviceId, endpoint]) => ({
      serviceId,
      name: names.get(serviceId) || endpoint.name || `Service ${serviceId}`,
      address: `${endpoint.host}:${endpoint.port}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * Run the same RCON commands against several servers. One unreachable
 * server reports itself and never fails the rest of the broadcast.
 */
async function runRcon(env, { serviceIds, commands, actor, action, message }) {
  const endpoints = await rconEndpoints();
  const results = new Array(serviceIds.length);
  const LIMIT = 6;

  let cursor = 0;
  async function worker() {
    while (cursor < serviceIds.length) {
      const index = cursor++;
      const serviceId = String(serviceIds[index]);
      const endpoint = endpoints.get(serviceId);
      if (!endpoint) {
        results[index] = { serviceId, ok: false, error: "No RCON endpoint configured for this server." };
        continue;
      }
      try {
        const bodies = await rconExec(endpoint, env.ARK_RCON_PASSWORD, commands);
        results[index] = { serviceId, ok: true, body: (bodies[bodies.length - 1] || "").trim() };
      } catch (err) {
        results[index] = { serviceId, ok: false, error: err.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(LIMIT, serviceIds.length) }, worker));

  await writeAudit(env, {
    actor,
    action,
    serviceIds,
    message: message || null,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  });
  return results;
}

async function handleApi(request, env, url, session) {
  const path = url.pathname;

  if (path === "/api/me") {
    return json({
      authed: Boolean(session),
      user: session?.u ?? null,
      via: session?.v ?? null,
      discordEnabled: discordEnabled(env),
      passwordEnabled: Boolean(env.ADMIN_PASSWORD),
    });
  }

  if (path === "/api/login" && request.method === "POST") {
    if (!csrfOk(request)) return json({ error: "Bad request." }, 400);
    if (!env.ADMIN_PASSWORD) return json({ error: "Password login is not enabled." }, 400);

    const ip = clientIp(request);
    if (await tooManyAttempts(env, ip)) {
      return json({ error: "Too many attempts. Wait a few minutes." }, 429);
    }

    const body = await request.json().catch(() => ({}));
    if (!timingSafeEqual(body.password || "", env.ADMIN_PASSWORD)) {
      await recordFailedAttempt(env, ip);
      return json({ error: "Wrong password." }, 401);
    }

    await clearAttempts(env, ip);
    const name = (body.name || "").trim().slice(0, 32) || "admin";
    const cookie = sessionCookie(await createSession(env, { name, via: "password" }));
    await writeAudit(env, { actor: name, action: "login", serviceIds: [] });
    return json({ ok: true, user: name }, 200, { "Set-Cookie": cookie });
  }

  if (path === "/api/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", { clear: true }) });
  }

  if (!session) return json({ error: "Not signed in." }, 401);

  if (path === "/api/rcon/targets") {
    return json({ configured: rconConfigured(env), targets: await rconTargetList(env) });
  }

  if (path === "/api/rcon/players") {
    if (!rconConfigured(env)) return json({ error: "ARK_RCON_PASSWORD is not set on the Worker." }, 400);
    const serviceId = String(url.searchParams.get("serviceId") || "");
    const endpoint = (await rconEndpoints()).get(serviceId);
    if (!endpoint) return json({ error: "No RCON endpoint configured for that server." }, 404);
    try {
      const [body] = await rconExec(endpoint, env.ARK_RCON_PASSWORD, ["listplayers"]);
      return json({ serviceId, players: parsePlayers(body) });
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  }

  if (path === "/api/rcon/say" && request.method === "POST") {
    if (!csrfOk(request)) return json({ error: "Bad request." }, 400);
    if (!rconConfigured(env)) return json({ error: "ARK_RCON_PASSWORD is not set on the Worker." }, 400);
    const body = await request.json().catch(() => ({}));
    const message = sanitizeMessage(body.message);
    if (!message) return json({ error: "Nothing to send." }, 400);
    const serviceIds = (body.serviceIds || []).map(String).filter(Boolean);
    if (!serviceIds.length) return json({ error: "Pick at least one server." }, 400);

    // Broadcast puts it center-screen; ServerChat drops it in chat.
    const center = body.mode === "center";
    const results = await runRcon(env, {
      serviceIds,
      commands: [`${center ? "Broadcast" : "ServerChat"} ${message}`],
      actor: session.u,
      action: center ? "broadcast" : "serverchat",
      message,
    });
    return json({ results, message, mode: center ? "center" : "chat" });
  }

  if (path === "/api/rcon/kick" && request.method === "POST") {
    if (!csrfOk(request)) return json({ error: "Bad request." }, 400);
    if (!rconConfigured(env)) return json({ error: "ARK_RCON_PASSWORD is not set on the Worker." }, 400);
    const body = await request.json().catch(() => ({}));
    const serviceId = String(body.serviceId || "");
    const playerId = sanitizePlayerId(body.playerId);
    if (!serviceId || !playerId) return json({ error: "Need a server and a player id." }, 400);

    const results = await runRcon(env, {
      serviceIds: [serviceId],
      commands: [`KickPlayer ${playerId}`],
      actor: session.u,
      action: "kick",
      message: `${body.playerName || playerId} (${playerId})`,
    });
    return json({ result: results[0] });
  }

  if (path === "/api/activity") {
    return json(await readActivity(env));
  }

  if (path === "/api/servers") {
    try {
      const snapshot = await getSnapshot(env, { force: url.searchParams.get("force") === "1" });
      const schedules = await listSchedules(env);
      return json({ ...snapshot, schedules, now: Date.now() });
    } catch (err) {
      return json({ error: err.message }, err.status || 502);
    }
  }

  if (path === "/api/action" && request.method === "POST") {
    if (!csrfOk(request)) return json({ error: "Bad request." }, 400);
    const body = await request.json().catch(() => ({}));
    const serviceIds = (body.serviceIds || []).map(Number).filter(Boolean);
    const action = body.action;
    if (!serviceIds.length) return json({ error: "No servers selected." }, 400);
    if (!["start", "stop", "restart"].includes(action)) return json({ error: "Unknown action." }, 400);

    if (Number(body.delayMinutes) > 0) {
      const job = await createSchedule(env, {
        action,
        serviceIds,
        names: body.names || [],
        message: body.message,
        delayMinutes: body.delayMinutes,
        createdBy: session.u,
      });
      await writeAudit(env, {
        actor: session.u,
        action: `schedule:${action}`,
        serviceIds,
        message: body.message || null,
        fireAt: job.fireAt,
      });
      return json({ ok: true, scheduled: job });
    }

    const results = await runAction(env, { action, serviceIds, message: body.message, actor: session.u });
    return json({ ok: true, results });
  }

  if (path.startsWith("/api/schedules/") && request.method === "DELETE") {
    if (!csrfOk(request)) return json({ error: "Bad request." }, 400);
    const id = path.split("/").pop();
    const cancelled = await cancelSchedule(env, id);
    if (!cancelled) return json({ error: "That job already ran or was cancelled." }, 404);
    await writeAudit(env, { actor: session.u, action: `cancel:${cancelled.action}`, serviceIds: cancelled.serviceIds });
    return json({ ok: true });
  }

  if (path === "/api/audit") {
    return json({ entries: await readAudit(env, 60) });
  }

  return json({ error: "Not found." }, 404);
}

async function handleDiscord(request, env, url, path, base) {
  if (!discordEnabled(env)) return json({ error: "Discord login is not configured." }, 400);
  const origin = `${url.origin}${base}`;

  if (path === "/auth/discord") {
    return Response.redirect(await discordAuthorizeUrl(env, origin), 302);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stateOk = await verifySignedToken(env, state);
  if (!code || !stateOk || stateOk.v !== "state") {
    return Response.redirect(`${origin}/?error=${encodeURIComponent("Login session expired, try again.")}`, 302);
  }

  try {
    const user = await discordLogin(env, code, origin);
    const cookie = sessionCookie(await createSession(env, user));
    await writeAudit(env, { actor: user.name, action: "login:discord", serviceIds: [] });
    return new Response(null, { status: 302, headers: { Location: `${origin}/`, "Set-Cookie": cookie } });
  } catch (err) {
    return Response.redirect(`${origin}/?error=${encodeURIComponent(err.message)}`, 302);
  }
}


/**
 * The public site's own status poller (poll-servers.yml, a separate
 * GitHub Actions workflow that polls Nitrado + RCON and commits
 * status.json for live-data.js to read) relies on GitHub Actions'
 * schedule: trigger to run every 5 minutes -- but GitHub's own schedule
 * dispatcher is best-effort and, in practice on this repo, has been
 * dropping the vast majority of those firings (see that workflow's
 * comment). This Worker's own cron trigger has proven reliable, so it
 * dispatches that workflow directly over the GitHub API instead of
 * waiting on GitHub's internal scheduler. Requires a GH_DISPATCH_TOKEN
 * Worker secret (a GitHub token scoped only to Actions:write on this
 * repo) -- silently does nothing until that's set, so this is safe to
 * ship before the secret exists.
 */
async function dispatchStatusPoll(env) {
  if (!env.GH_DISPATCH_TOKEN) return;
  try {
    const resp = await fetch(
      "https://api.github.com/repos/jroady25/blackwire-gaming/actions/workflows/poll-servers.yml/dispatches",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "blackwire-admin-worker",
        },
        body: JSON.stringify({ ref: "main" }),
      },
    );
    if (!resp.ok) {
      console.log(`GitHub dispatch failed: ${resp.status} ${await resp.text()}`);
    }
  } catch (err) {
    console.log(`GitHub dispatch error: ${err.message}`);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    configure(env.NITRADO_BASE_URL);

    if (!env.SESSION_SECRET) {
      return json({ error: "SESSION_SECRET is not set. See the README." }, 500);
    }

    // Serve both at the Workers dev root and under a mounted BASE_PATH
    // (e.g. /admin on blackwiregaming.com) from the same build.
    const configured = (env.BASE_PATH || "").replace(/\/+$/, "");
    const underBase = configured && (url.pathname === configured || url.pathname.startsWith(`${configured}/`));
    const base = underBase ? configured : "";
    const path = underBase ? url.pathname.slice(base.length) || "/" : url.pathname;

    if (configured && url.pathname === configured) {
      return Response.redirect(`${url.origin}${configured}/${url.search}`, 301);
    }

    if (path.startsWith("/auth/discord")) {
      return handleDiscord(request, env, url, path, base);
    }

    if (path.startsWith("/api/")) {
      const session = await readSession(env, request);
      return handleApi(request, env, new URL(`${url.origin}${path}${url.search}`), session);
    }

    const assetUrl = new URL(`${url.origin}${path}${url.search}`);
    const asset = await env.ASSETS.fetch(new Request(assetUrl, request));

    // If a static asset 3xx-redirects (e.g. trailing-slash normalization),
    // rewrite the Location back under BASE_PATH so the browser doesn't jump
    // out from under /admin.
    if (base && asset.status >= 300 && asset.status < 400) {
      const location = asset.headers.get("Location");
      if (location) {
        const target = new URL(location, url);
        if (target.origin === url.origin && !target.pathname.startsWith(base)) {
          const headers = new Headers(asset.headers);
          headers.set("Location", `${base}${target.pathname}${target.search}`);
          return new Response(null, { status: asset.status, headers });
        }
      }
    }

    return asset;
  },

  /** Cron trigger: fire any scheduled restarts that have come due. */
  async scheduled(event, env, ctx) {
    configure(env.NITRADO_BASE_URL);
    const due = await dueSchedules(env);
    for (const job of due) {
      await cancelSchedule(env, job.id);
      const results = await runAction(env, {
        action: job.action,
        serviceIds: job.serviceIds,
        message: job.message,
        actor: `${job.createdBy} (scheduled)`,
      });
      console.log(`Fired ${job.action} for ${job.serviceIds.length} server(s)`, JSON.stringify(results));
    }
    await dispatchStatusPoll(env);

    // Fold the roster the poller published into the presence history.
    const presence = await recordPresence(env);
    if (presence && presence.skipped) console.log(`Presence skipped: ${presence.skipped}`);
  },
};
