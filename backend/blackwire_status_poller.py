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
     - auto_discover_ark: set true and this becomes the SOURCE OF TRUTH
       for which ARK servers show up on the site and what they're named:
       add, rename, or remove a server on Nitrado (as long as its live
       name still contains "blackwire") and the site follows within one
       poll, no config.json edit needed. ark_servers above still matters
       when this is on -- it's now just where you optionally add "host"
       + "rcon_port" (and a per-entry "rcon_password" override) to a
       discovered server's service_id, to get that server's connected-
       player-names feature; typing a bare "name"/service_id there with
       no host/rcon_port does nothing once discovery is on, since the
       live Nitrado name and server list always win. See the big comment
       above discover_blackwire_ark_services() before enabling this; it
       needs a one-time sanity check with --discover-only against your
       real account first.
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
import os
import socket
import struct
import sys
import time
import urllib.error
import urllib.request
 
NITRADO_API_BASE = "https://api.nitrado.net"
 
 
def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", file=sys.stderr)
 
 
def _parse_gameserver_status(service_id, gs):
    """Shared by nitrado_get_gameserver() (a fresh fetch) and
    poll_nitrado_group() when it already has this run's discovery probe
    for this service (see probed_gs below) -- same parsing either way,
    just sometimes skipping a second network call for data we already
    fetched once this run. Takes an already-fetched "gameserver" dict
    (payload["data"]["gameserver"]) and returns {"online",
    "players_current", "players_max", "map", "live_name"} or None if
    this server has no query data populated (some configs don't expose
    it — RCON is the fallback for those, but the exact command differs
    per game so it isn't implemented generically here)."""
    try:
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
            # Nitrado's own live server name, when it returns one -- lets
            # poll_nitrado_group() show the server's *actual current* name
            # (e.g. after Justin renames/reconfigures it on Nitrado) instead
            # of the static label typed into config.json once and never
            # revisited. Justin flagged an ARK entry stuck on an old name
            # ("Event Map -- Club Ark") that no longer matched the real
            # server -- this is what keeps that from happening again.
            "live_name": query.get("server_name") or None,
        }
    except (KeyError, TypeError) as exc:
        log(f"Unexpected Nitrado response shape for service {service_id}: {exc}")
        return None
 
 
