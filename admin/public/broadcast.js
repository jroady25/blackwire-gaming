// BlackWire — in-game broadcast and kick, over RCON, through the Worker.
(function () {
  'use strict';

  var BASE = location.pathname.replace(/[^/]*$/, '');
  var $ = function (id) { return document.getElementById(id); };
  var TARGETS = [];
  var NAMES = {};

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(path, options) {
    var opts = options || {};
    return fetch(BASE + path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: Object.assign({ Accept: 'application/json' },
        opts.body ? { 'Content-Type': 'application/json', 'X-BW-Request': '1' } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401) { showGate('Your session expired. Sign in again.'); throw new Error('unauthorized'); }
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  function showGate(msg) {
    $('body').classList.add('hidden');
    $('gate').classList.remove('hidden');
    if (msg) $('gate-msg').textContent = msg;
  }

  function picked() {
    return [].slice.call(document.querySelectorAll('#targets input:checked'))
      .map(function (el) { return el.value; });
  }

  function syncPicked() {
    var n = picked().length;
    $('picked').textContent = n + ' selected';
  }

  function renderTargets() {
    $('targets').innerHTML = TARGETS.map(function (t) {
      NAMES[t.serviceId] = t.name;
      return '<label class="tgt" title="' + esc(t.name + ' — ' + t.address) + '">' +
        '<input type="checkbox" value="' + esc(t.serviceId) + '">' +
        '<span>' + esc(t.name) + '</span></label>';
    }).join('');
    $('roster-server').innerHTML = TARGETS.map(function (t) {
      return '<option value="' + esc(t.serviceId) + '">' + esc(t.name) + '</option>';
    }).join('');
    syncPicked();
  }

  function renderResults(results) {
    $('results').innerHTML = results.map(function (r) {
      var name = NAMES[r.serviceId] || r.serviceId;
      // Show whatever the server said back. ARK usually answers an accepted
      // command with nothing, so any text here is the server complaining.
      var reply = (r.body || '').trim().replace(/\s+/g, ' ').slice(0, 90);
      return '<div class="res"><span>' + esc(name) + '</span>' +
        (r.ok
          ? '<span class="' + (reply ? 'bad' : 'ok') + '">' + esc(reply || 'sent') + '</span>'
          : '<span class="bad">' + esc(r.error || 'failed') + '</span>') +
        '</div>';
    }).join('');
  }

  function send(mode) {
    var ids = picked();
    var message = $('msg').value.trim();
    if (!ids.length) { $('send-note').className = 'note bad'; $('send-note').textContent = 'Pick at least one server first.'; return; }
    if (!message) { $('send-note').className = 'note bad'; $('send-note').textContent = 'Type a message first.'; return; }

    var buttons = [$('send-chat'), $('send-center')];
    buttons.forEach(function (b) { b.disabled = true; });
    $('send-note').className = 'note';
    $('send-note').textContent = 'Sending to ' + ids.length + ' server' + (ids.length > 1 ? 's' : '') + '…';

    api('api/rcon/say', { method: 'POST', body: { serviceIds: ids, message: message, mode: mode } })
      .then(function (data) {
        renderResults(data.results || []);
        var ok = (data.results || []).filter(function (r) { return r.ok; }).length;
        var failed = (data.results || []).length - ok;
        $('send-note').className = 'note' + (failed ? ' warn' : '');
        $('send-note').textContent = 'Sent to ' + ok + ' server' + (ok === 1 ? '' : 's') +
          (failed ? ', ' + failed + ' failed.' : '.') +
          (data.mode === 'center' ? ' Center screen.' : ' In chat.');
      })
      .catch(function (err) {
        if (err.message === 'unauthorized') return;
        $('send-note').className = 'note bad';
        $('send-note').textContent = err.message;
      })
      .finally(function () { buttons.forEach(function (b) { b.disabled = false; }); });
  }

  function renderPlayers(serviceId, players) {
    $('roster-count').textContent = players.length + ' online';
    $('players').innerHTML = players.length
      ? players.map(function (p) {
          return '<div class="pl"><span>' + esc(p.name) + '</span>' +
            '<span class="pid">' + esc(p.id || '—') + '</span>' +
            (p.id
              ? '<button class="btn tiny ghost kick" type="button" data-id="' + esc(p.id) +
                '" data-name="' + esc(p.name) + '" data-service="' + esc(serviceId) + '">Kick</button>'
              : '<span class="pid">no id</span>') +
            '</div>';
        }).join('')
      : '<p class="note">Nobody on this one right now.</p>';
  }

  function loadRoster() {
    var serviceId = $('roster-server').value;
    if (!serviceId) return;
    $('roster-load').disabled = true;
    $('roster-note').className = 'note';
    $('roster-note').textContent = 'Asking the server…';
    api('api/rcon/players?serviceId=' + encodeURIComponent(serviceId))
      .then(function (data) {
        renderPlayers(serviceId, data.players || []);
        $('roster-note').textContent = 'Read straight off the server just now.';
      })
      .catch(function (err) {
        if (err.message === 'unauthorized') return;
        $('players').innerHTML = '';
        $('roster-count').textContent = '';
        $('roster-note').className = 'note bad';
        $('roster-note').textContent = err.message;
      })
      .finally(function () { $('roster-load').disabled = false; });
  }

  // Kick is two-step on purpose: one stray click shouldn't boot someone.
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('button.kick');
    if (!b) return;
    if (b.getAttribute('data-armed') !== '1') {
      [].slice.call(document.querySelectorAll('button.kick[data-armed="1"]')).forEach(function (other) {
        other.removeAttribute('data-armed');
        other.textContent = 'Kick';
        other.className = 'btn tiny ghost kick';
      });
      b.setAttribute('data-armed', '1');
      b.textContent = 'Sure?';
      b.className = 'btn tiny warn kick';
      setTimeout(function () {
        if (b.getAttribute('data-armed') === '1') {
          b.removeAttribute('data-armed');
          b.textContent = 'Kick';
          b.className = 'btn tiny ghost kick';
        }
      }, 4000);
      return;
    }

    b.disabled = true;
    b.textContent = 'Kicking…';
    api('api/rcon/kick', {
      method: 'POST',
      body: {
        serviceId: b.getAttribute('data-service'),
        playerId: b.getAttribute('data-id'),
        playerName: b.getAttribute('data-name'),
      },
    })
      .then(function (data) {
        var r = data.result || {};
        b.textContent = r.ok ? 'Kicked' : 'Failed';
        $('roster-note').className = 'note' + (r.ok ? '' : ' bad');
        $('roster-note').textContent = r.ok
          ? b.getAttribute('data-name') + ' kicked. Logged to the audit trail.'
          : (r.error || 'Kick failed.');
        if (r.ok) setTimeout(loadRoster, 1200);
      })
      .catch(function (err) {
        if (err.message === 'unauthorized') return;
        b.disabled = false;
        b.textContent = 'Kick';
        b.className = 'btn tiny ghost kick';
        $('roster-note').className = 'note bad';
        $('roster-note').textContent = err.message;
      });
  });

  $('msg').addEventListener('input', function () {
    var n = $('msg').value.length;
    $('chars').textContent = n + ' / 240';
    $('chars').className = 'count' + (n >= 240 ? ' over' : '');
  });
  $('targets').addEventListener('change', syncPicked);
  $('all').addEventListener('click', function () {
    [].slice.call(document.querySelectorAll('#targets input')).forEach(function (el) { el.checked = true; });
    syncPicked();
  });
  $('none').addEventListener('click', function () {
    [].slice.call(document.querySelectorAll('#targets input')).forEach(function (el) { el.checked = false; });
    syncPicked();
  });
  $('send-chat').addEventListener('click', function () { send('chat'); });
  $('send-center').addEventListener('click', function () { send('center'); });
  $('roster-load').addEventListener('click', loadRoster);

  api('api/rcon/targets')
    .then(function (data) {
      $('body').classList.remove('hidden');
      TARGETS = data.targets || [];
      renderTargets();
      if (!data.configured) {
        $('unconfigured').classList.remove('hidden');
        $('unconfigured').textContent =
          'ARK_RCON_PASSWORD is not set on the Worker, so nothing here can send yet. ' +
          'Add it in Cloudflare (blackwire-admin → Settings → Variables → add a secret) — it is the same ARK admin password the poller already uses.';
        $('send-chat').disabled = true;
        $('send-center').disabled = true;
        $('roster-load').disabled = true;
      }
      if (!TARGETS.length) {
        $('targets').innerHTML = '<p class="note">No RCON endpoints found in the poller config.</p>';
      }
    })
    .catch(function (err) {
      if (err.message === 'unauthorized') return;
      showGate('Could not load servers: ' + err.message);
    });
})();
