#!/usr/bin/env python3
"""
BlackWire status poller
========================
 
Polls Nitrado's API for ARK: Survival Ascended and Palworld servers, and
attempts a live query against the Once Human custom server, then writes
a single status.json that the BlackWire website's live-data.js fetches
to fill in real numbers on the homepage and per-game pages. Nothing on
the website depends on this running — if it isn't, or status.json isn't
reachable yet, the site just falls back to its static placeholder text.
 
WHY THIS EXISTS AS A SEPARATE SCRIPT
-------------------------------------
The website itself is static HTML/JS with no server of its own. It can't
call Nitrado's API directly from the browser (that would mean shipping
your API token in public page source) and it can't open an RCON
connection at all (RCON is a raw TCP protocol — browsers have no way to
do that). So this script is meant to run somewhere you control (your
DigitalOcean droplet is the obvious place, since that's already hosting
the old site), poll the real data, and drop a small plain JSON file
somewhere the website's JS can fetch it with a normal HTTPS GET.
 
SETUP
-----
1. cp config.example.json config.json
2. Fill in config.json:
     - nitrado_token: an API token from your Nitrado account's API
       settings page (used for ARK only — see below)
     - ark_servers: one entry per ARK server, each with its Nitrado
       service_id and the display name you want on the site. List every
       server you want tracked — the homepage now shows the busiest 5
       (sorted live) plus the real total count, so add or remove entries
       here as your cluster changes and the site follows.
     - ark_rcon_password (optional): set this AND each ark_servers
       entry's "host" + "rcon_port" to also pull the real list of
       connected player names via RCON, on top of the counts Nitrado's
       API already provides. Leave ark_rcon_password unset (or an
       entry's host/rcon_port blank) and that server just keeps showing
       counts only, same as before — this is purely additive. See the
       big comment above query_ark_rcon_players() for what this needs
       and why it's a separate mechanism from the Nitrado API above.
     - auto_discover_ark: set true to also auto-add any ARK server on
       your Nitrado account whose name contains "blackwire", instead of
       relying only on the hand-listed ark_servers above — see the big
       comment above discover_blackwire_ark_services() before enabling
       this; it needs a one-time sanity check with --discover-only
       against your real account first.
     - palworld_servers: Palworld servers do NOT use Nitrado's API for
       live data (Nitrado returns no query data for this game) — instead
       each server has its own REST API. Per entry, fill in:
         "host": the server's IP (from its Nitrado panel)
         "rest_api_port": the RestAPI Port shown in its Nitrado panel
                          (conventionally game_port + 3)
         "username": almost always "admin"
         "password": the AdminPassword set in that server's own
                      PalWorldSettings.ini — NOT your Nitrado login
       Leave host/password blank and a server just shows as offline
       until you fill them in — nothing else breaks. Palworld's API
       returns each connected player's real name for free, so that's
       included automatically once host/password are filled in — no
       extra setup needed for names specifically, unlike ARK's RCON step
       above.
     - once_human_servers: one entry per Once Human world (e.g. a PvE
       server and a PvP server), each with "name", "players_max", and
       optionally "host"/"query_port". Confirmed no API and no RCON for
       this game, so leave "host" blank on every entry — there's no
       supported way to get live player counts for it (see the comment
       above query_once_human_a2s() if curious). Listing the servers
       here anyway still gets you an accurate Servers/Total slots count
       on the site, which is why this is a list rather than a single
       null like before.
3. Test it once by hand:
     python3 blackwire_status_poller.py --config config.json --out status.json
   ...then open status.json and sanity-check the numbers against what
   you see in-game.
4. Run it on a schedule. A cron entry every 2-5 minutes is plenty:
     */3 * * * * cd /path/to/this/folder && python3 blackwire_status_poller.py --config config.json --out /var/www/blackwire/status.json
5. Wherever status.json lands needs to be served over HTTPS with CORS
   allowing the site's origin — the simplest option is dropping it next
   to whatever static files your existing web server (nginx/Caddy/etc.)
   already serves, and adding a header for that one file/path, e.g. in
   nginx:
     location = /status.json {
         add_header Access-Control-Allow-Origin *;
     }
6. Update STATUS_URL near the top of live-data.js (in the website's
   files) to point at wherever that ends up — e.g.
   "https://blackwiregaming.gg/status.json" — and republish the site.
 
No third-party packages are required — everything here is Python's
standard library, so this should run as-is with `python3` on the
droplet.
"""
 
