// Thin wrapper around the Nitrado API: listing services, reading a
// gameserver's live status, and issuing start/stop/restart commands.

let baseUrl = "https://api.nitrado.net";

export function configure(url) {
  if (url) baseUrl = url;
}

export class NitradoError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "NitradoError";
    this.status = status;
  }
}

async function request(token, path, { method = "GET", body } = {}) {
  if (!token) throw new NitradoError("NITRADO_TOKEN is not configured.", 500);

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "BlackWireAdmin/1.0",
  };

  let payload;
  if (body) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null && String(value).length) {
        params.append(key, String(value));
      }
    }
    payload = params.toString();
  }

  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    const reason = err.name === "TimeoutError" ? "timed out" : err.message;
    throw new NitradoError(`Could not reach Nitrado: ${reason}`, 502);
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const message =
      (json && (json.message || json.error)) ||
      (res.status === 401
        ? "Nitrado rejected the API token."
        : res.status === 429
        ? "Nitrado rate limit hit - try again in a minute."
        : `Nitrado returned HTTP ${res.status}.`);
    throw new NitradoError(message, res.status);
  }

  if (json && json.status && json.status !== "success") {
    throw new NitradoError(json.message || "Nitrado reported a failure.", 502);
  }

  return json;
}

export async function listServices(token) {
  const json = await request(token, "/services");
  return json?.data?.services ?? [];
}

export async function getGameserver(token, serviceId) {
  const json = await request(token, `/services/${serviceId}/gameservers`);
  return json?.data?.gameserver ?? null;
}

export function restartServer(token, serviceId, { message, restartMessage } = {}) {
  return request(token, `/services/${serviceId}/gameservers/restart`, {
    method: "POST",
    body: { message, restart_message: restartMessage },
  });
}

export function stopServer(token, serviceId, { message, stopMessage } = {}) {
  return request(token, `/services/${serviceId}/gameservers/stop`, {
    method: "POST",
    body: { message, stop_message: stopMessage },
  });
}

export function startServer(token, serviceId, { message } = {}) {
  // Nitrado has no dedicated "start" endpoint for a stopped gameserver;
  // restart brings a stopped one back up too.
  return request(token, `/services/${serviceId}/gameservers/restart`, {
    method: "POST",
    body: { message: message || "Started from BlackWire admin panel" },
  });
}

const STATUS_MAP = {
  started: { label: "Online", tone: "online" },
  stopped: { label: "Offline", tone: "offline" },
  stopping: { label: "Stopping", tone: "busy" },
  restarting: { label: "Restarting", tone: "busy" },
  updating: { label: "Updating", tone: "busy" },
  installing: { label: "Installing", tone: "busy" },
  gameserver_installation: { label: "Installing", tone: "busy" },
  backup_restore: { label: "Restoring backup", tone: "busy" },
  backup_creation: { label: "Creating backup", tone: "busy" },
  suspended: { label: "Suspended", tone: "warn" },
  guardian_locked: { label: "Guardian locked", tone: "warn" },
  error: { label: "Error", tone: "error" },
};

function normalizeStatus(raw) {
  const status = (raw || "unknown").toLowerCase();
  return { status, ...(STATUS_MAP[status] || { label: raw || "Unknown", tone: "unknown" }) };
}

async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  await Promise.all(
    new Array(Math.min(limit, items.length)).fill(null).map(async () => {
      while (index < items.length) {
        const current = index++;
        results[current] = await worker(items[current]);
      }
    })
  );
  return results;
}

/** Which admin-panel "cluster" a server belongs to, per the CLUSTERS rules. */
function clusterFor(server, rules = []) {
  const haystack = `${server.name} ${server.game} ${server.gameHuman}`.toLowerCase();
  for (const rule of rules) {
    if (!rule || !rule.name) continue;
    if (Array.isArray(rule.ids) && rule.ids.map(Number).includes(Number(server.serviceId))) {
      return rule.name;
    }
    const exclude = (rule.exclude || []).map((term) => String(term).toLowerCase());
    if (exclude.some((term) => haystack.includes(term))) continue;
    const match = (rule.match || []).map((term) => String(term).toLowerCase());
    if (match.length && !match.some((term) => haystack.includes(term))) continue;
    if (match.length || Array.isArray(rule.ids)) return rule.name;
  }
  return server.gameHuman || server.game || "Other";
}

function parseClusterRules(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Fetch every gameserver's live status from Nitrado and shape it for the
 * dashboard: name, address, player counts, status tone, and cluster.
 */
export async function buildSnapshot(token, filter = {}) {
  const services = await listServices(token);

  const allowlist = (filter.allowlist || "").split(",").map((value) => value.trim()).filter(Boolean);
  const exclude = (filter.nameExclude || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);

  let gameservers = services.filter((service) => service.type === "gameserver");
  if (allowlist.length) {
    gameservers = gameservers.filter((service) => allowlist.includes(String(service.id)));
  }
  if (exclude.length) {
    gameservers = gameservers.filter((service) => {
      const name = `${service.details?.name || ""} ${service.comment || ""}`.toLowerCase();
      return !exclude.some((term) => name.includes(term));
    });
  }

  const servers = await mapWithLimit(gameservers, 4, async (service) => {
    const base = {
      serviceId: service.id,
      name: service.details?.name || service.comment || `Service ${service.id}`,
      game: service.details?.game || "",
      gameHuman: service.details?.game || "",
      address: service.details?.address || "",
      players: { current: null, max: null },
      ...normalizeStatus(service.status === "suspended" ? "suspended" : "unknown"),
      error: null,
    };

    if (service.status !== "active") return base;

    try {
      const gs = await getGameserver(token, service.id);
      if (!gs) return { ...base, error: "No gameserver data returned." };
      return {
        ...base,
        name: gs.query?.server_name || base.name,
        game: gs.game || base.game,
        gameHuman: gs.game_human || base.gameHuman,
        address: gs.ip && gs.port ? `${gs.ip}:${gs.port}` : base.address,
        slots: gs.slots ?? null,
        players: {
          current: gs.query?.player_current ?? null,
          max: gs.query?.player_max ?? gs.slots ?? null,
        },
        ...normalizeStatus(gs.status),
      };
    } catch (err) {
      return { ...base, error: err.message };
    }
  });

  const rules = parseClusterRules(filter.clusters);
  servers.forEach((server) => {
    server.cluster = clusterFor(server, rules);
  });
  servers.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const declared = rules.map((rule) => rule?.name).filter(Boolean);
  const present = [...new Set(servers.map((server) => server.cluster))];
  const clusters = [
    ...declared.filter((name) => present.includes(name)),
    ...present.filter((name) => !declared.includes(name)).sort(),
  ];

  return { servers, clusters, fetchedAt: Date.now() };
}
