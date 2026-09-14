// KV-backed scheduled actions (a "restart in 15 min" job the cron trigger
// later fires) and the audit log both live here — both are just timestamped
// records in the same STORE namespace.

const SCHED_PREFIX = "sched:";
const AUDIT_PREFIX = "audit:";
const AUDIT_TTL_DAYS = 30;
const MAX_DELAY_MINUTES = 720;

function newId() {
  return crypto.randomUUID().slice(0, 8);
}

export async function listSchedules(env) {
  const list = await env.STORE.list({ prefix: SCHED_PREFIX });
  const jobs = await Promise.all(list.keys.map((key) => env.STORE.get(key.name, "json")));
  return jobs.filter(Boolean).sort((a, b) => a.fireAt - b.fireAt);
}

export async function createSchedule(env, job) {
  const delay = Math.min(Math.max(Number(job.delayMinutes) || 0, 1), MAX_DELAY_MINUTES);
  const record = {
    id: newId(),
    action: job.action,
    serviceIds: job.serviceIds,
    names: job.names || [],
    message: job.message || "",
    fireAt: Date.now() + delay * 60000,
    createdBy: job.createdBy,
    createdAt: Date.now(),
  };
  await env.STORE.put(`${SCHED_PREFIX}${record.id}`, JSON.stringify(record), {
    // A little slack past fireAt so a late-firing cron still finds the job.
    expirationTtl: Math.ceil(delay * 60) + 3600,
  });
  return record;
}

export async function cancelSchedule(env, id) {
  const key = `${SCHED_PREFIX}${id}`;
  const existing = await env.STORE.get(key, "json");
  if (!existing) return null;
  await env.STORE.delete(key);
  return existing;
}

export async function dueSchedules(env, now = Date.now()) {
  const jobs = await listSchedules(env);
  return jobs.filter((job) => job.fireAt <= now);
}

export async function writeAudit(env, entry) {
  const key = `${AUDIT_PREFIX}${Date.now()}-${newId()}`;
  await env.STORE.put(key, JSON.stringify({ at: Date.now(), ...entry }), {
    expirationTtl: AUDIT_TTL_DAYS * 86400,
  });
}

export async function readAudit(env, limit = 50) {
  const list = await env.STORE.list({ prefix: AUDIT_PREFIX, limit: 400 });
  const keys = list.keys.map((key) => key.name).sort().reverse().slice(0, limit);
  const entries = await Promise.all(keys.map((key) => env.STORE.get(key, "json")));
  return entries.filter(Boolean);
}