def nitrado_get_gameserver(service_id, token):
    """
    Calls Nitrado's gameserver-details endpoint and parses the live
    query block out of the response via _parse_gameserver_status().
    Returns {"online", "players_current", "players_max"} or None if the
    call fails or the server has no query data populated.
 
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
    except (KeyError, TypeError) as exc:
        log(f"Unexpected Nitrado response shape for service {service_id}: {exc}")
        return None
    return _parse_gameserver_status(service_id, gs)
 
 
def poll_nitrado_group(entries, token, rcon_password=None, probed_gs=None):
    """rcon_password: the shared ARK RCON/admin password to use for any
    entry that has "host" and "rcon_port" filled in but no per-entry
    "rcon_password" override — see the ARK RCON section below. Purely
    additive: entries without host/rcon_port still work exactly as
    before, using only Nitrado's API for counts.
 
    probed_gs: optional {service_id: gameserver_dict} already fetched
    this run by discover_blackwire_ark_services() -- when a service_id
    is in here, its status is parsed straight from that data instead of
    hitting Nitrado's API a second time for the exact same service in
    the exact same run. This roughly halves the number of Nitrado API
    calls a single poll makes (discovery + status used to each fetch
    every service separately), which matters because a service whose
    discovery probe just failed this run is very likely to fail an
    immediate second call too -- so the old double-fetch wasn't even
    buying a second chance, just extra load. Falls back to a fresh
    nitrado_get_gameserver() call for anything not in probed_gs (e.g.
    auto_discover_ark is off, so there was no discovery pass at all)."""
    probed_gs = probed_gs or {}
    results = []
    for entry in entries:
        service_id = entry["service_id"]
        if service_id in probed_gs:
            data = _parse_gameserver_status(service_id, probed_gs[service_id])
        else:
            data = nitrado_get_gameserver(service_id, token)
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
 
        # Prefer Nitrado's live server name over the static config label,
        # falling back to the config label only when Nitrado doesn't return
        # a live name (e.g. the no-query-data case handled above, which
        # never reaches this line since it "continue"s earlier).
        live_name = data.pop("live_name", None)
        row = {"name": live_name if live_name else entry["name"], **data}
 
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
# ARK auto-discovery -- ON (config.json's auto_discover_ark: true), and,
# as of this update, AUTHORITATIVE rather than merely additive.
#
# Justin's ask: when he adds, removes, or renames a server on Nitrado,
# the site should reflect it immediately, without him having to come
# back and hand-edit config.json's ark_servers list every time.
#
# This walks every service on the Nitrado account (GET /services), and
# for each one that looks like an ARK: Survival Ascended server with
# "BlackWire" in its actual live server name (not just Justin's private
# account-level label for it), includes it. main() below now treats this
# discovered list as the definitive list of which ARK servers exist and
# what they're named -- add one on Nitrado and it appears on the site
# next poll, rename one and the site's label follows (the same live-name
# lookup poll_nitrado_group() already does per-poll, from Nitrado's own
# API response), remove/decommission one and it drops off automatically.
# config.json's hand-listed ark_servers is NOT the source of the list
# itself anymore when this is on -- it's only consulted for optional
# per-server RCON host/rcon_port/rcon_password overrides, matched by
# service_id, so the connected-player-names feature keeps working for
# servers that already have that configured. A newly-discovered server
# just won't have player names until that's added by hand, same as a
# freshly hand-typed entry wouldn't.
#
# SAFETY NET: if discovery comes back with zero services (API hiccup,
# bad/expired token, temporary Nitrado outage, etc.), main() falls back
# to the hand-listed ark_servers for that one run rather than showing an
# empty ARK section on the site.
#
# CAVEAT (unchanged from before this was turned on): the exact field
# Nitrado uses in its API response to say "this is an ARK: Survival
# Ascended service" wasn't confirmed against a real account when this
# was first written. The code below tries several reasonably-likely
# field names and logs clearly whenever it can't tell -- it does NOT
# silently guess wrong and drop a server, or silently include a wrong
# one without a log line you can check. To re-sanity-check discovery
# against the real account at any time:
#   python3 blackwire_status_poller.py --config config.json --discover-only
# Also note the name filter: a server renamed so its live name no longer
# contains "blackwire" (auto_discover_name_filter in config.json) will
# drop out of discovery even though it still exists on the account --
# worth knowing if a server ever mysteriously vanishes from the site.
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
 
 
_DEBUG_DUMPS = {"n": 0, "limit": 5}  # TEMP DEBUG, see note below -- remove once diagnosed


def discover_blackwire_ark_services(token, name_filter="blackwire", exclude_ids=None):
    """Returns (found, unreachable_ids, account_ids, probed_gs):
      found: [{"service_id", "name"}, ...] for every service CONFIRMED
        this run to be a BlackWire ARK: Survival Ascended server (live
        name contains name_filter, game type looks like ARK).
      unreachable_ids: {service_id, ...} for services still on the
        Nitrado account (present in /services) whose per-service probe
        failed THIS run (timeout, malformed response, API error) --
        this run simply couldn't tell whether they match. NOT the same
        as "confirmed this isn't a BlackWire ARK server".
      account_ids: {service_id, ...} for every service_id currently on
        the Nitrado account, straight from /services. main() uses this
        to tell "genuinely removed from the account" (missing here)
        apart from "temporarily unreachable this run" (present here,
        but also in unreachable_ids) -- see the big comment above
        main()'s ark_entries handling for why that distinction exists.
      probed_gs: {service_id: gameserver_dict} for every service whose
        per-service call succeeded and returned a parseable
        payload["data"]["gameserver"] this run, whatever it turned out
        to contain (matched, not matched, even no query data) -- this
        is the same raw data poll_nitrado_group() would otherwise fetch
        AGAIN a few seconds later for the exact same service. main()
        passes this straight through so that second, redundant fetch
        can be skipped -- see the big comment on poll_nitrado_group().
    See the big comment above this function for the game-type caveat --
    it hasn't been live-verified, so it logs anything ambiguous instead
    of guessing silently."""
    exclude_ids = {str(x) for x in (exclude_ids or [])}
    found = []
    unreachable_ids = set()
    account_ids = set()
    probed_gs = {}
    for svc in nitrado_list_services(token):
        service_id = str(svc.get("id", ""))
        if not service_id:
            continue
        account_ids.add(service_id)
        if service_id in exclude_ids:
            continue
 
        url = f"{NITRADO_API_BASE}/services/{service_id}/gameservers"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                http_status = resp.status
                payload = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            log(f"Discovery: couldn't fetch service {service_id}: {exc}")
            unreachable_ids.add(service_id)
            continue
 
        try:
            gs = payload["data"]["gameserver"]
        except (KeyError, TypeError):
            unreachable_ids.add(service_id)
            continue
 
        # TEMP DEBUG (Justin asked to root-cause the account-wide "no
        # query data" pattern) -- log only the non-sensitive fields
        # (never credentials/ftp/mysql/rcon) for the first few services
        # this run, so we can see exactly what Nitrado sent back instead
        # of guessing. Remove once diagnosed.
        if _DEBUG_DUMPS["n"] < _DEBUG_DUMPS["limit"]:
            _DEBUG_DUMPS["n"] += 1
            safe = {k: gs.get(k) for k in
                    ("id", "status", "game", "game_human", "type", "query",
                     "must_be_started", "suspend_status")
                    if k in gs}
            log(f"DEBUG service {service_id}: http_status={http_status} "
                f"fields={json.dumps(safe, default=str)[:2000]}")
 
        # Save this now, regardless of what the rest of this loop
        # iteration decides about game type / name match -- it's this
        # service's real gameserver payload for this run either way,
        # and reusing it below is what lets poll_nitrado_group() skip
        # calling Nitrado again for the same service_id.
        probed_gs[service_id] = gs
 
        # Best-effort guess at which field says "this is ARK: Survival
        # Ascended" — unconfirmed, see caveat above.
        game_hint = str(gs.get("game") or gs.get("game_human") or gs.get("type") or "").lower()
        looks_like_ark = ("ark" in game_hint) or ("asa" in game_hint) or ("survival" in game_hint)
        if game_hint and not looks_like_ark:
            continue  # confidently a different game (e.g. Palworld) — skip quietly, not "unreachable"
 
        query = gs.get("query") or {}
        server_name = str(query.get("server_name") or "")
        if not server_name:
            # The service responded, but with no query data at all -- no
            # name to judge by. This is NOT "confidently not a match": a
            # server that's offline or briefly hasn't been queried by
            # Nitrado can report empty query data even though it's really
            # one of ours. Treat it the same as an unreachable probe so a
            # server we already know about can be carried over from the
            # cache instead of silently vanishing from the site.
            log(f"Discovery: service {service_id}: no query data in the API "
                f"response this run, so its name can't be confirmed -- "
                f"treating as unreachable rather than assuming it's not a match.")
            unreachable_ids.add(service_id)
            continue
        if name_filter.lower() not in server_name.lower():
            continue  # confidently not a match this run -- has a name, just not ours
 
        if not game_hint:
            log(f"Discovery: service {service_id} ('{server_name}') matched the "
                f"name filter but its game type field came back empty, so this "
                f"is included on the name match alone — worth double-checking.")
 
        found.append({"service_id": service_id, "name": server_name or f"Service {service_id}"})
 
    return found, unreachable_ids, account_ids, probed_gs


def load_ark_cache(path):
    """Reads the last-known-good {"service_id", "name"} list this same
    poller wrote out on a past run -- see the big comment in main()
    about why this exists (surviving a transient Nitrado API blip
    during discovery without servers vanishing off the site)."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return []


