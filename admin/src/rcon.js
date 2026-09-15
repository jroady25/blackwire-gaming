// BlackWire — Source RCON from the Worker.
//
// Nitrado's API can start, stop and restart a server but it cannot say a
// word to the people standing in it. RCON can: ARK:SA speaks the same
// Source RCON protocol Valve games use, and Nitrado exposes it on each
// server using the admin password. This is how a restart warning reaches
// someone mid-session instead of relying on them reading Discord.
//
// The packet handling is a direct port of query_ark_rcon_players() in
// backend/blackwire_status_poller.py, which has been talking to these
// same servers in production since September -- same auth dance, same
// "skip a leading empty packet" quirk, same listplayers parsing.
//
// Endpoints come from the poller's own backend/config.template.json
// rather than being duplicated here, so host/port stay in one place and
// the Worker picks up new servers when that file changes. That file is
// public on purpose (IDs, IPs and ports, no credentials). The password
// is the one secret, read from env.ARK_RCON_PASSWORD; with it unset
// every call below reports "not configured" and nothing else breaks.

import { connect } from "cloudflare:sockets";

const AUTH = 3;
const AUTH_RESPONSE = 2;
const EXEC_COMMAND = 2;

const CONFIG_URL = "https://blackwiregaming.com/backend/config.template.json";
const ENDPOINT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_MESSAGE = 240;

let endpointCache = null;
let endpointCachedAt = 0;

/** service_id -> {host, port, name}, for ARK servers with RCON filled in. */
export async function rconEndpoints() {
  const now = Date.now();
  if (endpointCache && now - endpointCachedAt < ENDPOINT_TTL_MS) return endpointCache;

  const map = new Map();
  try {
    const res = await fetch(`${CONFIG_URL}?t=${now}`, { cf: { cacheTtl: 0, cacheEverything: false } });
    if (res.ok) {
      const cfg = await res.json();
      for (const s of cfg.ark_servers || []) {
        if (s.service_id && s.host && s.rcon_port) {
          map.set(String(s.service_id), {
            host: String(s.host),
            port: Number(s.rcon_port),
            name: s.name || null,
          });
        }
      }
    }
  } catch {
    // Keep whatever was cached rather than blanking the map on a blip.
  }

  if (map.size) {
    endpointCache = map;
    endpointCachedAt = now;
  }
  return endpointCache || map;
}

function pack(id, type, body) {
  const encoded = new TextEncoder().encode(body);
  const buf = new Uint8Array(12 + encoded.length + 2);
  const dv = new DataView(buf.buffer);
  dv.setInt32(0, 8 + encoded.length + 2, true); // size excludes its own 4 bytes
  dv.setInt32(4, id, true);
  dv.setInt32(8, type, true);
  buf.set(encoded, 12);
  return buf; // the two trailing NULs are already zero
}

/** Buffered reader — RCON packets don't align to TCP chunk boundaries. */
function makeReader(stream) {
  const rd = stream.getReader();
  let buf = new Uint8Array(0);
  let ended = false;

  return {
    async exact(n) {
      while (buf.length < n) {
        if (ended) throw new Error("RCON connection closed unexpectedly");
        const chunk = await rd.read();
        if (chunk.done) {
          ended = true;
          continue;
        }
        const next = new Uint8Array(buf.length + chunk.value.length);
        next.set(buf);
        next.set(chunk.value, buf.length);
        buf = next;
      }
      const out = buf.slice(0, n);
      buf = buf.slice(n);
      return out;
    },
    release() {
      try { rd.releaseLock(); } catch { /* already gone */ }
    },
  };
}

async function readPacket(reader) {
  const head = await reader.exact(4);
  const size = new DataView(head.buffer, head.byteOffset, 4).getInt32(0, true);
  if (size < 10 || size > 65536) throw new Error(`RCON returned a bad packet size (${size})`);
  const payload = await reader.exact(size);
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    id: dv.getInt32(0, true),
    type: dv.getInt32(4, true),
    body: new TextDecoder().decode(payload.slice(8, payload.length - 2)),
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  const bell = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, bell]).finally(() => clearTimeout(timer));
}

/**
 * Authenticate once, run each command in order, return their bodies.
 * Throws on connect/auth failure; callers report that per server rather
 * than letting one dead server fail a whole broadcast.
 */
export async function rconExec(endpoint, password, commands, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const socket = connect({ hostname: endpoint.host, port: endpoint.port });

  // A refused or unroutable host rejects socket.opened. Nothing else
  // awaits that promise, so without this it surfaces as an unhandled
  // rejection instead of a per-server error -- which would take down a
  // whole broadcast because one server happened to be down.
  const connectFailed = socket.opened
    ? socket.opened.then(
        () => new Promise(() => {}), // connected: never settle, let the work win
        (err) => {
          throw new Error(`Could not reach ${endpoint.host}:${endpoint.port} — ${err.message}`);
        },
      )
    : new Promise(() => {});

  const writer = socket.writable.getWriter();
  let reader = null;

  try {
    return await withTimeout(Promise.race([connectFailed, (async () => {
      reader = makeReader(socket.readable);
      await writer.write(pack(1, AUTH, password));

      // Some servers emit an empty RESPONSE_VALUE ahead of the real auth
      // reply; a failed auth comes back as id -1.
      let authed = false;
      for (let i = 0; i < 3; i++) {
        const pkt = await readPacket(reader);
        if (pkt.type === AUTH_RESPONSE) {
          authed = pkt.id !== -1;
          break;
        }
      }
      if (!authed) throw new Error("RCON auth rejected — check the admin password");

      const bodies = [];
      let id = 2;
      for (const command of commands) {
        await writer.write(pack(id, EXEC_COMMAND, command));
        const pkt = await readPacket(reader);
        bodies.push(pkt.body);
        id += 1;
      }
      return bodies;
    })()]), timeoutMs, `RCON ${endpoint.host}:${endpoint.port}`);
  } finally {
    try { await writer.close(); } catch { /* already closing */ }
    if (reader) reader.release();
    try { socket.close(); } catch { /* already closed */ }
  }
}

/** ARK's listplayers output: "0. SomeName, 000123..." per line. */
export function parsePlayers(body) {
  const text = (body || "").trim();
  if (!text || /no players connected/i.test(text)) return [];

  const players = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const dot = line.indexOf(".");
    const rest = dot === -1 ? line : line.slice(dot + 1).trim();
    const comma = rest.indexOf(",");
    const name = (comma === -1 ? rest : rest.slice(0, comma)).trim();
    const id = comma === -1 ? "" : rest.slice(comma + 1).trim();
    if (name) players.push({ name, id });
  }
  return players;
}

/**
 * One line, no control characters: the body is NUL-terminated on the
 * wire and a newline would be read as the end of the command.
 */
export function sanitizeMessage(message) {
  return String(message || "")
    .replace(/[\r\n\0]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE);
}

/** Only digits — a kick argument is an EOS/Steam id, never free text. */
export function sanitizePlayerId(id) {
  return String(id || "").replace(/[^0-9]/g, "").slice(0, 32);
}

export function rconConfigured(env) {
  return Boolean(env.ARK_RCON_PASSWORD);
}
