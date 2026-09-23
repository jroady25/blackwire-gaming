//
// BlackWire bridge endpoints — the web side of the in-game companion mod.
//
// Public (called by the ARK servers themselves, so no browser session):
//   POST /api/bridge/ping    connectivity probe, records the last 50 hits
//   POST /api/bridge/event   game events (join/leave/death/kill/chat/tame)
//
// Admin-only (mounted behind the session gate in worker.js):
//   GET  /api/bridge/log         recent pings
//   GET  /api/bridge/events      recent events
//   GET  /api/bridge/leaderboard rolled-up per-player totals
//
// Auth for the public routes is a shared secret in the X-BW-Key header,
// enforced once BRIDGE_KEY is set as a Worker secret. Until then requests
// are accepted and flagged unauthenticated, which is what the first
// connectivity test needs.
//
// KV WRITE BUDGET: the free tier allows 1,000 writes/day and the status
// poller already uses some. Events are therefore buffered into a single
// rolling key per UTC day rather than one write per event, and the
// leaderboard is recomputed on read instead of on write.

const PING_KEY = "bridge:pings";
const EVENT_PREFIX = "bridge:events:";
const TOTALS_KEY = "bridge:totals";
const MAX_PINGS = 50;
const MAX_EVENTS_PER_DAY = 500;
const MAX_BODY = 8192;

const ALLOWED_EVENTS = new Set([
  "server_start",
  "player_join",
  "player_leave",
  "player_death",
  "player_kill",
  "chat",
  "tame",
]);

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function checkKey(request, env) {
  const configured = env.BRIDGE_KEY || "";
  const supplied = request.headers.get("x-bw-key") || "";
  if (configured && !timingSafeEqual(supplied, configured)) return null;
  return { authed: Boolean(configured) && supplied === configured };
}

async function readBody(request) {
  let raw = "";
  try {
    raw = (await request.text()).slice(0, MAX_BODY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { unparsed: raw.slice(0, 400) };
  }
}

function dayKey(d = new Date()) {
  return EVENT_PREFIX + d.toISOString().slice(0, 10);
}

export async function handleBridgePing(request, env) {
  if (request.method !== "POST") return json({ error: "POST only." }, 405);
  const key = checkKey(request, env);
  if (!key) return json({ error: "Bad key." }, 401);

  const body = await readBody(request);
  const cf = request.cf || {};
  const entry = {
    at: new Date().toISOString(),
    authed: key.authed,
    ip: request.headers.get("cf-connecting-ip") || null,
    country: cf.country || null,
    colo: cf.colo || null,
    asOrganization: cf.asOrganization || null,
    ua: (request.headers.get("user-agent") || "").slice(0, 160) || null,
    body,
  };

  if (env.STORE) {
    const prev = (await env.STORE.get(PING_KEY, "json")) || [];
    prev.unshift(entry);
    await env.STORE.put(PING_KEY, JSON.stringify(prev.slice(0, MAX_PINGS)));
  }
  // Echo back how many pings are stored and when the last non-probe one
  // arrived, so a test can be confirmed without signing in anywhere.
  let stored = 0;
  let lastFromGame = null;
  if (env.STORE) {
    const all = (await env.STORE.get(PING_KEY, "json")) || [];
    stored = all.length;
    const fromGame = all.find((e) => e && e.body && e.body.src === "BWC_Singleton");
    if (fromGame) lastFromGame = fromGame.at;
  }
  return json({ ok: true, authed: entry.authed, stored, lastFromGame });
}

// One rolling key per UTC day. The mod may batch several events into one
// POST via an "events" array; a single event may also be posted bare.
export async function handleBridgeEvent(request, env) {
  if (request.method !== "POST") return json({ error: "POST only." }, 405);
  const key = checkKey(request, env);
  if (!key) return json({ error: "Bad key." }, 401);

  const body = await readBody(request);
  if (!body) return json({ error: "Empty body." }, 400);

  const incoming = Array.isArray(body.events) ? body.events : [body];
  const now = new Date().toISOString();
  const clean = [];
  for (const e of incoming.slice(0, 100)) {
    const type = String(e.type || e.event || "").slice(0, 32);
    if (!ALLOWED_EVENTS.has(type)) continue;
    clean.push({
      at: typeof e.at === "string" ? e.at.slice(0, 32) : now,
      type,
      server: String(e.server || body.server || "").slice(0, 64) || null,
      map: String(e.map || body.map || "").slice(0, 64) || null,
      playerId: String(e.playerId || "").slice(0, 64) || null,
      player: String(e.player || "").slice(0, 64) || null,
      tribe: String(e.tribe || "").slice(0, 64) || null,
      target: String(e.target || "").slice(0, 96) || null,
      text: String(e.text || "").slice(0, 300) || null,
    });
  }
  if (!clean.length) return json({ ok: true, stored: 0, note: "no recognised events" });

  if (env.STORE) {
    const k = dayKey();
    const prev = (await env.STORE.get(k, "json")) || [];
    const merged = prev.concat(clean).slice(-MAX_EVENTS_PER_DAY);
    await env.STORE.put(k, JSON.stringify(merged), { expirationTtl: 60 * 60 * 24 * 30 });

    // running per-player totals, one extra write, cheap to read back
    const totals = (await env.STORE.get(TOTALS_KEY, "json")) || {};
    for (const e of clean) {
      if (!e.playerId) continue;
      const t = (totals[e.playerId] ||= { player: e.player, kills: 0, deaths: 0, tames: 0, joins: 0 });
      if (e.player) t.player = e.player;
      if (e.type === "player_kill") t.kills += 1;
      if (e.type === "player_death") t.deaths += 1;
      if (e.type === "tame") t.tames += 1;
      if (e.type === "player_join") t.joins += 1;
      t.lastSeen = e.at;
    }
    await env.STORE.put(TOTALS_KEY, JSON.stringify(totals));
  }
  // Echo the day's totals so a probe can confirm what the game sent without
  // needing an admin session.
  let dayTotal = 0;
  let lastFromGame = null;
  const byType = {};
  if (env.STORE) {
    const all = (await env.STORE.get(dayKey(), "json")) || [];
    dayTotal = all.length;
    for (const e of all) {
      byType[e.type] = (byType[e.type] || 0) + 1;
      if (e.server !== "probe" && e.player !== "claude-probe") lastFromGame = e.at;
    }
  }
  return json({ ok: true, stored: clean.length, authed: key.authed, dayTotal, byType, lastFromGame });
}

export async function handleBridgeLog(env) {
  const pings = env.STORE ? (await env.STORE.get(PING_KEY, "json")) || [] : [];
  return json({ count: pings.length, keySet: Boolean(env.BRIDGE_KEY), pings });
}

export async function handleBridgeEvents(env, url) {
  const day = url.searchParams.get("day") || new Date().toISOString().slice(0, 10);
  const list = env.STORE ? (await env.STORE.get(EVENT_PREFIX + day, "json")) || [] : [];
  return json({ day, count: list.length, events: list.slice(-200).reverse() });
}

export async function handleBridgeLeaderboard(env, url) {
  const totals = env.STORE ? (await env.STORE.get(TOTALS_KEY, "json")) || {} : {};
  const sortBy = ["kills", "deaths", "tames", "joins"].includes(url.searchParams.get("by"))
    ? url.searchParams.get("by")
    : "kills";
  const rows = Object.entries(totals)
    .map(([playerId, v]) => ({ playerId, ...v }))
    .sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0))
    .slice(0, 100);
  return json({ sortBy, count: rows.length, rows });
}
