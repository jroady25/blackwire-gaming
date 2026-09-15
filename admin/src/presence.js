// BlackWire — presence history.
//
// The poller already pulls the real connected-player names over RCON and
// publishes them in status.json, but status.json is overwritten every
// five minutes, so none of it is ever kept. This folds each published
// roster into one rolling summary so the panel can answer the questions
// a snapshot can't: who actually plays, on which map, and who has gone
// quiet.
//
// WHY KV AND NOT THE SITE REPO: status.json lives in a public repo, so
// anything written beside it is public too. "Who is online right now"
// is already public on the site; a play-time history of named people is
// a different disclosure, so it lives here in the admin Worker's KV and
// is only readable through /api/activity, behind the same login as the
// rest of the panel.
//
// COST: one KV read + one KV write per cron tick -- 288 writes/day,
// well under Cloudflare's free 1,000/day (the same cap the sched: list
// ops hit in Sept). Per-tick raw samples are deliberately NOT stored,
// only the aggregate below, so the key stays small and the page costs a
// single read.

const KEY = "presence:summary";
const STATUS_URL = "https://blackwiregaming.com/status.json";
const TZ = "America/New_York";
const DAILY_KEEP = 180;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function emptySummary() {
  return {
    v: 1,
    updated: null,
    first: null,
    lastSampleAt: null,
    samples: 0,
    intervalMin: 5,
    players: {},
    servers: {},
    hour: new Array(24).fill(0),
    dow: new Array(7).fill(0),
    daily: {},
  };
}

/** Bucket a UTC timestamp into Eastern date / hour / weekday, DST included. */
function easternParts(iso) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(iso))) p[part.type] = part.value;
  const dow = DOW.indexOf(p.weekday);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    // hour12:false yields "24" for midnight on some engines.
    hour: Number(p.hour) % 24,
    dow: dow < 0 ? 0 : dow,
  };
}

/**
 * Fold one published status.json into the summary. Pure, so the same
 * code path can be replayed over history in a test.
 */
export function foldSample(summary, payload) {
  const stamp = payload && payload.generated_at;
  if (!stamp) return { skipped: "no generated_at" };
  // The site sits behind a 4-hour Cloudflare cache, so a stale fetch is
  // normal rather than exceptional -- never count the same roster twice.
  if (summary.lastSampleAt === stamp) return { skipped: "duplicate sample" };

  const { date, hour, dow } = easternParts(stamp);
  let counted = 0;
  let unknown = 0;

  for (const group of Object.values((payload && payload.servers) || {})) {
    for (const row of (group && group.servers) || []) {
      // A server with no "players" key had no usable RCON this tick
      // (restarting, wrong port, Once Human). That is unknown, NOT
      // empty -- counting it as empty would invent quiet hours.
      if (!Array.isArray(row.players)) {
        if (row.online) unknown += 1;
        continue;
      }
      const server = String(row.name || "unknown");
      for (const raw of row.players) {
        const name = String(raw).trim();
        if (!name) continue;
        let p = summary.players[name];
        if (!p) {
          p = { n: 0, first: stamp, last: stamp, srv: {} };
          summary.players[name] = p;
        }
        p.n += 1;
        p.last = stamp;
        p.srv[server] = (p.srv[server] || 0) + 1;
        summary.servers[server] = (summary.servers[server] || 0) + 1;
        counted += 1;
      }
    }
  }

  summary.samples += 1;
  summary.lastSampleAt = stamp;
  summary.updated = new Date().toISOString();
  if (!summary.first) summary.first = stamp;
  summary.hour[hour] += counted;
  summary.dow[dow] += counted;
  summary.daily[date] = (summary.daily[date] || 0) + counted;

  const days = Object.keys(summary.daily).sort();
  while (days.length > DAILY_KEEP) delete summary.daily[days.shift()];

  return { ok: true, at: stamp, players: counted, unknownServers: unknown };
}

/** Cron tick: read the published roster and fold it in. Never throws. */
export async function recordPresence(env) {
  if (!env.STORE) return { skipped: "no KV binding" };

  let payload;
  try {
    const res = await fetch(`${STATUS_URL}?t=${Date.now()}`, {
      cf: { cacheTtl: 0, cacheEverything: false },
      headers: { "Cache-Control": "no-cache" },
    });
    if (!res.ok) return { skipped: `status.json HTTP ${res.status}` };
    payload = await res.json();
  } catch (err) {
    return { skipped: `fetch failed: ${err.message}` };
  }

  const stored = await env.STORE.get(KEY, "json");
  const summary = stored && stored.v === 1 ? stored : emptySummary();

  const result = foldSample(summary, payload);
  if (!result.ok) return result;

  await env.STORE.put(KEY, JSON.stringify(summary));
  return result;
}

/** Shape the summary for the activity page. */
export function shapeActivity(summary) {
  const s = summary && summary.v === 1 ? summary : emptySummary();
  const mins = s.intervalMin || 5;
  const hrs = (n) => Math.round((n * mins / 60) * 10) / 10;
  const now = Date.now();

  const players = Object.keys(s.players)
    .map((name) => {
      const p = s.players[name];
      const top = Object.keys(p.srv)
        .map((k) => [k, p.srv[k]])
        .sort((a, b) => b[1] - a[1])[0];
      const lastMs = Date.parse(p.last);
      return {
        name,
        samples: p.n,
        hours: hrs(p.n),
        first: p.first,
        last: p.last,
        daysSince: Number.isFinite(lastMs) ? Math.floor((now - lastMs) / 86400000) : null,
        home: top ? top[0] : null,
        homeShare: top ? Math.round((top[1] / p.n) * 100) : null,
        servers: Object.keys(p.srv).length,
      };
    })
    .sort((a, b) => b.samples - a.samples);

  const servers = Object.keys(s.servers)
    .map((name) => ({ name, samples: s.servers[name], hours: hrs(s.servers[name]) }))
    .sort((a, b) => b.samples - a.samples);

  return {
    updated: s.updated,
    first: s.first,
    lastSampleAt: s.lastSampleAt,
    samples: s.samples,
    intervalMin: mins,
    trackedHours: hrs(s.samples),
    playerHours: hrs(players.reduce((n, p) => n + p.samples, 0)),
    players,
    servers,
    hour: s.hour,
    dow: s.dow,
    daily: Object.keys(s.daily)
      .sort()
      .map((d) => ({ date: d, hours: hrs(s.daily[d]) })),
  };
}

export async function readActivity(env) {
  const stored = env.STORE ? await env.STORE.get(KEY, "json") : null;
  return shapeActivity(stored);
}
