//
// BlackWire bridge endpoints — the web side of the in-game companion mod.
//
// /api/bridge/ping  POST  called by the ARK server itself, so it has no
//                         browser session. Auth is a shared secret in the
//                         X-BW-Key header, checked only once BRIDGE_KEY is
//                         set as a Worker secret. Until then any ping is
//                         accepted and recorded as unauthenticated, which
//                         is what the first connectivity spike needs.
// /api/bridge/log   GET   admin-only view of recent pings. Mounted behind
//                         the session gate in worker.js.
//
// Nothing here mutates game state or touches any existing route.

const PING_KEY = "bridge:pings";
const MAX_PINGS = 50;
const MAX_BODY = 2048;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export async function handleBridgePing(request, env) {
  if (request.method !== "POST") return json({ error: "POST only." }, 405);

  const configured = env.BRIDGE_KEY || "";
  const supplied = request.headers.get("x-bw-key") || "";
  if (configured && !timingSafeEqual(supplied, configured)) {
    return json({ error: "Bad key." }, 401);
  }

  let raw = "";
  try {
    raw = (await request.text()).slice(0, MAX_BODY);
  } catch {
    raw = "";
  }

  let body = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = { unparsed: raw.slice(0, 400) };
    }
  }

  const cf = request.cf || {};
  const entry = {
    at: new Date().toISOString(),
    authed: Boolean(configured) && supplied === configured,
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

  return json({ ok: true, authed: entry.authed });
}

export async function handleBridgeLog(env) {
  const pings = env.STORE ? (await env.STORE.get(PING_KEY, "json")) || [] : [];
  return json({
    count: pings.length,
    keySet: Boolean(env.BRIDGE_KEY),
    pings,
  });
}

// Constant-time compare so a wrong key can't be guessed by timing.
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
