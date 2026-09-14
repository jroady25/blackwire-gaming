/* BlackWire Server Control — dashboard front end (no build step, no framework). */

/**
 * Everything is addressed relative to where the page is served from, so the
 * same build works at the root of a workers.dev URL and under /admin on
 * blackwiregaming.com.
 */
const BASE = location.pathname.replace(/[^/]*$/, '');

const state = {
  me: null,
  servers: [],
  clusters: [],
  schedules: [],
  selected: new Set(),
  pending: new Set(),
  dialog: null,
  loading: false,
  pollTimer: null,
  lastFetched: null,
  serverClockOffset: 0
};

const DELAYS = [0, 1, 5, 10, 15, 30, 60];
const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- */
/* API helpers                                                       */
/* ---------------------------------------------------------------- */

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'X-BW-Request': '1',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.me?.authed) {
    state.me = { ...state.me, authed: false };
    stopPolling();
    render();
  }
  return { ok: res.ok, status: res.status, data };
}

/* ---------------------------------------------------------------- */
/* Small helpers                                                     */
/* ---------------------------------------------------------------- */

function toast(text, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  el.onclick = () => el.remove();
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 6500);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  );
}

function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Worker clock, so countdowns are right even if the viewer's clock is off. */
function serverNow() {
  return Date.now() + state.serverClockOffset;
}

function scheduleFor(serviceId) {
  return state.schedules.find((job) => job.serviceIds.includes(serviceId)) || null;
}

/* ---------------------------------------------------------------- */
/* Rendering                                                         */
/* ---------------------------------------------------------------- */

function renderLogin() {
  $('login-view').classList.remove('hidden');
  $('app-view').classList.add('hidden');

  $('discord-btn').href = `${BASE}auth/discord`;
  $('discord-btn').classList.toggle('hidden', !state.me?.discordEnabled);
  $('password-form').classList.toggle('hidden', !state.me?.passwordEnabled);
  $('login-divider').classList.toggle('hidden', !(state.me?.discordEnabled && state.me?.passwordEnabled));

  const params = new URLSearchParams(location.search);
  if (params.get('error')) {
    showLoginError(params.get('error'));
    history.replaceState({}, '', location.pathname);
  }

  if (!state.me?.discordEnabled && !state.me?.passwordEnabled) {
    showLoginError('No sign-in method configured. Set ADMIN_PASSWORD or the Discord secrets.');
  }
}

function showLoginError(text) {
  const box = $('login-error');
  box.textContent = text;
  box.classList.remove('hidden');
}

