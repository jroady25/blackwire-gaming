// BlackWire — automatic mod-update posts for the BlackWire Mods Discord.
//
// On every cron tick this looks at each published BlackWire mod's file
// list on CurseForge. When a NEW file has been approved (status 4), it
// posts one message in #mod-updates: the mod's group role + "Every mod
// update" ping, the version, and the patch notes written on CurseForge,
// then publishes it so following servers get it too.
//
// - Each release uploads two files (windows + windowsserver). They share
//   a version number, so one release = one post.
// - Nothing old is ever posted: the first time a mod is seen, its current
//   files are just remembered.
// - Posts through the BlackWire Mod Bot (env.MODBOT_TOKEN): the group
//   roles aren't mentionable, and only a bot with permission can ping them.
//
// To add a newly published mod: add a line to WATCHED below and redeploy.

const CHANNEL_ID = "1559267083093672058"; // #🔔・mod-updates on BlackWire Mods
const STATE_KEY = "modwatch:state";
const CF = "https://www.curseforge.com";
const UA = "BlackWireModWatch/1.0 (+https://blackwiregaming.com)";

const ROLES = {
  every: "1559267064424955916", // Update Pings ("Every mod update")
  "Building & Bases": "1568719297558089789",
  "Creatures & NPCs": "1568719300154490890",
  "Events & PvP": "1568719302071296041",
  "Server & Admin": "1568719304042610799",
  "Gear & HUD": "1568719305485455552",
};

// project = CurseForge project ID, channel = the mod's own Discord channel,
// banner = its banner on the website (same picture as its Discord channel).
export const WATCHED = [
  { project: 1790325, name: "BlackWire Admin Panel", slug: "blackwire-admin-panel", emoji: "🛡️", group: "Server & Admin", channel: "1559267086185005078", banner: "mod-admin" },
  { project: 1699363, name: "BlackWire PauseMenu", slug: "blackwire-community-mod", emoji: "🧭", group: "Server & Admin", channel: "1559267087711473785", banner: "mod-community" },
  { project: 1708126, name: "BlackWire Onboarding & Starter Kit", slug: "blackwire-onboarding-starter-kit", emoji: "🎒", group: "Server & Admin", channel: "1559267095244709888", banner: "mod-onboarding" },
  { project: 1727486, name: "BlackWire Shop/Trade", slug: "blackwire-shop-trade", emoji: "🪙", group: "Server & Admin", channel: "1559267089905094797", banner: "mod-shop" },
  // announceFirst: post its first release as soon as it goes public (it wasn't public yet when added).
  { project: 1797724, name: "BlackWire Spyglass", slug: null, emoji: "🔭", group: "Gear & HUD", channel: "1559267096301412403", banner: "mod-spyglass", announceFirst: true },
];

