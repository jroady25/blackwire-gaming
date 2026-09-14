// Sessions (signed cookies, no session store needed), password + Discord
// login, login rate-limiting, and the audit log — all backed by the STORE
// KV namespace.

const COOKIE_NAME = "bw_session";
const SESSION_HOURS = 12;
const encoder = new TextEncoder();

function b64urlEncode(bytes) {
  let binary = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function sign(secret, data) {
  const key = await hmacKey(secret);
  return b64urlEncode(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

async function verify(secret, data, signature) {
  const key = await hmacKey(secret);
  try {
    return await crypto.subtle.verify("HMAC", key, b64urlDecode(signature), encoder.encode(data));
  } catch {
    return false;
  }
}

function timingSafeEqual(a = "", b = "") {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  let diff = aBytes.length ^ bBytes.length;
  const length = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

export async function createSession(env, user) {
  const payload = {
    u: user.name,
    v: user.via,
    id: user.id ?? null,
    exp: Date.now() + SESSION_HOURS * 3600 * 1000,
  };
  const body = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await sign(env.SESSION_SECRET, body);
  return `${body}.${signature}`;
}

export async function verifySignedToken(env, token) {
  if (!token) return null;
  const [body, signature] = String(token).split(".");
  if (!body || !signature) return null;
  if (!(await verify(env.SESSION_SECRET, body, signature))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function readSession(env, request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  const payload = await verifySignedToken(env, match[1]);
  // "state" sessions are OAuth CSRF tokens, not real logins.
  return payload && payload.v !== "state" ? payload : null;
}

export function sessionCookie(value, { clear = false } = {}) {
  const parts = [
    `${COOKIE_NAME}=${clear ? "" : value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    clear ? "Max-Age=0" : `Max-Age=${SESSION_HOURS * 3600}`,
  ];
  return parts.join("; ");
}

const MAX_ATTEMPTS = 8;
const WINDOW_SECONDS = 600;

export async function tooManyAttempts(env, ip) {
  const key = `login:${ip}`;
  const count = Number((await env.STORE.get(key)) || 0);
  return count >= MAX_ATTEMPTS;
}

export async function recordFailedAttempt(env, ip) {
  const key = `login:${ip}`;
  const count = Number((await env.STORE.get(key)) || 0) + 1;
  await env.STORE.put(key, String(count), { expirationTtl: WINDOW_SECONDS });
}

export async function clearAttempts(env, ip) {
  await env.STORE.delete(`login:${ip}`);
}

export { timingSafeEqual };

export function discordEnabled(env) {
  return Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.DISCORD_GUILD_ID);
}

export async function discordAuthorizeUrl(env, origin) {
  const state = await createSession(env, { name: "oauth-state", via: "state" });
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${origin}/auth/discord/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify guilds.members.read");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function discordLogin(env, code, origin) {
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${origin}/auth/discord/callback`,
    }),
  });
  if (!tokenRes.ok) throw new Error("Discord rejected the login.");
  const tokens = await tokenRes.json();

  const memberRes = await fetch(`https://discord.com/api/users/@me/guilds/${env.DISCORD_GUILD_ID}/member`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (memberRes.status === 404) throw new Error("You are not a member of the BlackWire Discord.");
  if (!memberRes.ok) throw new Error("Could not read your Discord roles.");
  const member = await memberRes.json();

  const allowed = (env.DISCORD_ADMIN_ROLE_IDS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (allowed.length) {
    const roles = member.roles || [];
    if (!roles.some((role) => allowed.includes(role))) {
      throw new Error("Your Discord account does not have an admin role.");
    }
  }

  const name = member.nick || member.user?.global_name || member.user?.username || "discord user";
  return { name, via: "discord", id: member.user?.id ?? null };
}