import argparse
import json
import socket
import struct
import sys
import time
import urllib.error
import urllib.request
 
NITRADO_API_BASE = "https://api.nitrado.net"
 
 
def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", file=sys.stderr)
 
 
def nitrado_get_gameserver(service_id, token):
    """
    Calls Nitrado's gameserver-details endpoint and pulls the live query
    block out of the response. Returns {"online", "players_current",
    "players_max"} or None if the call fails or the server has no query
    data populated (some configs don't expose it — RCON is the fallback
    for those, but the exact command differs per game so it isn't
    implemented generically here).
 
    Docs: https://doc.nitrado.net/#api-Gameserver-Details
    """
    url = f"{NITRADO_API_BASE}/services/{service_id}/gameservers"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        log(f"Nitrado API call failed for service {service_id}: {exc}")
        return None
 
    try:
        gs = payload["data"]["gameserver"]
        status = gs.get("status")
        query = gs.get("query") or {}
        current = query.get("player_current")
        maximum = query.get("player_max")
        if current is None or maximum is None:
            log(f"Service {service_id}: no query data in the API response — "
                f"this server may need query enabled in its Nitrado panel, "
                f"or needs RCON instead of the API for player counts.")
            return None
        return {
            "online": status == "started",
            "players_current": int(current),
            "players_max": int(maximum),
            "map": query.get("map"),
        }
    except (KeyError, TypeError) as exc:
        log(f"Unexpected Nitrado response shape for service {service_id}: {exc}")
        return None
 
 
def poll_nitrado_group(entries, token, rcon_password=None):
    """rcon_password: the shared ARK RCON/admin password to use for any
    entry that has "host" and "rcon_port" filled in but no per-entry
    "rcon_password" override — see the ARK RCON section below. Purely
    additive: entries without host/rcon_port still work exactly as
    before, using only Nitrado's API for counts."""
    results = []
    for entry in entries:
        data = nitrado_get_gameserver(entry["service_id"], token)
        if data is None:
            # Keep the server listed but mark it unreachable, rather than
            # silently dropping the row — a visibly-offline server reads
            # better on the site than one that just vanishes.
            results.append({
                "name": entry["name"],
                "online": False,
                "players_current": 0,
                "players_max": entry.get("players_max", 0),
                "map": None,
            })
            continue
 
        row = {"name": entry["name"], **data}
 
        # Optional: layer in the actual connected-player names via RCON,
        # on top of the count Nitrado's API already gave us above. Only
        # attempted when this entry has enough to try, and failure here
        # never affects the count/online status already established.
        password = entry.get("rcon_password") or rcon_password
        if entry.get("host") and entry.get("rcon_port") and password:
            rcon_data = query_ark_rcon_players(entry["host"], entry["rcon_port"], password)
            if rcon_data is not None:
                row["players"] = rcon_data["players"]
 
        results.append(row)
    return results
 
 
# ---------------------------------------------------------------------
# ARK auto-discovery — OFF by default, not yet live-verified.
#
# Justin's ask: when he adds, removes, or renames a server on Nitrado,
# the site should reflect it immediately, without him having to come
# back and hand-edit config.json's ark_servers list every time. Without
# this, that list has to be manually kept in sync with his real Nitrado
# account, same as the old site's hardcoded numbers were.
#
# This walks every service on the Nitrado account (GET /services), and
# for each one that looks like an ARK: Survival Ascended server with
# "BlackWire" in its actual live server name (not just Justin's private
# account-level label for it — same rule used to build the original 19-
# server list), adds it automatically. Anything already listed by hand
# in ark_servers still works exactly as before — this only ADDS newly-
# discovered servers that aren't already in that list, so config.json's
# list still doubles as a manual override for edge cases (see
# auto_discover_exclude_ids below).
#
# CAVEAT: the exact field Nitrado uses in its API response to say "this
# is an ARK: Survival Ascended service" wasn't confirmed against a real
# account when this was written (Nitrado's docs don't spell it out, and
# testing needs a live token, which isn't something to leave sitting in
# this file). The code below tries several reasonably-likely field
# names and logs clearly whenever it can't tell — it does NOT silently
# guess wrong and drop a server, or silently include a wrong one without
# a log line you can check. Before turning this on for real:
#   python3 blackwire_status_poller.py --config config.json --discover-only
# ...and check the printed list against your real server list. Once that
# looks right, set "auto_discover_ark": true in config.json.
# ---------------------------------------------------------------------
 