function renderStatusbar() {
  const online = state.servers.filter((server) => server.tone === 'online').length;
  const players = state.servers.reduce((sum, server) => sum + (server.players?.current || 0), 0);
  const down = state.servers.filter((server) => server.tone === 'offline').length;

  const bits = [
    `Network: <span class="val">BlackWire</span>`,
    `Nodes: <span class="ok">${online}/${state.servers.length} online</span>${
      down ? ` <span class="sep">//</span> <span class="val">${down} down</span>` : ''
    }`,
    `Players: <span class="val">${players}</span>`,
    `Operator: <span class="val">${escapeHtml(state.me?.user || '—')}</span>`,
    `Sync: <span class="val">${state.lastFetched ? new Date(state.lastFetched).toLocaleTimeString() : '—'}</span>`
  ];

  $('statusbar').innerHTML = bits.join(' <span class="sep">//</span> ');
}

function clustersInOrder() {
  const declared = state.clusters.filter((name) =>
    state.servers.some((server) => server.cluster === name)
  );
  const rest = [...new Set(state.servers.map((server) => server.cluster))]
    .filter((name) => !declared.includes(name))
    .sort();
  return [...declared, ...rest];
}

const serversIn = (cluster) => state.servers.filter((server) => server.cluster === cluster);

function renderCards() {
  const grid = $('grid');

  if (!state.servers.length) {
    grid.innerHTML = state.loading
      ? '<div class="empty">Querying Nitrado...</div>'
      : '<div class="empty">No game servers found.</div>';
    return;
  }

  const clusters = clustersInOrder();
  grid.innerHTML = clusters
    .map((cluster) => {
      const list = serversIn(cluster);
      const online = list.filter((server) => server.tone === 'online').length;
      const players = list.reduce((sum, server) => sum + (server.players?.current || 0), 0);
      const allSelected = list.every((server) => state.selected.has(server.serviceId));
      const key = encodeURIComponent(cluster);

      return `
        <section class="cluster">
          <div class="cluster-head">
            <button class="cluster-name${allSelected ? ' is-selected' : ''}" data-cluster="${key}"
                    title="${allSelected ? 'Clear' : 'Select'} every server in this cluster">
              <span class="box"></span>${escapeHtml(cluster)}
            </button>
            <span class="plate-tag">${list.length} server${list.length === 1 ? '' : 's'} · ${online} online · ${players} player${players === 1 ? '' : 's'}</span>
            <div class="cluster-actions">
              <button class="btn tiny" data-cluster-act="start" data-cluster="${key}">Start</button>
              <button class="btn tiny warn" data-cluster-act="stop" data-cluster="${key}">Stop</button>
              <button class="btn tiny primary" data-cluster-act="restart" data-cluster="${key}">Restart</button>
            </div>
          </div>
          <div class="cards">${renderCardList(list)}</div>
        </section>`;
    })
    .join('');
}

function renderCardList(servers) {
  return servers
    .map((server) => {
      const job = scheduleFor(server.serviceId);
      const busy = state.pending.has(server.serviceId);
      const canStart = server.tone === 'offline';
      const canStop = server.tone === 'online' || server.tone === 'busy';

      const current = server.players?.current;
      const max = server.players?.max;
      const pct = current !== null && current !== undefined && max ? Math.min(100, (current / max) * 100) : 0;
      const players =
        current === null || current === undefined
          ? '<span class="faint">-- players</span>'
          : `<span class="players"><strong>${current}</strong> / ${max || '?'} players${
              max ? `<span class="cap-bar"><span style="width:${pct}%"></span></span>` : ''
            }</span>`;

      return `
        <article class="card${state.selected.has(server.serviceId) ? ' selected' : ''}">
          <div class="card-head">
            <label class="checkbox">
              <input type="checkbox" data-select="${server.serviceId}" ${
                state.selected.has(server.serviceId) ? 'checked' : ''
              } />
            </label>
            <div class="card-title">
              <div class="name" title="${escapeHtml(server.name)}">${escapeHtml(server.name)}</div>
              <div class="sub">${escapeHtml(server.gameHuman || server.game || 'Game server')}${
                server.address ? ` · ${escapeHtml(server.address)}` : ''
              }</div>
            </div>
            <div class="status status-${server.tone}"><span class="dot"></span>${escapeHtml(server.label)}</div>
          </div>

          ${server.error ? `<div class="error-box small">${escapeHtml(server.error)}</div>` : ''}

          ${
            job
              ? `<div class="countdown" data-countdown="${job.id}" data-fire="${job.fireAt}">
                   ${job.action} in <strong>${clock(job.fireAt - serverNow())}</strong>
                   <button class="btn tiny ghost" data-cancel="${job.id}">Cancel</button>
                 </div>`
              : ''
          }

          <div class="card-meta">${players}<span class="faint">#${server.serviceId}</span></div>

          <div class="card-actions">
            <button class="btn" data-act="start" data-id="${server.serviceId}" ${
              busy || !canStart ? 'disabled' : ''
            }>Start</button>
            <button class="btn warn" data-act="stop" data-id="${server.serviceId}" ${
              busy || !canStop ? 'disabled' : ''
            }>Stop</button>
            <button class="btn primary" data-act="restart" data-id="${server.serviceId}" ${
              busy || server.tone === 'warn' ? 'disabled' : ''
            }>Restart</button>
          </div>
        </article>`;
    })
    .join('');
}

function renderScheduleBanner() {
  const banner = $('schedule-banner');
  if (!state.schedules.length) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  banner.innerHTML = state.schedules
    .map(
      (job) => `<div class="schedule-row" data-countdown="${job.id}" data-fire="${job.fireAt}">
        <span class="tag">Scheduled</span>
        ${job.action} · ${job.serviceIds.length} server${job.serviceIds.length === 1 ? '' : 's'} ·
        <strong>${clock(job.fireAt - serverNow())}</strong>
        <span class="faint">by ${escapeHtml(job.createdBy)}</span>
        <button class="btn tiny ghost" data-cancel="${job.id}">Cancel</button>
      </div>`
    )
    .join('');
}

function renderSelection() {
  const count = state.selected.size;
  $('selection-note').textContent = count
    ? `${count} selected`
    : 'Nothing selected // actions apply to all servers';
  $('select-all').textContent = count === state.servers.length && count ? 'Clear' : 'Select all';
}

function render() {
  if (!state.me) return;
  if (!state.me.authed) return renderLogin();

  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  renderStatusbar();
  renderScheduleBanner();
  renderSelection();
  renderCards();
}

/* ---------------------------------------------------------------- */
/* Data                                                              */
/* ---------------------------------------------------------------- */

async function loadServers({ force = false, silent = false } = {}) {
  if (!silent) {
    state.loading = true;
    $('refresh-btn').textContent = 'Syncing';
  }

  const { ok, data } = await api(`api/servers${force ? '?force=1' : ''}`);
  state.loading = false;
  $('refresh-btn').textContent = 'Refresh';

  if (!ok) {
    const box = $('list-error');
    box.textContent = data.error || 'Could not load servers.';
    box.classList.remove('hidden');
    return;
  }

  $('list-error').classList.add('hidden');
  state.servers = data.servers || [];
  state.clusters = data.clusters || [];
  state.schedules = data.schedules || [];
  state.lastFetched = data.fetchedAt || Date.now();
  state.serverClockOffset = (data.now || Date.now()) - Date.now();

  if (data.staleError) toast(`Showing cached status: ${data.staleError}`, 'warn');
  render();
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => loadServers({ silent: true }), 30000);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

/* ---------------------------------------------------------------- */
/* Actions                                                           */
/* ---------------------------------------------------------------- */

function targetsFor(explicitId) {
  if (explicitId) return [Number(explicitId)];
  if (state.selected.size) return [...state.selected];
  return state.servers.map((server) => server.serviceId);
}

function openDialog(action, serviceIds) {
  if (!serviceIds.length) return toast('No servers to act on.', 'warn');

  const names = serviceIds.map(
    (id) => state.servers.find((server) => server.serviceId === id)?.name || `#${id}`
  );
  state.dialog = { action, serviceIds, names, delay: 0 };

  const verb = action.charAt(0).toUpperCase() + action.slice(1);
  $('dialog-title').textContent =
    serviceIds.length === 1 ? verb : `${verb} ${serviceIds.length} servers`;
  $('dialog-targets').textContent =
    serviceIds.length === 1
      ? names[0]
      : `${names.slice(0, 3).join(' · ')}${serviceIds.length > 3 ? ` +${serviceIds.length - 3} more` : ''}`;

  $('message-field').classList.toggle('hidden', action === 'start');
  $('dialog-message').value =
    action === 'stop' ? 'Server shutting down.' : 'Server restarting - back in a few minutes.';

  $('delay-chips').innerHTML = DELAYS.map(
    (minutes) =>
      `<button type="button" class="chip${minutes === 0 ? ' active' : ''}" data-delay="${minutes}">${
        minutes === 0 ? 'Now' : `${minutes} min`
      }</button>`
  ).join('');
  $('delay-note').textContent = '';
  $('dialog-confirm').textContent = verb;
  $('dialog').classList.remove('hidden');
}