def save_ark_cache(path, entries):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(entries, f, indent=2)
 
 
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
        discovered, unreachable, account_ids, _probed_gs = discover_blackwire_ark_services(
            cfg["nitrado_token"],
            name_filter=cfg.get("auto_discover_name_filter", "blackwire"),
            exclude_ids=cfg.get("auto_discover_exclude_ids", []),
        )
        print(json.dumps(discovered, indent=2))
        log(f"Discovery found {len(discovered)} matching service(s), "
            f"{len(unreachable)} unreachable this run, out of {len(account_ids)} "
            f"total service(s) on the account. Compare this against your real "
            f"server list before enabling auto_discover_ark.")
        return
 
    ark_entries_config = list(cfg.get("ark_servers", []))
    # Cache of the last run's confirmed {"service_id", "name"} ARK list,
    # written alongside status.json (see save_ark_cache below) and
    # committed to the repo by the workflow, same as status.json is --
    # this is what lets a server survive one bad poll instead of
    # vanishing off the site. See the big comment just below.
    ark_cache_path = os.path.join(os.path.dirname(args.out) or ".", "known_ark_services.json")
    # Populated below only when auto_discover_ark ran and actually talked
    # to Nitrado this run -- poll_nitrado_group() treats None/empty the
    # same as "no discovery data to reuse" and just falls back to its own
    # fresh per-service call, same as before this existed.
    probed_gs = None
    if cfg.get("auto_discover_ark"):
        discovered, unreachable, account_ids, probed_gs = discover_blackwire_ark_services(
            cfg["nitrado_token"],
            name_filter=cfg.get("auto_discover_name_filter", "blackwire"),
            exclude_ids=cfg.get("auto_discover_exclude_ids", []),
        )
        if discovered or unreachable:
            # Discovery is authoritative for which ARK servers exist and
            # what they're named -- but Nitrado's API is not perfectly
            # reliable run to run, and a per-service probe failing here
            # (see discover_blackwire_ark_services' unreachable_ids)
            # doesn't mean the server is gone, just that this run
            # couldn't re-confirm it. Without a fallback, that made
            # servers flicker on and off the site's list any time
            # Nitrado's API had a rough few minutes, exactly like the
            # "only 13 servers" report that prompted this.
            #
            # So: a service that's unreachable THIS run but was
            # confirmed by a PAST run (in the cache) and is still on the
            # Nitrado account (in account_ids -- i.e. not actually
            # deleted) gets carried over using its last-known name.
            # poll_nitrado_group()'s own separate API call still decides
            # whether to show it online or offline, exactly like it
            # always has for every other server -- carrying it over just
            # keeps it from disappearing outright.
            cached_by_id = {str(e["service_id"]): e for e in load_ark_cache(ark_cache_path)}
            discovered_ids = {svc["service_id"] for svc in discovered}
            known = list(discovered)
            kept_stale = 0
            for service_id in unreachable:
                if service_id in discovered_ids:
                    continue
                cached_entry = cached_by_id.get(service_id)
                if cached_entry and service_id in account_ids:
                    known.append({"service_id": service_id, "name": cached_entry["name"]})
                    kept_stale += 1
            # Persist the full merged set (fresh + carried-over), not just
            # this run's fresh confirmations -- otherwise a server that
            # stays unreachable for two runs in a row would drop out of
            # the cache after the first carry-over and vanish on the
            # second. A server only truly drops out once it's missing
            # from account_ids, i.e. Nitrado itself no longer lists it.
            save_ark_cache(ark_cache_path, known)

            # The hand-listed ark_servers in config.json is only
            # consulted here to carry over optional RCON connection info
            # for servers that already have it configured (matched by
            # service_id) -- see the big comment above
            # discover_blackwire_ark_services().
            overrides_by_id = {str(e["service_id"]): e for e in ark_entries_config}
            ark_entries = []
            for svc in known:
                entry = dict(svc)
                override = overrides_by_id.get(str(svc["service_id"]))
                if override:
                    for key in ("host", "rcon_port", "rcon_password", "players_max"):
                        if key in override:
                            entry[key] = override[key]
                ark_entries.append(entry)
            log(f"Discovery: {len(ark_entries)} ARK server(s) on the site this run "
                f"({len(discovered)} freshly confirmed"
                + (f", {kept_stale} carried over after an unreachable probe this run"
                   if kept_stale else "") + ").")
        else:
            log("Discovery couldn't even list services on the account this run "
                "(full API/token failure) -- falling back to config.json's "
                "hand-listed ark_servers rather than showing an empty ARK "
                "section.")
            ark_entries = ark_entries_config
    else:
        ark_entries = ark_entries_config
 
    ark = poll_nitrado_group(ark_entries, cfg["nitrado_token"], cfg.get("ark_rcon_password"), probed_gs=probed_gs)
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
 
