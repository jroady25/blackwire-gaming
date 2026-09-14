/*
 * BlackWire live data loader.
 *
 * This site is static — it has no server of its own, so it can't call
 * Nitrado's API or open an RCON socket directly (RCON is a raw TCP
 * protocol; browsers can't do that at all, and calling Nitrado's API
 * from client-side JS would mean shipping an API token in public page
 * source, which this deliberately does not do).
 *
 * Instead, this expects a small JSON file — written by a separate
 * poller script (see backend/blackwire_status_poller.py), run on a
 * schedule by this repo's own GitHub Actions workflow — to land at
 * /status.json, right next to this file. Fetched as a root-relative,
 * same-origin path on purpose: it means no CORS configuration is ever
 * needed (same-origin requests don't need it), and it works unchanged
 * whether the site is served from a raw github.io URL or your own
 * custom domain later. If it 404s (workflow hasn't run yet, or this is
 * just the Cowork preview) every page falls back to the static
 * placeholder content already in the HTML. Nothing breaks either way.
 *
 * Expected JSON shape (see the poller script for the authoritative
 * schema):
 * {
 *   "generated_at": "2026-09-13T20:00:00Z",
 *   "servers": {
 *     "ark":         { "servers": [ {"name","online","players_current","players_max","map","players"?}, ... ] },
 *     "palworld":    { "servers": [ {"name","online","players_current","players_max","players"?}, ... ] },
 *     "once_human":  { "servers": [ ... ] }
 *   }
 * }
 *
 * "players" (an array of real in-game names) is optional per server —
 * present for ARK only where that server's RCON credentials are set in
 * config.json, and present for Palworld automatically once a server's
 * host/password are filled in (its REST API returns names for free).
 * Justin's explicit call: real names ARE shown publicly here, not just
 * in Discord — see the conversation this was built from if that ever
 * needs revisiting.
 */