def nitrado_list_services(token):
    """GET /services — every service on the account. Returns a list of
    raw service dicts (shape varies), or [] on any failure."""
    url = f"{NITRADO_API_BASE}/services"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        log(f"Nitrado /services call failed: {exc}")
        return []
    try:
        return payload["data"]["services"]
    except (KeyError, TypeError) as exc:
        log(f"Unexpected /services response shape: {exc}")
        return []
 
 
def discover_blackwire_ark_services(token, name_filter="blackwire", exclude_ids=None):
    """Returns [{"service_id", "name"}, ...] for every ARK: Survival
    Ascended service on the account whose live server name contains
    name_filter (case-insensitive). See the big comment above — this
    hasn't been live-verified, so it logs anything ambiguous instead of
    guessing silently."""
    exclude_ids = {str(x) for x in (exclude_ids or [])}
    found = []
    for svc in nitrado_list_services(token):
        service_id = str(svc.get("id", ""))
        if not service_id or service_id in exclude_ids:
            continue
 
        url = f"{NITRADO_API_BASE}/services/{service_id}/gameservers"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            log(f"Discovery: couldn't fetch service {service_id}: {exc}")
            continue
 
        try:
            gs = payload["data"]["gameserver"]
        except (KeyError, TypeError):
            continue
 
        # Best-effort guess at which field says "this is ARK: Survival
        # Ascended" — unconfirmed, see caveat above.
        game_hint = str(gs.get("game") or gs.get("game_human") or gs.get("type") or "").lower()
        looks_like_ark = ("ark" in game_hint) or ("asa" in game_hint) or ("survival" in game_hint)
        if game_hint and not looks_like_ark:
            continue  # confidently a different game (e.g. Palworld) — skip quietly
 
        query = gs.get("query") or {}
        server_name = str(query.get("server_name") or "")
        if name_filter.lower() not in server_name.lower():
            continue
 
        if not game_hint:
            log(f"Discovery: service {service_id} ('{server_name}') matched the "
                f"name filter but its game type field came back empty, so this "
                f"is included on the name match alone — worth double-checking.")
 
        found.append({"service_id": service_id, "name": server_name or f"Service {service_id}"})
 
    return found
 
 
# ---------------------------------------------------------------------
# ARK RCON — the actual list of connected player names, on top of the
# count Nitrado's API already gives us.
#
# Nitrado's gameserver API (nitrado_get_gameserver above) only reports
# player_current/player_max — never names. To get real names, this
# talks RCON directly: the same "Source RCON" protocol Valve games use
# (raw TCP, a simple auth-then-command exchange), which ARK: Survival
# Ascended supports natively. Nitrado turns RCON on automatically for
# every ARK server and reuses the server's own admin password
# (ServerAdminPassword in GameUserSettings.ini) as the RCON password —
# both are visible in that server's Nitrado panel.
#
# This sends one command, "listplayers", and parses ARK's plain-text
# reply (one line per connected player: "0. PlayerName, 000...steamid",
# or "No Players Connected."). It does NOT use RCON for the count/online
# status — Nitrado's API is more reliable for that and doesn't need a
# password per server — this only adds the name list on top when RCON
# credentials are available for that entry (see poll_nitrado_group).
#
# SECURITY: the RCON password is exactly as sensitive as the Palworld
# admin password above — never commit the real value to a file that
# leaves your own droplet, and never paste it anywhere other than your
# own config.json.
# ---------------------------------------------------------------------
 
