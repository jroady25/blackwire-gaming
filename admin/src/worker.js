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
  },
};
