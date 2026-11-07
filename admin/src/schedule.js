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

// Nov 2026: every scheduled job now lives in ONE key (sched:all) instead of one
// key per job. Reading it is a KV get, not a KV list. Cloudflare's free plan
// allows only 1,000 list operations a day but 100,000 reads, and the panel
// checks the schedule every 30 seconds while it is open, so list() ran out
// (the Worker's KV was blocked on 2026-11-07). The only list() left is a
// one-time move of any jobs saved the old way, the first time this runs.
const SCHED_KEY = `${SCHED_PREFIX}all`;
const SLACK_MS = 3600 * 1000; // keep a job an hour past fireAt so a late cron still finds it

async function loadJobs(env) {
  const saved = await env.STORE.get(SCHED_KEY, "json");
  if (Array.isArray(saved)) return saved;
  // First run after the change: move jobs saved one-per-key into the single key.
  let list;
  try {
    list = await env.STORE.list({ prefix: SCHED_PREFIX });
  } catch (err) {
    // The daily list allowance is used up - treat it as no old jobs and try the move again later.
    console.log(`Schedule move skipped: ${err.message}`);
    return [];
  }
  const legacy = list.keys.filter((key) => key.name !== SCHED_KEY);
  const jobs = (await Promise.all(legacy.map((key) => env.STORE.get(key.name, "json")))).filter(Boolean);
  await saveJobs(env, jobs);
  await Promise.all(legacy.map((key) => env.STORE.delete(key.name)));
  return jobs;
}

async function saveJobs(env, jobs) {
  const now = Date.now();
  await env.STORE.put(SCHED_KEY, JSON.stringify(jobs.filter((job) => job.fireAt + SLACK_MS > now)));
}

export async function listSchedules(env) {
  const now = Date.now();
  const jobs = await loadJobs(env);
  return jobs.filter((job) => job && job.fireAt + SLACK_MS > now).sort((a, b) => a.fireAt - b.fireAt);
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
  const jobs = await loadJobs(env);
  jobs.push(record);
  await saveJobs(env, jobs);
  return record;
}

export async function cancelSchedule(env, id) {
  const jobs = await loadJobs(env);
  const existing = jobs.find((job) => job && job.id === id);
  if (!existing) return null;
  await saveJobs(env, jobs.filter((job) => job && job.id !== id));
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