function closeDialog() {
  state.dialog = null;
  $('dialog').classList.add('hidden');
}

async function confirmDialog() {
  const request = state.dialog;
  if (!request) return;
  closeDialog();

  const message = $('dialog-message').value;
  request.serviceIds.forEach((id) => state.pending.add(id));
  render();

  const { ok, data } = await api('api/action', {
    method: 'POST',
    body: JSON.stringify({
      action: request.action,
      serviceIds: request.serviceIds,
      names: request.names,
      message: request.action === 'start' ? '' : message,
      delayMinutes: request.delay
    })
  });

  request.serviceIds.forEach((id) => state.pending.delete(id));
  const count = request.serviceIds.length;
  const plural = count === 1 ? '' : 's';

  if (!ok) {
    toast(data.error || 'That did not work.', 'error');
    render();
    return;
  }

  if (data.scheduled) {
    toast(`${request.action} scheduled for ${count} server${plural}.`, 'info');
  } else {
    const failed = (data.results || []).filter((result) => !result.ok);
    if (!failed.length) toast(`${request.action} sent to ${count} server${plural}.`, 'ok');
    else if (failed.length === data.results.length) toast(`Failed: ${failed[0].error}`, 'error');
    else toast(`${data.results.length - failed.length} ok, ${failed.length} failed.`, 'warn');
  }

  await loadServers({ force: true, silent: true });
  setTimeout(() => loadServers({ force: true, silent: true }), 5000);
}

async function cancelSchedule(id) {
  const { ok, data } = await api(`api/schedules/${id}`, { method: 'DELETE' });
  toast(ok ? 'Scheduled action cancelled.' : data.error || 'Could not cancel.', ok ? 'ok' : 'error');
  loadServers({ silent: true });
}

/* ---------------------------------------------------------------- */
/* Events                                                            */
/* ---------------------------------------------------------------- */