_RCON_AUTH = 3
_RCON_AUTH_RESPONSE = 2
_RCON_EXEC_COMMAND = 2
 
 
def _rcon_pack(pkt_id, pkt_type, body):
    payload = struct.pack("<ii", pkt_id, pkt_type) + body.encode("utf-8") + b"\x00\x00"
    return struct.pack("<i", len(payload)) + payload
 
 
def _rcon_recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("RCON socket closed unexpectedly")
        buf += chunk
    return buf
 
 
def _rcon_read_packet(sock):
    size = struct.unpack("<i", _rcon_recv_exact(sock, 4))[0]
    payload = _rcon_recv_exact(sock, size)
    pkt_id, pkt_type = struct.unpack("<ii", payload[:8])
    body = payload[8:-2].decode("utf-8", errors="replace")
    return pkt_id, pkt_type, body
 
 
def query_ark_rcon_players(host, port, password, timeout=6):
    """Returns {"players": [name, ...]} or None on any failure (wrong
    password, RCON not reachable/enabled, connection refused, etc.)."""
    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect((host, port))
 
        sock.sendall(_rcon_pack(1, _RCON_AUTH, password))
        # Some servers send an empty SERVERDATA_RESPONSE_VALUE packet
        # ahead of the real auth response — skip past it if present.
        auth_ok = False
        for _ in range(3):
            pkt_id, pkt_type, _body = _rcon_read_packet(sock)
            if pkt_type == _RCON_AUTH_RESPONSE:
                auth_ok = (pkt_id != -1)
                break
        if not auth_ok:
            log(f"ARK RCON auth failed ({host}:{port}) — check the RCON password.")
            return None
 
        sock.sendall(_rcon_pack(2, _RCON_EXEC_COMMAND, "listplayers"))
        _pkt_id, _pkt_type, body = _rcon_read_packet(sock)
 
        text = body.strip()
        if not text or "no players connected" in text.lower():
            return {"players": []}
 
        names = []
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            after_dot = line.split(".", 1)[-1].strip()
            name = after_dot.split(",", 1)[0].strip()
            if name:
                names.append(name)
        return {"players": names}
    except (OSError, ConnectionError, struct.error) as exc:
        log(f"ARK RCON query failed ({host}:{port}): {exc}")
        return None
    finally:
        if sock is not None:
            sock.close()
 
 
# ---------------------------------------------------------------------
# Palworld — its OWN official REST API, not Nitrado's API and not RCON.
#
# Palworld dedicated servers ship a documented REST API of their own
# (https://tech.palworldgame.com/category/rest-api). That's a separate,
# per-server thing from Nitrado's account-level API — which is exactly
# why nitrado_get_gameserver() above comes back with an empty query
# object for Palworld services: Nitrado doesn't run a query daemon for
# this game, the game exposes its own API instead.
#
# By convention (and confirmed against both of your servers' Nitrado
# panels) it listens on game_port + 3 — e.g. game port 17100 -> REST
# API port 17103. It's authenticated with HTTP Basic Auth using the
# admin username (almost always "admin") and the AdminPassword set in
# that server's own PalWorldSettings.ini — NOT your Nitrado account
# login, and NOT the same thing as an RCON password even though some
# panels/guides use the two terms loosely.
#
# It's served over HTTPS with a self-signed certificate by default, so
# certificate verification is deliberately skipped below — that's safe
# here since this connects straight to your server's own IP, not
# through a public CA-verified hostname.
# ---------------------------------------------------------------------
 