async function cf(path) {
  const res = await fetch(`${CF}${path}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`CurseForge ${res.status} for ${path}`);
  return res.json();
}

/** "blackwire-shoptrade-windows-2.zip" / "blackwire shoptrade-windows 1.zip" -> 2 / 1 */
export function versionOf(fileName) {
  const m = String(fileName || "").match(/[-\s](\d+)\.zip$/i);
  return m ? Number(m[1]) : null;
}

function decode(s) {
  return s
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

const SECTION_NAMES = {
  NEW: "🆕 New", ADDED: "🆕 New", ADD: "🆕 New",
  IMPROVED: "⬆️ Improved", CHANGED: "⬆️ Improved", CHANGES: "⬆️ Improved", UPDATED: "⬆️ Improved",
  FIXED: "🛠️ Fixed", FIXES: "🛠️ Fixed", BUGFIXES: "🛠️ Fixed",
  REMOVED: "🗑️ Removed",
};

/**
 * CurseForge changelog HTML -> { headline, sections: [{title, items}] }.
 * Understands "NEW / IMPROVED / FIXED" headings, and loose "- Fixed: ..."
 * lines in a flat list.
 */
export function parseChangelog(html) {
  const text = decode(
    String(html || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h\d)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, ""),
  );
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  let headline = null;
  const sections = [];
  let current = null;
  const section = (title) => {
    let s = sections.find((x) => x.title === title);
    if (!s) sections.push((s = { title, items: [] }));
    return s;
  };

  for (const line of lines) {
    const head = line.replace(/[:\s]+$/, "").toUpperCase().replace(/\s+/g, "");
    if (SECTION_NAMES[head]) {
      current = section(SECTION_NAMES[head]);
      continue;
    }
    if (/^[-•*]\s*/.test(line)) {
      let item = line.replace(/^[-•*]\s*/, "");
      let target = current;
      const fixed = item.match(/^fix(ed)?\s*:\s*/i);
      if (fixed && (!current || current.title !== "🛠️ Fixed")) {
        item = item.slice(fixed[0].length);
        item = item.charAt(0).toUpperCase() + item.slice(1);
        target = section("🛠️ Fixed");
      }
      (target || section("🆕 What's new")).items.push(item);
      continue;
    }
    if (!headline && !sections.length) headline = line;
    else (current || section("🆕 What's new")).items.push(line);
  }
  // Keep "What's new" first, "Fixed" last.
  const order = ["🆕 What's new", "🆕 New", "⬆️ Improved", "🗑️ Removed", "🛠️ Fixed"];
  sections.sort((a, b) => order.indexOf(a.title) - order.indexOf(b.title));
  return { headline, sections };
}

/** Embed description, kept under Discord's limit with a "more" line. */
export function renderNotes(parsed, moreUrl, maxLen = 3600) {
  const out = [];
  if (parsed.headline) out.push(`**${parsed.headline}**`);
  let used = out.join("\n").length;
  let dropped = 0;
  for (const s of parsed.sections) {
    if (!s.items.length) continue;
    const head = `\n**${s.title}**`;
    if (used + head.length > maxLen) { dropped += s.items.length; continue; }
    out.push(head);
    used += head.length;
    for (const item of s.items) {
      const line = `• ${item}`;
      if (used + line.length + 1 > maxLen) { dropped += 1; continue; }
      out.push(line);
      used += line.length + 1;
    }
  }
  if (dropped) out.push(`\n…and ${dropped} more on [CurseForge](${moreUrl}).`);
  return out.join("\n").trim();
}

async function discord(env, path, body) {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method: "POST",
    headers: { Authorization: `Bot ${env.MODBOT_TOKEN}`, "Content-Type": "application/json", "User-Agent": "BlackWireModWatch (https://blackwiregaming.com, 1.0)" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Discord ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

export function buildPost(mod, release, notesHtml, { firstRelease = false } = {}) {
  // /projects/<id> redirects to the mod's page, so it works before we know the slug.
  const url = mod.slug ? `${CF}/ark-survival-ascended/mods/${mod.slug}` : `${CF}/projects/${mod.project}`;
  const parsed = parseChangelog(notesHtml);
  let description = renderNotes(parsed, url);
  if (!description) description = firstRelease ? "First release is out now!" : "A new version is out now.";
  description += `\n\n💬 Talk about it in <#${mod.channel}>`;
  const roles = [ROLES[mod.group], ROLES.every].filter(Boolean);
  return {
    content: `${roles.map((r) => `<@&${r}>`).join(" ")}`,
    allowed_mentions: { roles },
    embeds: [{
      title: `${mod.emoji} ${mod.name} ${firstRelease ? "is out" : "updated"}${release.version != null ? ` — Version ${release.version}` : ""}`,
      url,
      description,
      color: 0xd61f26,
      image: mod.banner ? { url: `https://blackwiregaming.com/assets/discord/mods/${mod.banner}.jpg?v=1` } : undefined,
      footer: { text: "Download or update on CurseForge • PC, Xbox & PlayStation" },
      timestamp: release.date,
    }],
  };
}

/** Approved files grouped into releases (one per version), newest first. */
async function releasesFor(mod) {
  const json = await cf(`/api/v1/mods/${mod.project}/files?pageIndex=0&pageSize=20&sort=dateCreated&sortDescending=true`);
  const groups = new Map();
  for (const f of json.data || []) {
    if (f.status !== 4) continue; // only approved files
    const version = versionOf(f.fileName);
    const key = version != null ? `v${version}` : `f${f.id}`;
    const g = groups.get(key) || { key, version, ids: [], date: f.dateCreated, clientFile: null };
    g.ids.push(f.id);
    if (!/server/i.test(f.fileName)) g.clientFile = f.id;
    if (f.dateCreated > g.date) g.date = f.dateCreated;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => Math.max(...b.ids) - Math.max(...a.ids));
}

/**
 * Cron entry. Returns a short log line. `force` (array of project IDs)
 * posts the newest release of those mods even if it was already seen.
 */
export async function checkModUpdates(env, { force = [] } = {}) {
  if (!env.MODBOT_TOKEN || !env.STORE) return "modwatch: not configured";
  const state = (await env.STORE.get(STATE_KEY, "json")) || {};
  let changed = false;
  const log = [];

  for (const mod of WATCHED) {
    try {
      const releases = await releasesFor(mod);
      if (!releases.length) continue;
      const seen = state[mod.project];
      const forced = force.includes(mod.project);

      if (!seen && !forced && !mod.announceFirst) {
        // First look at this mod: remember what's there, post nothing.
        state[mod.project] = { keys: releases.map((r) => r.key).slice(0, 30) };
        changed = true;
        log.push(`${mod.name}: remembered ${releases.length} release(s)`);
        continue;
      }

      const known = new Set(seen ? seen.keys : []);
      const fresh = forced ? [releases[0]] : releases.filter((r) => !known.has(r.key));
      if (!fresh.length) continue;

      const release = fresh[0]; // newest; older unseen ones are folded into it
      const fileId = release.clientFile || release.ids[0];
      let notes = "";
      try {
        notes = (await cf(`/api/v1/mods/${mod.project}/files/${fileId}/change-log`)).changelogBody || "";
      } catch (err) {
        log.push(`${mod.name}: notes unavailable (${err.message})`);
      }
      const firstRelease = releases.length === 1;
      const msg = await discord(env, `/channels/${CHANNEL_ID}/messages`, buildPost(mod, release, notes, { firstRelease }));
      try {
        await discord(env, `/channels/${CHANNEL_ID}/messages/${msg.id}/crosspost`);
      } catch (err) {
        log.push(`${mod.name}: posted but not published (${err.message})`);
      }

      const keys = new Set([...(seen ? seen.keys : []), ...releases.map((r) => r.key)]);
      state[mod.project] = { keys: [...keys].slice(-30), lastPosted: release.key, lastPostedAt: new Date().toISOString() };
      changed = true;
      log.push(`${mod.name}: posted ${release.key}`);
    } catch (err) {
      log.push(`${mod.name}: ${err.message}`);
    }
  }

  // Only write when something changed (KV free tier: 1,000 writes/day).
  if (changed) await env.STORE.put(STATE_KEY, JSON.stringify(state));
  return `modwatch: ${log.join("; ") || "nothing new"}`;
}