(function(){
  // Root-relative and same-origin on purpose — see header comment above.
  var STATUS_URL = new URL('status.json', document.currentScript.src).href;

  // How many names to spell out inline before collapsing the rest into
  // "+N more" — keeps a 20-player row from blowing out the table on a
  // busy night while still answering "who's actually on" at a glance.
  var NAMES_SHOWN = 6;

  function capPct(current, max){
    if(!max || max <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((current / max) * 100)));
  }

  function sumField(servers, field){
    return servers.reduce(function(total, s){ return total + (Number(s[field]) || 0); }, 0);
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  // Renders the small "who's on" line under a server's count — only
  // when the poller actually got real names for that server (ARK
  // servers without RCON creds, or any server with nobody on, simply
  // don't get one — no fabricated names, ever).
  function namesLine(players){
    if(!Array.isArray(players) || !players.length) return '';
    var shown = players.slice(0, NAMES_SHOWN).map(escapeHtml);
    var extra = players.length - shown.length;
    var text = shown.join(', ') + (extra > 0 ? ', +' + extra + ' more' : '');
    return '<div class="who-on">' + text + '</div>';
  }

  // Shared renderer for a full server-list table (used by both the ARK
  // and Palworld live feeds on the homepage) — every server passed in
  // gets a row, sorted busiest-first, so "Servers" in the nav actually
  // shows the whole roster rather than a top-5 sample.
  function renderServerFeed(game, tbodyId){
    if(!game || !Array.isArray(game.servers) || !game.servers.length) return;
    var body = document.getElementById(tbodyId);
    if(!body) return;

    var sorted = game.servers.slice().sort(function(a, b){
      return (b.players_current || 0) - (a.players_current || 0);
    });
    var rows = sorted.map(function(s){
      var pct = capPct(s.players_current, s.players_max);
      var dotClass = (s.online === false) ? 'live-dot offline' : 'live-dot';
      return '<tr><td><span class="' + dotClass + '"></span>' + escapeHtml(s.name) + '</td>' +
             '<td><span class="srv-count">' + s.players_current + '/' + s.players_max + '</span>' +
             '<span class="cap-bar" aria-hidden="true"><span style="width:' + pct + '%"></span></span>' +
             namesLine(s.players) + '</td></tr>';
    });
    body.innerHTML = rows.join('');
  }

  // homepage ARK plate stats: Servers / Online now / Maps, driven from
  // the real list instead of numbers that need to be remembered and
  // hand-updated as the cluster changes
  function renderArkStats(ark){
    if(!ark || !Array.isArray(ark.servers) || !ark.servers.length) return;

    var totalEl = document.getElementById('ark-total-servers');
    if(totalEl) totalEl.textContent = ark.servers.length;

    var onlineCount = document.getElementById('ark-online-count');
    if(onlineCount){
      var online = ark.servers.filter(function(s){ return !!s.online; }).length;
      onlineCount.textContent = online;
    }

    var mapsEl = document.getElementById('ark-maps-count');
    if(mapsEl){
      var maps = {};
      ark.servers.forEach(function(s){ if(s.map) maps[s.map] = true; });
      var mapCount = Object.keys(maps).length;
      if(mapCount > 0) mapsEl.textContent = mapCount;
    }
  }

  // homepage Palworld/Once Human plates: swap "syncing via..." for a
  // real aggregate count, tint the plate to match the live-ARK look,
  // and drive the "Servers"/"Total slots" stats from the real list too
  // — same reasoning as ARK's stats: these shouldn't need to be
  // remembered and hand-updated as servers are added or removed.
  function renderPlate(game, plateId, syncTextId, serverCountId, slotsId){
    if(!game || !Array.isArray(game.servers) || !game.servers.length) return;
    var current = sumField(game.servers, 'players_current');
    var max = sumField(game.servers, 'players_max');

    var syncEl = document.getElementById(syncTextId);
    if(syncEl) syncEl.textContent = current + ' / ' + max + ' online';

    var plate = document.getElementById(plateId);
    if(plate) plate.classList.add('is-live');

    if(serverCountId){
      var countEl = document.getElementById(serverCountId);
      if(countEl) countEl.textContent = game.servers.length;
    }
    if(slotsId){
      var slotsEl = document.getElementById(slotsId);
      if(slotsEl) slotsEl.textContent = max;
    }
  }

  // per-game pages (games/palworld.html, games/once-human.html): fill
  // in the "Live player counts" spec row, hide the pending notice, and
  // (same reasoning as above) drive Servers/Total slots from the real list
  function renderGamePageStat(ddId, calloutId, game, serverCountId, slotsId){
    if(!game || !Array.isArray(game.servers) || !game.servers.length) return;
    var current = sumField(game.servers, 'players_current');
    var max = sumField(game.servers, 'players_max');

    var dd = document.getElementById(ddId);
    if(dd) dd.textContent = current + ' / ' + max + ' online';

    var callout = document.getElementById(calloutId);
    if(callout) callout.style.display = 'none';

    if(serverCountId){
      var countEl = document.getElementById(serverCountId);
      if(countEl) countEl.textContent = game.servers.length;
    }
    if(slotsId){
      var slotsEl = document.getElementById(slotsId);
      if(slotsEl) slotsEl.textContent = max;
    }
  }

  fetch(STATUS_URL + '?_=' + Date.now(), {cache: 'no-store'})
    .then(function(res){
      if(!res.ok) throw new Error('status.json not reachable (' + res.status + ')');
      return res.json();
    })
    .then(function(data){
      if(!data || !data.servers) return;
      renderArkStats(data.servers.ark);
      renderServerFeed(data.servers.ark, 'ark-feed-body');
      renderServerFeed(data.servers.palworld, 'palworld-feed-body');
      renderPlate(data.servers.palworld, 'palworld-plate', 'palworld-sync-state', 'palworld-total-servers', 'palworld-total-slots');
      renderPlate(data.servers.once_human, 'oncehuman-plate', 'oncehuman-sync-state', 'oncehuman-total-servers', 'oncehuman-total-slots');
      renderGamePageStat('palworld-live-dd', 'palworld-pending-callout', data.servers.palworld, 'palworld-page-total-servers', 'palworld-page-total-slots');
      renderGamePageStat('oncehuman-live-dd', 'oncehuman-pending-callout', data.servers.once_human, 'oncehuman-page-total-servers', 'oncehuman-page-total-slots');
    })
    .catch(function(){
      // status.json isn't up yet (or this is the Cowork preview) —
      // leave every page exactly as it already reads: static and honest.
    });
})();