def query_palworld_rest_api(host, port, username, password, timeout=5):
    """Returns {"online", "players_current", "players_max"} or None on
    any failure (wrong password, server offline, REST API disabled,
    wrong port, etc.).
 
    Tries HTTPS first (current Palworld dedicated server builds serve
    the REST API over HTTPS with a self-signed cert), then falls back
    to plain HTTP automatically. Some servers -- older Palworld
    versions, or certain hosts' setups -- serve it unencrypted instead,
    and there's no reliable way to know which without asking, so this
    just tries both and uses whichever one answers. No per-server
    config needed for this either way."""
    import base64
    import ssl
 
    auth = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    headers = {"Authorization": f"Basic {auth}", "Accept": "application/json"}
 
    def _get(scheme, path):
        url = f"{scheme}://{host}:{port}{path}"
        req = urllib.request.Request(url, headers=headers)
        if scheme == "https":
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                return json.loads(resp.read().decode("utf-8"))
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
 
    players_payload = settings_payload = None
    last_exc = None
    for scheme in ("https", "http"):
        try:
            players_payload = _get(scheme, "/v1/api/players")
            settings_payload = _get(scheme, "/v1/api/settings")
            break
        except (urllib.error.URLError, TimeoutError, ValueError, ConnectionError) as exc:
            last_exc = exc
            continue
    if players_payload is None or settings_payload is None:
        log(f"Palworld REST API call failed ({host}:{port}, tried https and http): {last_exc}")
        return None
 
    try:
        raw_players = players_payload.get("players", [])
        current = len(raw_players)
        maximum = int(settings_payload.get("ServerPlayerMaxNum", 0))
        # Palworld's REST API gives real names for free here — each entry
        # has a "name" field — so this is included at no extra cost,
        # unlike ARK where names need a separate RCON call (see
        # query_ark_rcon_players above).
        names = [p.get("name") for p in raw_players if p.get("name")]
        return {"online": True, "players_current": current, "players_max": maximum, "players": names}
    except (KeyError, TypeError, ValueError) as exc:
        log(f"Unexpected Palworld REST API response shape ({host}:{port}): {exc}")
        return None
 
 
def poll_palworld_group(entries):
    """entries: list of {name, host, rest_api_port, username, password,
    [players_max]} — see config.example.json. Falls back to a visibly
    offline row (same pattern as poll_nitrado_group) if host/password
    aren't filled in yet, or the call fails."""
    results = []
    for entry in entries:
        data = None
        if entry.get("host") and entry.get("password"):
            data = query_palworld_rest_api(
                entry["host"],
                entry.get("rest_api_port", 8212),
                entry.get("username", "admin"),
                entry["password"],
            )
        if data is None:
            results.append({
                "name": entry["name"],
                "online": False,
                "players_current": 0,
                "players_max": entry.get("players_max", 0),
                "map": None,
            })
        else:
            data["map"] = None
            results.append({"name": entry["name"], **data})
    return results
 
 
# ---------------------------------------------------------------------
# Once Human — CONFIRMED UNAVAILABLE.
#
# Justin's confirmed his Once Human servers expose neither an API nor
# RCON, so there's currently no supported way to pull live player
# counts for this game the way ARK and Palworld do. The website already
# reflects this honestly (no "syncing" language, no live feed promised
# on this game's plate or page) rather than showing a permanently-stuck
# pending state. What IS shown live is the plain server/slot count (see
# poll_once_human_group below and renderCapacityOnly in live-data.js) —
# that's config, not a query, so it's always accurate without needing a
# working live-data path.
#
# The function below is left in purely as a speculative long shot, not
# something to rely on: NetEase doesn't publish docs for the custom-
# server feature's query protocol, but community setup guides show the
# dedicated server exposing a game port, a query port, and an RCON port
# in the same 27015/27016/27017 pattern popularized by Source-engine
# servers — which suggests, but doesn't confirm, the query port might
# answer a standard A2S_INFO request even without RCON/API access. If
# you ever get a host/port for a server and want to try it purely out
# of curiosity, that entry's "host" in config.json's once_human_servers
# list will pick it up — but don't expect it to work, and there's no
# need to chase this further.
# ---------------------------------------------------------------------
 
