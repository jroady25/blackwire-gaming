// BlackWire — activity page. Reads /api/activity, which is behind the
// same session check as the rest of the panel, and renders the presence
// history the Worker's cron has been folding into KV.
(function () {
  'use strict';

  var BASE = location.pathname.replace(/[^/]*$/, '');
  var $ = function (id) { return document.getElementById(id); };
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var QUIET_DAYS = 7;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function hrs(n) {
    if (n >= 100) return Math.round(n) + 'h';
    return (Math.round(n * 10) / 10) + 'h';
  }

  function shortDate(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function ago(days) {
    if (days === null || days === undefined) return '—';
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    return days + ' days ago';
  }

  function stat(v, k, hot) {
    return '<div class="stat' + (hot ? ' hot' : '') + '"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>';
  }

  function bars(el, rows) {
    var max = rows.reduce(function (m, r) { return Math.max(m, r.value); }, 0) || 1;
    el.innerHTML = rows.map(function (r) {
      var pct = (r.value / max) * 100;
      return '<div class="barrow' + (r.value === max && max > 0 ? ' peak' : '') + '">' +
        '<span title="' + esc(r.label) + '">' + esc(r.short || r.label) + '</span>' +
        '<span class="track"><span class="fill" style="width:' + pct.toFixed(1) + '%"></span></span>' +
        '<span class="n">' + r.display + '</span></div>';
    }).join('');
  }

  function render(a) {
    $('win-range').textContent = a.first
      ? shortDate(a.first) + ' → ' + shortDate(a.lastSampleAt)
      : 'no samples yet';
    $('win-samples').textContent = a.samples ? a.samples + ' samples' : '';

    $('strip').innerHTML =
      stat(a.players.length, 'Players seen', true) +
      stat(hrs(a.playerHours), 'Player-hours') +
      stat(hrs(a.trackedHours), 'Sampled window') +
      stat(a.servers.length, 'Maps with play') +
      stat(a.players.filter(function (p) { return p.daysSince >= QUIET_DAYS; }).length, 'Gone quiet');

    $('players').innerHTML = a.players.length
      ? a.players.map(function (p) {
          return '<tr><td>' + esc(p.name) + '</td>' +
            '<td class="num">' + hrs(p.hours) + '</td>' +
            '<td class="sub">' + (p.home ? esc(p.home) + (p.homeShare < 90 ? ' <span class="faint">' + p.homeShare + '%</span>' : '') : '—') + '</td>' +
            '<td class="num">' + p.servers + '</td>' +
            '<td class="sub">' + ago(p.daysSince) + '</td></tr>';
        }).join('')
      : '<tr><td colspan="5" class="sub">Nothing recorded yet — the first sample lands within 5 minutes of deploy.</td></tr>';

    bars($('hours'), a.hour.map(function (n, h) {
      return {
        label: h + ':00 Eastern',
        short: (h < 10 ? '0' : '') + h + ':00',
        value: n,
        display: hrs(n * a.intervalMin / 60),
      };
    }));

    bars($('dow'), a.dow.map(function (n, i) {
      return { label: DOW[i], short: DOW[i], value: n, display: hrs(n * a.intervalMin / 60) };
    }));

    // Full name here -- the cell ellipsises in CSS, and title= carries the rest.
    bars($('servers'), a.servers.slice(0, 12).map(function (s) {
      return { label: s.name, value: s.samples, display: hrs(s.hours) };
    }));

    var quiet = a.players.filter(function (p) { return p.daysSince >= QUIET_DAYS; });
    $('quiet').innerHTML = quiet.length
      ? quiet.map(function (p) {
          return '<tr><td>' + esc(p.name) + '</td>' +
            '<td class="num">' + hrs(p.hours) + '</td>' +
            '<td class="sub">' + (p.home ? esc(p.home) : '—') + '</td>' +
            '<td class="d' + (p.daysSince >= 30 ? ' far' : '') + '">' + ago(p.daysSince) + '</td></tr>';
        }).join('')
      : '<tr><td colspan="4" class="sub">Nobody has been away ' + QUIET_DAYS + '+ days.</td></tr>';

    $('quiet-note').textContent =
      'Only counts people seen at least once since tracking started, so it is not a full roster of the cluster yet — ' +
      'it gets more useful the longer it runs.';

    $('foot').textContent =
      'Sampled every ' + a.intervalMin + ' minutes from the RCON roster the poller already publishes. ' +
      'Hours are sampled presence, not exact session length, and the sampled window is shorter than wall-clock ' +
      'wherever a poll was missed — a server that is restarting reports nothing rather than reporting empty. ' +
      (a.updated ? 'Last fold ' + shortDate(a.updated) + '.' : '');
  }

  fetch(BASE + 'api/activity', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(function (res) {
      if (res.status === 401) {
        $('gate').classList.remove('hidden');
        return null;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (data) {
      if (!data) return;
      $('body').classList.remove('hidden');
      render(data);
    })
    .catch(function (err) {
      $('gate').classList.remove('hidden');
      $('gate-msg').textContent = 'Could not load activity: ' + err.message;
    });
})();
