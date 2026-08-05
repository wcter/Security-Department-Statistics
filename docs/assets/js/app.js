/* ==========================================================================
   Group Intelligence Dashboard — application logic
   ========================================================================== */
(function () {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /* ---------------------------------------------------------------- format */

  const fmt = window.fmt = {
    num: (n) => (n == null ? '—' : Number(n).toLocaleString()),
    compact: (n) => {
      if (n == null) return '—';
      const a = Math.abs(n);
      if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
      if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
      return String(Math.round(n));
    },
    dec: (n, d = 1) => (n == null || !isFinite(n) ? '—' : Number(n).toFixed(d)),
    days: (d) => {
      if (d == null || !isFinite(d)) return '—';
      if (d < 1) return `${Math.round(d * 24)}h`;
      if (d < 60) return `${Math.round(d)}d`;
      if (d < 730) return `${(d / 30.44).toFixed(1)}mo`;
      return `${(d / 365.25).toFixed(1)}y`;
    },
    dateShort: (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    date: (t) => (t == null ? '—' : new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })),
    dateTime: (t) => (t == null ? '—' : new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
    ago: (t) => {
      const s = (Date.now() - t) / 1000;
      if (s < 60) return 'just now';
      if (s < 3600) return `${Math.floor(s / 60)}m ago`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
      if (s < 2592000) return `${Math.floor(s / 86400)}d ago`;
      return fmt.date(t);
    },
    statusLabel: (s) => ({
      'on-track': 'On track', due: 'Due', overdue: 'Overdue', stalled: 'Stalled',
      'top-rank': 'Top rank', 'insufficient-data': 'No data yet',
    }[s] || s),
    avatar: (id, size = 48) =>
      `https://www.roblox.com/headshot-thumbnail/image?userId=${id}&width=${size}&height=${size}&format=png`,
  };

  const AVATAR_FALLBACK =
    "this.onerror=null;this.src='data:image/svg+xml,\\u003Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22%3E%3Crect width=%2240%22 height=%2240%22 fill=%22%23263049%22/%3E%3Ccircle cx=%2220%22 cy=%2216%22 r=%226%22 fill=%22%235f6a84%22/%3E%3Cpath d=%22M8 38a12 12 0 0124 0z%22 fill=%22%235f6a84%22/%3E%3C/svg%3E'";

  const avatarImg = (id, cls = 'avatar sm') =>
    `<img class="${cls}" src="${fmt.avatar(id)}" alt="" loading="lazy" decoding="async" onerror="${AVATAR_FALLBACK}">`;

  /* ----------------------------------------------------------------- state */

  const S = {
    meta: null, overview: null, boards: null, events: null, timing: null,
    members: [],            // decoded row objects
    roleByTier: new Map(),
    view: 'overview',
    shardCache: new Map(),
    roster: { sort: 'tier', dir: -1, q: '', rank: '', status: '', membership: 'active', rows: [] },
    eventFilter: '', eventsShown: 60,
  };

  const COL = {
    id: 0, u: 1, d: 2, tier: 3, trackedSince: 4, inRankSince: 5, daysInRank: 6,
    promotions: 7, demotions: 8, velocity: 9, avgDaysPerPromotion: 10,
    readiness: 11, status: 12, accountCreated: 13, departed: 14, boot: 15,
    likelyDays: 16, tiersClimbed: 17,
  };

  async function getJSON(path) {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  /* ------------------------------------------------------------------ boot */

  async function boot() {
    let meta;
    try {
      meta = await getJSON('data/meta.json');
    } catch {
      return showEmpty('Could not load <code>data/meta.json</code>. Has the collector run yet?');
    }
    S.meta = meta;

    document.title = `${meta.title} — Group Stats`;
    $('#site-title').textContent = meta.title;
    $('#site-subtitle').textContent = meta.subtitle || '';

    if (!meta.ready) return showEmpty(meta.message);
    if (meta.awaitingRoster) $('#awaiting-banner').classList.remove('hidden');

    const [overview, membersRaw, boards, events, timing] = await Promise.all([
      getJSON('data/overview.json'),
      getJSON('data/members.json'),
      getJSON('data/leaderboards.json'),
      getJSON('data/events.json'),
      getJSON('data/timing.json'),
    ]);

    S.overview = overview;
    S.boards = boards;
    S.events = events;
    S.timing = timing;
    S.statuses = membersRaw.statuses;
    S.members = membersRaw.rows;
    meta.roles.forEach((r) => S.roleByTier.set(r.tier, r));

    $('#main').hidden = false;
    $('#last-updated').textContent = fmt.ago(meta.generatedAt);
    $('#foot-stats').innerHTML =
      `${fmt.num(meta.snapshotCount)} snapshots · ${fmt.num(meta.trackedMembers)} members indexed · ` +
      `tracking since ${fmt.date(meta.trackingSince)} (${fmt.days(meta.trackedDays)})`;

    wireNav();
    renderOverview();
    renderRoster();
    renderPromotions();
    renderRanks();
    renderBoards();
  }

  function showEmpty(msg) {
    $('#empty-state').classList.remove('hidden');
    if (msg) $('#empty-message').innerHTML = msg;
  }

  function wireNav() {
    $$('#tabs .tab').forEach((btn) => btn.addEventListener('click', () => go(btn.dataset.view)));
    $$('[data-goto]').forEach((btn) => btn.addEventListener('click', () => go(btn.dataset.goto)));
    window.addEventListener('hashchange', () => {
      const v = location.hash.slice(1);
      if (v && v !== S.view) go(v, true);
    });
    const initial = location.hash.slice(1);
    if (initial && $(`#view-${initial}`)) go(initial, true);
  }

  function go(view, skipHash) {
    if (!$(`#view-${view}`)) return;
    S.view = view;
    $$('#tabs .tab').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
    $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${view}`));
    if (!skipHash) location.hash = view;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* -------------------------------------------------------------- OVERVIEW */

  function renderOverview() {
    const k = S.overview.kpis;

    const kpis = [
      { label: 'Group members', value: fmt.num(k.members), sub: `${fmt.num(k.tracked)} individually tracked`, color: 'var(--accent)' },
      { label: 'Promotions · 30d', value: fmt.num(k.promotions30d), sub: `${fmt.num(k.promotions7d)} in the last 7 days`, color: 'var(--good)' },
      {
        label: 'Net growth · 30d',
        value: (k.netGrowth30d >= 0 ? '+' : '') + fmt.num(k.netGrowth30d),
        sub: `<span class="up">+${fmt.num(k.joins30d)} joined</span> · <span class="down">−${fmt.num(k.leaves30d)} left</span>`,
        color: k.netGrowth30d >= 0 ? 'var(--accent-2)' : 'var(--bad)',
      },
      { label: 'Median ascension', value: fmt.dec(k.medianVelocity, 2), sub: 'ranks climbed per year', color: 'var(--violet)' },
      { label: 'Due for promotion', value: fmt.num(k.dueForPromotion), sub: 'past their rank’s median wait', color: 'var(--warn)' },
      { label: 'Stalled', value: fmt.num(k.stalled), sub: 'beyond the 90th percentile', color: 'var(--bad)' },
      { label: 'Avg gap', value: fmt.days(k.avgDaysPerPromotion), sub: 'between promotions', color: 'var(--accent-2)' },
      { label: 'Movement rate', value: `${fmt.dec(k.promotionRate30d, 1)}%`, sub: 'of roster promoted in 30d', color: 'var(--good)' },
    ];

    $('#kpis').innerHTML = kpis.map((x) => `
      <div class="kpi" style="--kpi-color:${x.color}">
        <div class="kpi-label">${x.label}</div>
        <div class="kpi-value">${x.value}</div>
        <div class="kpi-sub">${x.sub}</div>
      </div>`).join('');

    drawGrowth(180);
    $$('#growth-range button').forEach((b) => b.addEventListener('click', () => {
      $$('#growth-range button').forEach((o) => o.classList.toggle('is-active', o === b));
      drawGrowth(Number(b.dataset.days));
    }));

    // Promotion outlook donut + legend
    const mix = S.overview.predictionMix.filter((m) => m.count > 0);
    Charts.mix('chart-mix', mix);
    const colors = {
      'on-track': Charts.C.good, due: Charts.C.warn, overdue: Charts.C.hot,
      stalled: Charts.C.bad, 'top-rank': Charts.C.violet, 'insufficient-data': '#4b5568',
    };
    const total = mix.reduce((a, m) => a + m.count, 0) || 1;
    $('#mix-legend').innerHTML = mix.map((m) => `
      <span><i style="background:${colors[m.status]}"></i>${fmt.statusLabel(m.status)}
        <b>${Math.round((m.count / total) * 100)}%</b></span>`).join('');

    renderPyramid();
    drawActivity();
    renderFeed();
    if (S.boards.fastestRisers.length) {
      renderMiniBoard('#quick-risers', S.boards.fastestRisers.slice(0, 8),
        (m) => `${fmt.dec(m.v, 2)}`, 'ranks/yr');
    } else {
      $('#quick-risers').innerHTML = awaitingNote('Ascension speed needs at least two snapshots showing the same member at different ranks.');
    }
  }

  function drawGrowth(days) {
    let pts = S.overview.growth;
    if (days > 0) {
      const cut = Date.now() - days * 86400000;
      const win = pts.filter((p) => p.t >= cut);
      if (win.length > 1) pts = win;
    }
    // Keep the canvas readable regardless of snapshot density.
    const MAX = 160;
    if (pts.length > MAX) {
      const step = Math.ceil(pts.length / MAX);
      pts = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
    }
    Charts.growth('chart-growth', pts);
  }

  /** Ladder roles worth showing: the phantom base role never appears. */
  function displayRoles(list) {
    return list.filter((d) => !d.base);
  }

  function renderPyramid() {
    const awaiting = S.meta.awaitingRoster;
    const dist = displayRoles([...S.overview.rankDistribution]).reverse();
    // Before the first snapshot, fall back to the group API's own headcounts.
    const countOf = (d) => (awaiting ? (d.apiCount ?? 0) : d.count);
    const max = Math.max(1, ...dist.map(countOf));

    $('#pyramid').innerHTML = dist.map((d) => {
      if (d.divider) {
        return `<div class="pyr-row is-divider" title="Cosmetic spacer role">
          <div class="pyr-name">${esc(d.name)}</div>
          <div class="pyr-track"></div>
          <div class="pyr-num">${fmt.num(countOf(d))}</div>
        </div>`;
      }
      const n = countOf(d);
      const tip = d.medianTimeToPromote != null
        ? `${d.name} — median ${fmt.days(d.medianTimeToPromote)} before promotion`
        : `${d.name} — promotion timing not established yet`;
      return `<div class="pyr-row" title="${esc(tip)}">
        <div class="pyr-name">${esc(d.name)}</div>
        <div class="pyr-track">
          <div class="pyr-fill" style="width:${(n / max) * 100}%"></div>
          <div class="pyr-due" style="width:${(d.dueNow / max) * 100}%" title="${d.dueNow} due or overdue"></div>
        </div>
        <div class="pyr-num ${awaiting ? 'pyr-est' : ''}">${fmt.num(n)}</div>
      </div>`;
    }).join('');
  }

  function drawActivity() {
    const c = S.overview.churn;
    const keys = new Set();
    ['promotions', 'joins', 'leaves'].forEach((k) => c[k].forEach((p) => keys.add(p.t)));
    const daysAxis = [...keys].sort((a, b) => a - b).slice(-45);
    const lookup = (arr) => {
      const m = new Map(arr.map((p) => [p.t, p.n]));
      return daysAxis.map((t) => m.get(t) || 0);
    };
    Charts.activity('chart-activity', {
      labels: daysAxis.map((t) => fmt.dateShort(t)),
      promotions: lookup(c.promotions),
      joins: lookup(c.joins),
      leaves: lookup(c.leaves),
    });
  }

  function awaitingNote(msg) {
    return `<p class="muted small" style="padding:18px 2px">${msg}</p>`;
  }

  function renderFeed() {
    const rows = S.events.events.slice(0, 40);
    if (!rows.length) {
      $('#recent-feed').innerHTML = awaitingNote('No membership changes recorded yet. The collector logs every join, promotion, demotion and departure it observes between snapshots.');
      return;
    }
    $('#recent-feed').innerHTML = rows.map((e) => `
      <div class="feed-row" data-id="${e.id}">
        ${avatarImg(e.id)}
        <div class="feed-txt">
          <b>${esc(e.u)}</b>
          ${e.type === 'promote' || e.type === 'demote' || e.type === 'lateral'
            ? `<br><span class="muted">${esc(e.fromName || '?')}</span><span class="arrow">→</span><span>${esc(e.toName || '?')}</span>`
            : `<br><span class="muted">${eventPhrase(e)}</span>`}
        </div>
        <div style="text-align:right">
          <span class="pill ${e.type}">${e.type}</span>
          <div class="feed-time">${fmt.ago(e.t)}</div>
        </div>
      </div>`).join('');
    bindMemberClicks('#recent-feed');
  }

  function eventPhrase(e) {
    if (e.type === 'join') return `joined as ${esc(e.toName || 'member')}`;
    if (e.type === 'leave') return `left from ${esc(e.fromName || 'the group')}`;
    if (e.type === 'rejoin') return `rejoined as ${esc(e.toName || 'member')}`;
    if (e.type === 'rename') return `renamed from ${esc(e.from)}`;
    return '';
  }

  function renderMiniBoard(sel, list, metric, unit) {
    $(sel).innerHTML = list.map((m, i) => `
      <div class="mt-row" data-id="${m.id}">
        <div class="mt-rank">${i + 1}</div>
        ${avatarImg(m.id, 'avatar sm')}
        <div class="mt-name"><b>${esc(m.u)}</b><span>${esc(m.role)}</span></div>
        <div class="mt-metric">${metric(m)}</div>
        <div class="mt-unit">${unit}</div>
      </div>`).join('');
    bindMemberClicks(sel);
  }

  function bindMemberClicks(sel) {
    $$(`${sel} [data-id]`).forEach((n) =>
      n.addEventListener('click', () => openMember(Number(n.dataset.id))));
  }

  /* ---------------------------------------------------------------- ROSTER */

  const COLUMNS = [
    { key: '_idx',        label: '#',        num: false, sortable: false },
    { key: 'u',           label: 'Member',   num: false },
    { key: 'tier',        label: 'Rank',     num: false },
    { key: 'daysInRank',  label: 'In rank',  num: true },
    { key: 'promotions',  label: 'Promos',   num: true },
    { key: 'velocity',    label: 'Ranks/yr', num: true },
    { key: 'likelyDays',  label: 'Next promotion', num: false },
    { key: 'status',      label: 'Status',   num: false },
  ];

  function renderRoster() {
    const sel = $('#filter-rank');
    S.meta.roles.filter((r) => !r.base).slice().reverse().forEach((r) => {
      const o = el('option');
      o.value = r.tier; o.textContent = r.name;
      sel.appendChild(o);
    });

    $('#roster-head').innerHTML = COLUMNS.map((c) =>
      `<div class="th ${c.num ? 'num' : ''}" data-key="${c.key}">${c.label}<span class="caret"></span></div>`).join('');

    $$('#roster-head .th').forEach((th) => {
      const col = COLUMNS.find((c) => c.key === th.dataset.key);
      if (col && col.sortable === false) return;
      th.addEventListener('click', () => {
        const key = th.dataset.key;
        if (S.roster.sort === key) S.roster.dir *= -1;
        else { S.roster.sort = key; S.roster.dir = -1; }
        applyRoster();
      });
    });

    let timer;
    $('#roster-search').addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => { S.roster.q = e.target.value.trim().toLowerCase(); applyRoster(); }, 130);
    });
    $('#filter-rank').addEventListener('change', (e) => { S.roster.rank = e.target.value; applyRoster(); });
    $('#filter-status').addEventListener('change', (e) => { S.roster.status = e.target.value; applyRoster(); });
    $('#filter-membership').addEventListener('change', (e) => { S.roster.membership = e.target.value; applyRoster(); });
    $('#roster-body').addEventListener('scroll', paintRows, { passive: true });

    applyRoster();
  }

  function applyRoster() {
    const { q, rank, status, membership, sort, dir } = S.roster;
    const statusIdx = status ? S.statuses.indexOf(status) : -2;

    let rows = S.members.filter((r) => {
      if (membership === 'active' && r[COL.departed]) return false;
      if (membership === 'departed' && !r[COL.departed]) return false;
      if (rank !== '' && r[COL.tier] !== Number(rank)) return false;
      if (status && r[COL.status] !== statusIdx) return false;
      if (q) {
        const u = r[COL.u].toLowerCase();
        const d = r[COL.d] ? String(r[COL.d]).toLowerCase() : '';
        if (!u.includes(q) && !d.includes(q)) return false;
      }
      return true;
    });

    const idx = COL[sort] ?? COL.tier;
    const numeric = sort !== 'u';
    rows.sort((a, b) => {
      let x = a[idx], y = b[idx];
      if (numeric) {
        x = x == null ? -Infinity : x; y = y == null ? -Infinity : y;
        if (x !== y) return (x - y) * dir;
        // Deterministic tiebreak keeps scroll position stable across re-sorts.
        return b[COL.velocity] - a[COL.velocity];
      }
      return String(x).localeCompare(String(y)) * dir;
    });

    S.roster.rows = rows;
    $('#roster-count').textContent =
      `${fmt.num(rows.length)} of ${fmt.num(S.members.length)} members`;

    $$('#roster-head .th').forEach((th) => {
      const on = th.dataset.key === sort;
      th.classList.toggle('is-sorted', on);
      th.querySelector('.caret').textContent = on ? (dir === -1 ? '▼' : '▲') : '';
    });

    $('#roster-spacer').style.height = `${rows.length * 54}px`;
    $('#roster-body').scrollTop = 0;
    paintRows();
  }

  function paintRows() {
    const body = $('#roster-body');
    const rows = S.roster.rows;
    const H = 54;
    const start = Math.max(0, Math.floor(body.scrollTop / H) - 6);
    const visible = Math.ceil(body.clientHeight / H) + 12;
    const slice = rows.slice(start, start + visible);

    const container = $('#roster-rows');
    container.style.transform = `translateY(${start * H}px)`;
    container.innerHTML = slice.map((r, i) => rowHTML(r, start + i + 1)).join('');
    $$('#roster-rows .trow').forEach((n) =>
      n.addEventListener('click', () => openMember(Number(n.dataset.id))));
  }

  function rowHTML(r, n) {
    const role = S.roleByTier.get(r[COL.tier]);
    const status = S.statuses[r[COL.status]] || 'insufficient-data';
    const display = r[COL.d] || r[COL.u];
    const readiness = r[COL.readiness];
    const likely = r[COL.likelyDays];

    let windowCell;
    if (status === 'top-rank') {
      windowCell = '<span class="muted small">Highest rank</span>';
    } else if (status === 'insufficient-data') {
      windowCell = '<span class="muted small">Gathering data</span>';
    } else {
      const label = likely == null ? '—' : likely <= 0.5 ? 'Due now' : `~${fmt.days(likely)}`;
      windowCell = `<div><span class="small">${label}</span>
        <div class="bar-mini"><i style="width:${Math.min(100, readiness ?? 0)}%"></i></div></div>`;
    }

    return `<div class="trow ${r[COL.departed] ? 'departed' : ''}" data-id="${r[COL.id]}">
      <div class="cell-idx">${n}</div>
      <div class="cell-user">
        ${avatarImg(r[COL.id], 'avatar')}
        <div><b>${esc(r[COL.u])}</b><span>${esc(display === r[COL.u] ? `#${r[COL.id]}` : display)}</span></div>
      </div>
      <div><span class="rolechip">${esc(role ? role.name : '?')}</span></div>
      <div class="cell-num">${fmt.days(r[COL.daysInRank])}</div>
      <div class="cell-num">${r[COL.promotions]}</div>
      <div class="cell-num">${r[COL.velocity] ? fmt.dec(r[COL.velocity], 2) : '—'}</div>
      <div>${windowCell}</div>
      <div><span class="status ${status}">${fmt.statusLabel(status)}</span></div>
    </div>`;
  }

  /* ------------------------------------------------------------ PROMOTIONS */

  function renderPromotions() {
    renderHeatmap();
    renderMatrix();
    $('#events-total').textContent =
      `${fmt.num(S.events.total)} recorded changes · showing the most recent ${fmt.num(S.events.events.length)}`;
    $$('#event-filter button').forEach((b) => b.addEventListener('click', () => {
      $$('#event-filter button').forEach((o) => o.classList.toggle('is-active', o === b));
      S.eventFilter = b.dataset.type;
      S.eventsShown = 60;
      renderEventLog();
    }));
    $('#events-more').addEventListener('click', () => { S.eventsShown += 120; renderEventLog(); });
    renderEventLog();
  }

  function renderHeatmap() {
    const { grid, max } = S.overview.heatmap;
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let html = '<div></div>';
    for (let h = 0; h < 24; h++) html += `<div class="hm-hour">${h % 3 === 0 ? h : ''}</div>`;
    for (let d = 0; d < 7; d++) {
      html += `<div class="hm-label">${dayNames[d]}</div>`;
      for (let h = 0; h < 24; h++) {
        const v = grid[d][h];
        const a = max ? Math.pow(v / max, 0.6) : 0;
        const bg = v === 0 ? 'var(--surface-2)' : `rgba(109,140,255,${0.12 + a * 0.85})`;
        html += `<div class="hm-cell" style="background:${bg}" title="${dayNames[d]} ${h}:00 UTC — ${v} promotion${v === 1 ? '' : 's'}"></div>`;
      }
    }
    $('#heatmap').innerHTML = html;
  }

  function renderMatrix() {
    const { matrix, max } = S.overview.transitions;
    const roles = S.meta.roles;
    const active = roles.filter((_, i) => matrix[i].some((v) => v > 0) || matrix.some((r) => r[i] > 0));
    if (!active.length) { $('#matrix').innerHTML = '<p class="muted small">No transitions recorded yet.</p>'; return; }

    let html = '<table><thead><tr><th></th>';
    active.forEach((r) => (html += `<th>${esc(r.name)}</th>`));
    html += '</tr></thead><tbody>';
    active.forEach((from) => {
      html += `<tr><th>${esc(from.name)}</th>`;
      active.forEach((to) => {
        const v = matrix[from.tier][to.tier];
        const a = max ? Math.pow(v / max, 0.55) : 0;
        const up = to.tier > from.tier;
        const bg = v === 0 ? 'var(--surface-2)'
          : up ? `rgba(52,211,153,${0.14 + a * 0.8})` : `rgba(248,113,113,${0.14 + a * 0.8})`;
        html += `<td style="background:${bg};color:${v ? '#fff' : 'var(--faint)'}"
          title="${esc(from.name)} → ${esc(to.name)}: ${v}">${v || ''}</td>`;
      });
      html += '</tr>';
    });
    $('#matrix').innerHTML = html + '</tbody></table>';
  }

  function renderEventLog() {
    const list = (S.eventFilter ? S.events.events.filter((e) => e.type === S.eventFilter) : S.events.events)
      .slice(0, S.eventsShown);

    $('#event-log').innerHTML = list.map((e) => `
      <div class="ev-row" data-id="${e.id}">
        ${avatarImg(e.id)}
        <span class="pill ${e.type}">${e.type}</span>
        <div class="ev-move"><b>${esc(e.u)}</b>
          ${e.fromName || e.toName ? `<br><span class="muted small">${esc(e.fromName || '—')}<span class="arrow">→</span>${esc(e.toName || '—')}</span>` : ''}
        </div>
        <div class="ev-held">${e.held != null ? `held ${fmt.days(e.held)}` : ''}</div>
        <div class="ev-time">${fmt.dateTime(e.t)}</div>
      </div>`).join('') || '<p class="muted small">Nothing recorded for this filter yet.</p>';

    bindMemberClicks('#event-log');
    const totalMatching = S.eventFilter
      ? S.events.events.filter((e) => e.type === S.eventFilter).length
      : S.events.events.length;
    $('#events-more').style.display = list.length >= totalMatching ? 'none' : 'block';
  }

  /* ----------------------------------------------------------------- RANKS */

  function renderRanks() {
    const dist = displayRoles([...S.overview.rankDistribution]).filter((d) => !d.divider).reverse();
    const scaleMax = Math.max(30, ...dist.map((d) => d.p75TimeToPromote || 0));

    $('#rank-cards').innerHTML = dist.map((d) => {
      const has = d.samples > 0 && d.p50TimeToPromote != null;
      const pos = (v) => `${Math.min(100, ((v || 0) / scaleMax) * 100)}%`;
      return `
      <div class="rank-card">
        <div class="rc-head"><h3>${esc(d.name)}</h3><span class="rc-tier">rank ${d.rank}</span></div>
        <div class="rc-count"><b>${fmt.num(S.meta.awaitingRoster ? (d.apiCount ?? 0) : d.count)}</b> members · <b>${fmt.num(d.dueNow)}</b> due or overdue</div>

        ${has ? `
          <div class="rc-range">
            <div class="rc-axis"></div>
            <div class="rc-iqr" style="left:${pos(d.p25TimeToPromote)};width:${Math.max(2, ((d.p75TimeToPromote - d.p25TimeToPromote) / scaleMax) * 100)}%"></div>
            <div class="rc-med" style="left:${pos(d.p50TimeToPromote)}"></div>
          </div>
          <div class="rc-scale"><span>0</span><span>${fmt.days(scaleMax)}</span></div>
          <div class="rc-stats">
            <div class="rc-stat"><b>${fmt.days(d.p50TimeToPromote)}</b><span>median wait</span></div>
            <div class="rc-stat"><b>${fmt.days(d.medianDaysInRank)}</b><span>held now</span></div>
            <div class="rc-stat"><b>${fmt.num(d.throughput90d)}</b><span>promoted 90d</span></div>
          </div>
          ${d.censoredFallback ? '<div class="rc-thin">Estimated from partially observed spells — treat as a ceiling.</div>' : ''}
        ` : `
          <div class="rc-stats">
            <div class="rc-stat"><b>—</b><span>median wait</span></div>
            <div class="rc-stat"><b>${fmt.days(d.medianDaysInRank)}</b><span>held now</span></div>
            <div class="rc-stat"><b>${fmt.num(d.throughput90d)}</b><span>promoted 90d</span></div>
          </div>
          <div class="rc-thin">No completed promotions observed from this rank yet.</div>
        `}
      </div>`;
    }).join('');
  }

  /* ------------------------------------------------------------ LEADERBOARDS */

  function renderBoards() {
    const defs = [
      { key: 'fastestRisers', title: 'Fastest ascension', note: 'Ranks climbed per year', metric: (m) => fmt.dec(m.v, 2), unit: 'r/yr' },
      { key: 'dueNext', title: 'Up next', note: 'Closest to their predicted promotion window', metric: (m) => (m.ld <= 0.5 ? 'now' : fmt.days(m.ld)), unit: '' },
      { key: 'mostPromotions', title: 'Most promotions', note: 'Total rank increases observed', metric: (m) => m.p, unit: 'promos' },
      { key: 'quickestSinglePromotion', title: 'Quickest single jump', note: 'Shortest observed time at a rank before moving up', metric: (m) => fmt.days(m.fast), unit: '' },
      { key: 'mostStalled', title: 'Longest stalled', note: 'Past the 90th percentile for their rank', metric: (m) => fmt.days(m.dir), unit: 'in rank' },
      { key: 'longestTenured', title: 'Longest tracked', note: 'Present since the earliest snapshots', metric: (m) => fmt.days(m.td), unit: '' },
      { key: 'highestRanked', title: 'Command', note: 'Highest ranks in the group', metric: (m) => m.role, unit: '' },
      { key: 'oldestAccounts', title: 'Oldest accounts', note: 'Roblox account creation date', metric: (m) => new Date(m.acct).getFullYear(), unit: '' },
    ];

    $('#boards').innerHTML = defs.map((d) => {
      const list = S.boards[d.key] || [];
      if (!list.length) return '';
      return `<div class="board">
        <h3>${d.title}</h3><p>${d.note}</p>
        <div class="minitable" id="board-${d.key}"></div>
      </div>`;
    }).join('');

    defs.forEach((d) => {
      const list = S.boards[d.key] || [];
      if (!list.length) return;
      renderMiniBoard(`#board-${d.key}`, list.slice(0, 12), d.metric, d.unit);
    });
  }

  /* ---------------------------------------------------------------- DRAWER */

  async function loadShard(id) {
    const shard = id % (S.meta.shards || 64);
    if (!S.shardCache.has(shard)) {
      S.shardCache.set(shard, getJSON(`data/members/${shard}.json`).catch(() => ({})));
    }
    const data = await S.shardCache.get(shard);
    return data[id] || null;
  }

  async function openMember(id) {
    const scrim = $('#drawer-scrim');
    const drawer = $('#drawer');
    scrim.hidden = false; drawer.hidden = false;
    document.body.style.overflow = 'hidden';
    $('#drawer-body').innerHTML = '<p class="muted" style="padding:40px 0">Loading…</p>';

    const m = await loadShard(id);
    if (!m) {
      $('#drawer-body').innerHTML = '<p class="muted" style="padding:40px 0">No detail on record for this member.</p>';
      return;
    }
    $('#drawer-body').innerHTML = drawerHTML(id, m);
  }

  function closeDrawer() {
    $('#drawer-scrim').hidden = true;
    $('#drawer').hidden = true;
    document.body.style.overflow = '';
  }

  function drawerHTML(id, m) {
    const p = m.prediction;
    const status = p ? p.status : 'insufficient-data';

    const stats = [
      ['Promotions', m.promotions],
      ['Ranks climbed', m.tiersClimbed],
      ['Demotions', m.demotions],
      ['Ranks / year', m.velocity ? fmt.dec(m.velocity, 2) : '—'],
      ['Avg gap', fmt.days(m.avgDaysPerPromotion)],
      ['Fastest jump', fmt.days(m.fastestPromotionDays)],
      ['In rank', fmt.days(m.daysInRank)],
      ['Longest stall', fmt.days(m.longestStallDays)],
      ['Tracked', fmt.days(m.trackedDays)],
    ];

    return `
      <div class="dr-head">
        <img class="avatar lg" src="${fmt.avatar(id, 150)}" alt="" onerror="${AVATAR_FALLBACK}">
        <div>
          <h2>${esc(m.u)}</h2>
          <div class="sub">${esc(m.d !== m.u ? m.d : `User ID ${id}`)}</div>
          <div class="dr-badges">
            <span class="rolechip">${esc(m.role)}</span>
            <span class="status ${status}">${fmt.statusLabel(status)}</span>
            ${m.departed ? '<span class="pill leave">departed</span>' : ''}
            ${m.boot ? '<span class="pill rename">pre-existing</span>' : ''}
          </div>
        </div>
      </div>

      ${predictionHTML(m, p)}

      <div class="dr-section">
        <h3>Record</h3>
        <div class="dr-stats">
          ${stats.map(([k, v]) => `<div class="dr-stat"><b>${v ?? '—'}</b><span>${k}</span></div>`).join('')}
        </div>
      </div>

      <div class="dr-section">
        <h3>Ascension timeline</h3>
        <div class="timeline">
          ${[...m.history].reverse().map((h, i, arr) => {
            const role = S.roleByTier.get(h[0]);
            const isCurrent = i === 0 && !m.departed;
            return `<div class="tl-item ${isCurrent ? 'current' : ''}">
              <div class="tl-marker"><div class="tl-dot"></div><div class="tl-line"></div></div>
              <div class="tl-body">
                <div class="tl-role">${esc(role ? role.name : `Tier ${h[0]}`)}</div>
                <div class="tl-meta">${fmt.date(h[1])} ${h[2] ? `→ ${fmt.date(h[2])}` : '→ present'}</div>
                <div class="tl-dur">${fmt.days(h[3])}${h[2] ? '' : ' so far'}
                  ${h[4] ? ' <span class="tl-censored">· start not observed</span>' : ''}</div>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>

      <div class="dr-section">
        <h3>Account</h3>
        <div class="dr-stats">
          <div class="dr-stat"><b>${m.accountCreated ? new Date(m.accountCreated).getFullYear() : '—'}</b><span>joined Roblox</span></div>
          <div class="dr-stat"><b>${fmt.days(m.accountCreated ? (Date.now() - m.accountCreated) / 86400000 : null)}</b><span>account age</span></div>
          <div class="dr-stat"><b>${m.nameChanges}</b><span>renames</span></div>
        </div>
        <p class="dr-note">
          ${m.boot
            ? 'This member was already in the group when tracking began, so their first spell has no observed start and their tenure here is a lower bound.'
            : `First observed joining on ${fmt.date(m.trackedSince)}.`}
        </p>
        <a class="btn-roblox" href="https://www.roblox.com/users/${id}/profile" target="_blank" rel="noopener">
          Open Roblox profile ↗
        </a>
      </div>`;
  }

  function predictionHTML(m, p) {
    if (!p) return '';
    if (p.status === 'top-rank') {
      return `<div class="dr-section"><h3>Promotion outlook</h3>
        <div class="window"><div class="window-top"><b>At the highest rank</b>
        <span class="status top-rank">Top rank</span></div>
        <p class="muted small">No further ascension to predict.</p></div></div>`;
    }
    if (p.status === 'insufficient-data') {
      return `<div class="dr-section"><h3>Promotion outlook</h3>
        <div class="window"><div class="window-top"><b>Not enough history</b>
        <span class="status insufficient-data">Gathering data</span></div>
        <p class="muted small">Only ${p.samples || 0} completed promotion${p.samples === 1 ? '' : 's'} observed from this rank.
        A few more snapshots and a window will appear here.</p></div></div>`;
    }

    // Scale the bar so "now" sits sensibly relative to the predicted range.
    const span = Math.max(p.latestDays + p.served, p.served * 1.2, 1);
    const pct = (v) => `${Math.max(0, Math.min(100, (v / span) * 100))}%`;
    const startPct = pct(p.served + p.earliestDays);
    const widthPct = `${Math.max(2, ((p.latestDays - p.earliestDays) / span) * 100)}%`;

    const headline = p.likelyDays <= 0.5
      ? 'Due now'
      : `~${fmt.days(p.likelyDays)} away`;

    return `<div class="dr-section">
      <h3>Promotion outlook</h3>
      <div class="window">
        <div class="window-top">
          <b>${headline}</b>
          <span class="status ${p.status}">${fmt.statusLabel(p.status)}</span>
        </div>

        <div class="wbar">
          <div class="wbar-track"></div>
          <div class="wbar-range" style="left:${startPct};width:${widthPct}"></div>
          <div class="wbar-now" style="left:${pct(p.served)}"></div>
        </div>
        <div class="wlabels">
          <span>${p.earliestDays <= 0.5 ? 'now' : fmt.date(p.earliestAt)}</span>
          <span>likely ${p.likelyDays <= 0.5 ? 'now' : fmt.date(p.likelyAt)}</span>
          <span>${fmt.date(p.latestAt)}</span>
        </div>

        <div class="readiness">
          <div class="small muted">Served <b style="color:var(--text)">${fmt.days(p.served)}</b> at this rank —
            longer than <b style="color:var(--text)">${fmt.dec(p.readiness, 0)}%</b> of the ${fmt.num(p.samples)} members
            promoted out of it. Cohort median is ${fmt.days(p.cohortMedian)}.</div>
          <div class="readiness-bar"><i style="width:${Math.min(100, p.readiness || 0)}%"></i></div>
        </div>

        <p class="dr-note">
          ${p.usedPersonalCadence
            ? 'Blends this member’s own promotion cadence with the cohort curve for their rank.'
            : 'Based on the cohort curve for their rank; not enough personal history to weight their own pace yet.'}
          Predictions describe observed patterns, not group policy.
        </p>
      </div>
    </div>`;
  }

  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer();
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault(); go('roster'); $('#roster-search').focus();
    }
  });

  boot().catch((err) => {
    console.error(err);
    showEmpty(`Something went wrong loading the dashboard: <code>${esc(err.message)}</code>`);
  });
})();