def query_once_human_a2s(host, port, timeout=3):
    """Best-effort Source-style A2S_INFO query. Returns
    {"players_current", "players_max"} or None on any failure."""
    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(timeout)
        request = b"\xFF\xFF\xFF\xFFTSource Engine Query\x00"
        sock.sendto(request, (host, port))
        data, _ = sock.recvfrom(4096)
 
        # A2S_INFO response: 4-byte header (FF FF FF FF), 1-byte type
        # ('I'), 1-byte protocol version, then null-terminated name/map/
        # folder/game strings, a 2-byte app id, then 1 byte each for
        # current and max players.
        if len(data) < 7 or data[4:5] != b"I":
            return None
        remainder = data[6:]
        parts = remainder.split(b"\x00", 3)
        if len(parts) < 4 or len(parts[3]) < 4:
            return None
        tail = parts[3]
        players = tail[2]
        max_players = tail[3]
        return {"players_current": players, "players_max": max_players}
    except Exception as exc:
        log(f"Once Human A2S query failed ({host}:{port}): {exc}")
        return None
    finally:
        if sock is not None:
            sock.close()
 
 
def poll_once_human_group(entries):
    """entries: list of {name, [host], [query_port], [players_max]} — see
    config.example.json. An entry with no "host" filled in (the expected
    case — see the big comment above, this game has no confirmed
    live-query path) now reports online (not offline) using its
    configured players_max: Justin's confirmed these servers effectively
    never go down, so showing them dimmed/offline on the wall board was
    actively misleading rather than just incomplete. Player count stays
    at 0 since a real headcount still isn't knowable without a live
    query -- only the up/down state changed."""
    results = []
    for entry in entries:
        name = entry.get("name", "Once Human World")
        result = None
        if entry.get("host"):
            result = query_once_human_a2s(entry["host"], entry.get("query_port", 27016))
        if result is None:
            results.append({
                "name": name, "online": True,
                "players_current": 0, "players_max": entry.get("players_max", 20),
            })
        else:
            results.append({"name": name, "online": True, **result})
    return results
 
 
def main():
    parser = argparse.ArgumentParser(description="Poll BlackWire's game servers and write status.json")
    parser.add_argument("--config", default="config.json")
    parser.add_argument("--out", default="status.json")
    parser.add_argument("--discover-only", action="store_true",
                         help="Run ARK auto-discovery and print what it finds, without "
                              "writing status.json. Use this to sanity-check discovery "
                              "against your real Nitrado account before turning on "
                              "auto_discover_ark in config.json.")
    args = parser.parse_args()
 
    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)
 
    if args.discover_only:
        discovered = discover_blackwire_ark_services(
            cfg["nitrado_token"],
            name_filter=cfg.get("auto_discover_name_filter", "blackwire"),
            exclude_ids=cfg.get("auto_discover_exclude_ids", []),
        )
        print(json.dumps(discovered, indent=2))
        log(f"Discovery found {len(discovered)} matching service(s). Compare this "
            f"against your real server list before enabling auto_discover_ark.")
        return
 
    ark_entries = list(cfg.get("ark_servers", []))
    if cfg.get("auto_discover_ark"):
        discovered = discover_blackwire_ark_services(
            cfg["nitrado_token"],
            name_filter=cfg.get("auto_discover_name_filter", "blackwire"),
            exclude_ids=cfg.get("auto_discover_exclude_ids", []),
        )
        known_ids = {str(e["service_id"]) for e in ark_entries}
        for svc in discovered:
            if svc["service_id"] not in known_ids:
                log(f"Discovery: adding newly-found service {svc['service_id']} "
                    f"('{svc['name']}') — not in config.json's hand-listed ark_servers.")
                ark_entries.append(svc)
                known_ids.add(svc["service_id"])
 
    ark = poll_nitrado_group(ark_entries, cfg["nitrado_token"], cfg.get("ark_rcon_password"))
    palworld = poll_palworld_group(cfg.get("palworld_servers", []))
    once_human = poll_once_human_group(cfg.get("once_human_servers", []))
 
    status = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "servers": {
            "ark": {"servers": ark},
            "palworld": {"servers": palworld},
            "once_human": {"servers": once_human},
        },
    }
 
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(status, f, indent=2)
    log(f"Wrote {args.out}")
 
 
if __name__ == "__main__":
    main()
 