document.addEventListener('click', (event) => {
  const target = event.target.closest(
    '[data-act], [data-bulk], [data-cancel], [data-delay], [data-cluster]'
  );
  if (!target) return;

  // Cluster row: the buttons act on the whole cluster, the name toggles its selection.
  if (target.dataset.cluster) {
    const cluster = decodeURIComponent(target.dataset.cluster);
    const ids = serversIn(cluster).map((server) => server.serviceId);

    if (target.dataset.clusterAct) {
      openDialog(target.dataset.clusterAct, ids);
    } else {
      const allSelected = ids.every((id) => state.selected.has(id));
      ids.forEach((id) => (allSelected ? state.selected.delete(id) : state.selected.add(id)));
      render();
    }
    return;
  }

  if (target.dataset.act) {
    openDialog(target.dataset.act, targetsFor(target.dataset.id));
  } else if (target.dataset.bulk) {
    openDialog(target.dataset.bulk, targetsFor());
  } else if (target.dataset.cancel) {
    cancelSchedule(target.dataset.cancel);
  } else if (target.dataset.delay !== undefined) {
    state.dialog.delay = Number(target.dataset.delay);
    document.querySelectorAll('#delay-chips .chip').forEach((chip) => {
      chip.classList.toggle('active', Number(chip.dataset.delay) === state.dialog.delay);
    });
    $('delay-note').textContent = state.dialog.delay
      ? 'Runs on the server — you can close this page and it will still happen.'
      : '';
    const verb = state.dialog.action.charAt(0).toUpperCase() + state.dialog.action.slice(1);
    $('dialog-confirm').textContent = state.dialog.delay ? `Schedule ${state.dialog.delay} min` : verb;
  }
});

document.addEventListener('change', (event) => {
  const id = event.target.dataset?.select;
  if (!id) return;
  const serviceId = Number(id);
  if (state.selected.has(serviceId)) state.selected.delete(serviceId);
  else state.selected.add(serviceId);
  render();
});

$('select-all').onclick = () => {
  if (state.selected.size === state.servers.length) state.selected.clear();
  else state.servers.forEach((server) => state.selected.add(server.serviceId));
  render();
};

$('refresh-btn').onclick = () => loadServers({ force: true });
$('dialog-cancel').onclick = closeDialog;
$('dialog-confirm').onclick = confirmDialog;
$('dialog').onclick = (event) => {
  if (event.target.id === 'dialog') closeDialog();
};

$('audit-btn').onclick = async () => {
  const { ok, data } = await api('api/audit');
  $('audit-list').innerHTML =
    ok && data.entries?.length
      ? data.entries
          .map(
            (entry) => `<div class="audit-row">
              <div class="when">${new Date(entry.at).toLocaleString()}</div>
              <div><strong>${escapeHtml(entry.actor)}</strong> ${escapeHtml(entry.action)}${
                entry.serviceIds?.length ? ` · ${entry.serviceIds.length} server(s)` : ''
              }${entry.failed ? ` · <span class="fail">${entry.failed} failed</span>` : ''}</div>
            </div>`
          )
          .join('')
      : '<p class="faint">Nothing logged yet.</p>';
  $('audit').classList.remove('hidden');
};
$('audit-close').onclick = () => $('audit').classList.add('hidden');
$('audit').onclick = (event) => {
  if (event.target.id === 'audit') $('audit').classList.add('hidden');
};

$('logout-btn').onclick = async () => {
  await api('api/logout', { method: 'POST' });
  stopPolling();
  state.me = { ...state.me, authed: false, user: null };
  state.servers = [];
  state.selected.clear();
  render();
};

$('password-form').onsubmit = async (event) => {
  event.preventDefault();
  $('login-error').classList.add('hidden');
  const { ok, data } = await api('api/login', {
    method: 'POST',
    body: JSON.stringify({ password: $('admin-password').value, name: $('admin-name').value })
  });
  if (!ok) return showLoginError(data.error || 'Sign-in failed.');
  $('admin-password').value = '';
  await boot();
};

// Countdown ticker — updates the numbers without re-rendering the grid.
setInterval(() => {
  document.querySelectorAll('[data-countdown]').forEach((el) => {
    const remaining = Number(el.dataset.fire) - serverNow();
    const strong = el.querySelector('strong');
    if (strong) strong.textContent = clock(remaining);
    if (remaining <= -3000) loadServers({ silent: true });
  });
}, 1000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.me?.authed) loadServers({ silent: true });
});

/* ---------------------------------------------------------------- */
/* Boot                                                              */
/* ---------------------------------------------------------------- */

async function boot() {
  const { data } = await api('api/me');
  state.me = data;
  render();
  if (data.authed) {
    await loadServers();
    startPolling();
  }
}

boot();
