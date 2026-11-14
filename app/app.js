'use strict';

/* MBA Radar — reads the files written by the daily collector and renders the radar, the feed
   and the study note for each article. No build step, no dependencies.

   data/articles.json  articles from the last few days, each with its full study note
   data/archive.json   older articles, kept as links only                                   */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isHttp = (u) => /^https?:\/\//i.test(String(u || ''));
const color = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#2de2e6');

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: state just won't persist */ }
  },
};

const ICON = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  ext: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M11 7H6v11h11v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const state = {
  data: null,        // { generatedAt, sample, modules }
  mods: {},
  byId: {},          // every article that has a study note (recent ones and saved ones)
  today: [],         // the latest edition: what the radar shows
  older: [],         // earlier articles: recent ones still have a note, archived ones are links only
  module: null,
  view: 'today',
  query: '',
  selected: null,
  stamp: '',
  read: new Set(store.get('mr.read', [])),
  saved: store.get('mr.savedData', {}),   // id -> full article, kept on this device so a saved note outlives the archive
};
let geom = null; // last radar geometry, reused for hover links

/* ── Data ───────────────────────────────────────────────── */

async function load(manual) {
  const btn = $('#refresh');
  btn.classList.add('spin');
  try {
    const [res, arc] = await Promise.all([
      fetch('data/articles.json', { cache: 'no-store' }),
      fetch('data/archive.json', { cache: 'no-store' }).catch(() => null),
    ]);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const archive = arc && arc.ok ? await arc.json().catch(() => null) : null;
    // Nothing new since the last check: leave the screen (and the reader's scroll position) alone.
    const stamp = `${data.generatedAt}|${(data.articles || []).length}|${archive ? (archive.articles || []).length : 0}`;
    if (stamp !== state.stamp) { state.stamp = stamp; normalise(data, archive); renderAll(); } else renderHeader();
    if (manual) toast('Edition up to date');
  } catch (err) {
    if (state.data) toast('Offline. Showing the last saved edition');
    else $('#feed').innerHTML = '<div class="empty"><strong>Couldn\'t load the edition</strong>Check your connection, then refresh.</div>';
  } finally {
    btn.classList.remove('spin');
  }
}

function prep(a, mods) {
  a.modules = (a.modules || [])
    .filter((m) => mods[m.id])
    .map((m) => ({ id: m.id, relevance: Math.max(0, Math.min(100, Math.round(Number(m.relevance) || 0))), reading: m.reading || '' }))
    .sort((x, y) => y.relevance - x.relevance);
  a.applications = (a.applications || []).filter((p) => mods[p.moduleId]);
  a.keyPoints = a.keyPoints || [];
  a.when = a.addedAt || a.publishedAt || '';
  a.c = a.modules.length ? mods[a.modules[0].id].color : '#2de2e6';
  return a;
}

function normalise(data, archive) {
  const mods = {};
  (data.modules || []).forEach((m) => { m.color = color(m.color); mods[m.id] = m; });
  const byDate = (x, y) => new Date(y.publishedAt) - new Date(x.publishedAt);

  const noted = (data.articles || []).filter((a) => a && a.id && a.title).map((a) => prep(a, mods)).filter((a) => a.modules.length);
  noted.forEach((a) => { a.hasNote = true; });
  const latest = noted.reduce((max, a) => (a.addedAt && a.addedAt > max ? a.addedAt : max), '');
  const today = noted.filter((a) => !latest || a.addedAt === latest).sort(byDate);

  const seen = new Set(noted.map((a) => a.id));
  const links = ((archive && archive.articles) || [])
    .filter((a) => a && a.id && a.title && !seen.has(a.id))
    .map((a) => prep(a, mods));
  const older = noted.filter((a) => latest && a.addedAt !== latest).concat(links)
    .sort((x, y) => (y.when > x.when ? 1 : y.when < x.when ? -1 : byDate(x, y)));

  const byId = Object.fromEntries(noted.map((a) => [a.id, a]));
  Object.values(state.saved).forEach((a) => {
    if (a && a.id && !byId[a.id]) { byId[a.id] = prep({ ...a }, mods); byId[a.id].hasNote = true; }
  });

  state.data = { generatedAt: data.generatedAt, sample: !!data.sample, modules: data.modules || [] };
  state.mods = mods;
  state.byId = byId;
  state.today = today;
  state.older = older;
  if (state.module && !mods[state.module]) state.module = null;
}

function pool(view) {
  if (view === 'archive') return state.older;
  if (view === 'saved') {
    return Object.keys(state.saved).map((id) => state.byId[id]).filter(Boolean)
      .sort((x, y) => new Date(y.publishedAt) - new Date(x.publishedAt));
  }
  return state.today;
}

function visible({ view = state.view, ignoreModule = false } = {}) {
  const q = state.query.trim().toLowerCase();
  return pool(view).filter((a) =>
    (ignoreModule || !state.module || a.modules.some((m) => m.id === state.module)) &&
    (!q || `${a.title} ${a.source} ${a.takeaway || ''}`.toLowerCase().includes(q)));
}

/* ── Formatting ─────────────────────────────────────────── */

function ago(iso) {
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (Number.isNaN(s)) return '';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function dayLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Earlier';
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((midnight(new Date()) - midnight(d)) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', year: diff > 300 ? 'numeric' : undefined });
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const list = (items, tag = 'ul', cls = '') =>
  (items && items.length ? `<${tag}${cls ? ` class="${cls}"` : ''}>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</${tag}>` : '');

/* ── Header, chips, feed ────────────────────────────────── */

function moduleCounts(articles) {
  const counts = {};
  articles.forEach((a) => a.modules.forEach((m) => { counts[m.id] = (counts[m.id] || 0) + 1; }));
  return counts;
}

function renderHeader() {
  const today = state.today;
  const unread = today.filter((a) => !state.read.has(a.id)).length;
  const counts = moduleCounts(today);
  const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const date = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  $('#brief').textContent = today.length
    ? `${date} · ${today.length} in today's edition · ${unread} unread${top ? ` · strongest: ${state.mods[top].short}` : ''}`
    : `${date} · no articles yet`;
  $('#updated').textContent = state.data.generatedAt ? `Updated ${ago(state.data.generatedAt)}` : '';
  $('#banner').innerHTML = state.data.sample
    ? '<div class="banner">Sample edition. These articles are invented to show the layout; real ones appear after the first collection run.</div>'
    : '';
  document.querySelectorAll('.seg button').forEach((b) => {
    const n = pool(b.dataset.view).length;
    b.querySelector('b').textContent = n ? String(n) : '';
  });
}

function renderChips() {
  const all = visible({ ignoreModule: true });
  const counts = moduleCounts(all);
  const chip = (id, label, n, c) =>
    `<button type="button" class="chip${state.module === id ? ' on' : ''}" data-m="${esc(id ?? '')}" aria-pressed="${state.module === id}"${c ? ` style="--c:${c}"` : ''}>${c ? '<i></i>' : ''}${esc(label)}<b>${n}</b></button>`;
  $('#chips').innerHTML = chip(null, 'All modules', all.length, '') +
    state.data.modules.map((m) => chip(m.id, m.short, counts[m.id] || 0, m.color)).join('');
}

const tagsHtml = (a, withScore) => a.modules.slice(0, 3).map((m) =>
  `<span class="tag" style="--c:${state.mods[m.id].color}">${esc(state.mods[m.id].short)}${withScore ? `<em>${m.relevance}</em>` : ''}</span>`).join('');

function cardHtml(a) {
  const read = state.read.has(a.id);
  return `<a class="card ${read ? 'read' : 'unread'}${state.selected === a.id ? ' sel' : ''}" href="#a=${encodeURIComponent(a.id)}" data-open="${esc(a.id)}" style="--c:${a.c}">
    <div class="card-top"><span class="src">${esc(a.source)}</span><span>·</span><time datetime="${esc(a.publishedAt)}">${esc(ago(a.publishedAt))}</time><span class="sp"></span>${state.saved[a.id] ? '<span class="star" title="Saved">★</span>' : ''}${read ? '' : '<span class="new" title="Unread"></span>'}</div>
    <h3>${esc(a.title)}</h3>
    <p class="take">${esc(a.takeaway)}</p>
    <div class="tags">${tagsHtml(a, true)}</div>
  </a>`;
}

// Archive rows are deliberately light: the link to the original, and the study note while it still exists.
function rowHtml(a) {
  const title = isHttp(a.url)
    ? `<a class="arow-title" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)} ${ICON.ext}</a>`
    : `<span class="arow-title">${esc(a.title)}</span>`;
  return `<div class="arow" style="--c:${a.c}">
    ${title}
    <div class="arow-meta"><span class="src">${esc(a.source)}</span>${tagsHtml(a, false)}<span class="sp"></span>${a.hasNote ? `<button type="button" class="note-btn" data-open="${esc(a.id)}">Study note</button>` : ''}</div>
  </div>`;
}

function renderFeed() {
  const items = visible();
  if (!items.length) {
    const msg = {
      today: ['No articles match', 'Clear the search or choose another module.'],
      archive: state.older.length ? ['No articles match', 'Clear the search or choose another module.'] : ['The archive starts tomorrow', 'Each morning, the previous edition moves here.'],
      saved: Object.keys(state.saved).length ? ['No articles match', 'Clear the search or choose another module.'] : ['Save articles to revise later', 'Open an article and select the star. Saved study notes stay on this device.'],
    }[state.view];
    $('#feed').innerHTML = `<div class="empty"><strong>${msg[0]}</strong>${msg[1]}</div>`;
    return;
  }
  if (state.view === 'archive') {
    let last = '';
    $('#feed').innerHTML = items.map((a) => {
      const day = dayLabel(a.when);
      const head = day !== last ? `<div class="day">${esc(day)}</div>` : '';
      last = day;
      return head + rowHtml(a);
    }).join('');
    return;
  }
  const head = state.view === 'today' ? `<div class="day">Today's edition</div>` : '';
  $('#feed').innerHTML = head + items.map(cardHtml).join('');
}

/* ── Radar (always today's edition) ─────────────────────── */

function renderRadar() {
  const wrap = $('#radarWrap');
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  if (!state.data || W < 50 || H < 50) return;

  const mods = state.data.modules;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.max(70, Math.min(W / 2 - (W < 520 ? 62 : 96), H / 2 - 34));
  const k = Math.max(0.62, Math.min(1.5, R / 200));
  wrap.style.setProperty('--R', `${R}px`);

  const pos = {};
  mods.forEach((m, i) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / mods.length;
    pos[m.id] = { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang), cos: Math.cos(ang), sin: Math.sin(ang) };
  });

  const arts = visible({ view: 'today' }).slice(0, 70);
  const counts = moduleCounts(visible({ view: 'today', ignoreModule: true }));

  // Each article sits at the relevance-weighted centre of its modules, pulled slightly inward.
  const pts = arts.map((a) => {
    let sx = 0, sy = 0, sw = 0;
    a.modules.forEach((m) => {
      const w = (m.relevance / 100) ** 3 + 0.001;
      sx += pos[m.id].x * w; sy += pos[m.id].y * w; sw += w;
    });
    const h = hash(a.id);
    const jitter = 16 * k;
    return {
      a,
      x: cx + (sx / sw - cx) * 0.88 + ((h % 1000) / 1000 - 0.5) * jitter,
      y: cy + (sy / sw - cy) * 0.88 + (((h >>> 10) % 1000) / 1000 - 0.5) * jitter,
      r: (4.2 + (a.modules[0].relevance / 100) * 4.6) * k,
    };
  });

  // Push overlapping dots apart and keep them inside the ring.
  const limit = R - 16 * k;
  for (let iter = 0; iter < 60; iter++) {
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const p = pts[i], q = pts[j];
        let dx = q.x - p.x, dy = q.y - p.y;
        let d = Math.hypot(dx, dy);
        const min = p.r + q.r + 5 * k;
        if (d < min) {
          if (d < 0.01) { dx = 1; dy = 0; d = 1; }
          const push = (min - d) / 2;
          p.x -= (dx / d) * push; p.y -= (dy / d) * push;
          q.x += (dx / d) * push; q.y += (dy / d) * push;
        }
      }
    }
    pts.forEach((p) => {
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d > limit) { p.x = cx + ((p.x - cx) / d) * limit; p.y = cy + ((p.y - cy) / d) * limit; }
    });
  }

  const f = (n) => n.toFixed(1);
  const rings = [1, 0.66, 0.33].map((s, i) => `<circle class="ring${i ? '' : ' outer'}" cx="${f(cx)}" cy="${f(cy)}" r="${f(R * s)}"/>`).join('');
  const spokes = mods.map((m) => `<line class="spoke" x1="${f(cx)}" y1="${f(cy)}" x2="${f(pos[m.id].x)}" y2="${f(pos[m.id].y)}"/>`).join('');

  const modNodes = mods.map((m) => {
    const p = pos[m.id];
    const on = state.module === m.id;
    let anchor = p.cos > 0.25 ? 'start' : p.cos < -0.25 ? 'end' : 'middle';
    let lx = p.x + p.cos * 15;
    let ly = p.y + p.sin * 15 + (anchor === 'middle' ? (p.sin < 0 ? -4 : 13) : 4);
    // On a phone there is no room beside the far-left and far-right nodes: tuck those labels above the node.
    if (W < 520 && Math.abs(p.sin) < 0.3) {
      anchor = p.cos > 0 ? 'end' : 'start';
      lx = p.x + (p.cos > 0 ? 14 : -14);
      ly = p.y - 15;
    }
    return `<g class="mod${on ? ' on' : ''}${state.module && !on ? ' off' : ''}" data-m="${esc(m.id)}" style="--c:${m.color}" tabindex="0" role="button" aria-pressed="${on}" aria-label="${esc(m.name)}, ${counts[m.id] || 0} articles today">
      <circle class="glow" cx="${f(p.x)}" cy="${f(p.y)}" r="${f(13 * k)}"/>
      <circle class="node" cx="${f(p.x)}" cy="${f(p.y)}" r="${f(6 * k)}"/>
      <text x="${f(lx)}" y="${f(ly)}" text-anchor="${anchor}">${esc(m.short)} <tspan class="n">${counts[m.id] || 0}</tspan></text>
    </g>`;
  }).join('');

  const dots = pts.map((p) => {
    const cls = `${state.read.has(p.a.id) ? 'read' : 'unread'}${state.selected === p.a.id ? ' sel' : ''}`;
    return `<g class="dot ${cls}" data-id="${esc(p.a.id)}" style="--c:${p.a.c}" tabindex="0" role="link" aria-label="${esc(p.a.title)}">
      <circle class="halo" cx="${f(p.x)}" cy="${f(p.y)}" r="${f(p.r + 3)}"/>
      <circle class="core" cx="${f(p.x)}" cy="${f(p.y)}" r="${f(p.r)}"/>
    </g>`;
  }).join('');

  $('#radar').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Radar of today's articles by module">
    ${rings}${spokes}
    <g id="links"></g>
    ${state.selected && pts.some((p) => p.a.id === state.selected) ? '' : `<text class="core-count" x="${f(cx)}" y="${f(cy + 4)}">${arts.length}</text><text class="core-label" x="${f(cx)}" y="${f(cy + 20)}">TODAY</text>`}
    ${modNodes}${dots}
  </svg>`;

  geom = { pts: Object.fromEntries(pts.map((p) => [p.a.id, p])), pos };
  drawLinks(state.selected);
}

function drawLinks(id) {
  const g = $('#links');
  if (!g || !geom) return;
  const p = id && geom.pts[id];
  g.innerHTML = p
    ? p.a.modules.map((m) => {
        const t = geom.pos[m.id];
        return `<line class="link" x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${t.x.toFixed(1)}" y2="${t.y.toFixed(1)}" stroke="${state.mods[m.id].color}" stroke-width="${(0.8 + (m.relevance / 100) * 2.4).toFixed(1)}"/>`;
      }).join('')
    : '';
}

function showTip(id) {
  const tip = $('#tip');
  const p = id && geom && geom.pts[id];
  if (!p) { tip.hidden = true; return; }
  const wrapW = $('#radarWrap').clientWidth;
  tip.innerHTML = `<small>${esc(p.a.source)} · ${esc(p.a.modules.map((m) => state.mods[m.id].short).join(' + '))}</small>${esc(p.a.title)}`;
  tip.style.left = `${Math.max(130, Math.min(wrapW - 130, p.x))}px`;
  tip.style.top = `${Math.max(70, p.y)}px`;
  tip.hidden = false;
}

/* ── Detail ─────────────────────────────────────────────── */

const fitRow = (r) =>
  `<div class="fit-row" style="--c:${r.color}"><span class="nm">${esc(r.name)}</span><span class="track"><i style="width:${r.pct}%"></i></span><span class="pc">${esc(r.label)}</span></div>`;

function renderDetail() {
  const el = $('#detail');
  const a = state.selected && state.byId[state.selected];
  if (!a) { el.dataset.id = ''; el.innerHTML = overview(); return; }

  // Re-rendering the same article (e.g. after saving it) must not jump back to the top.
  const keepScroll = el.dataset.id === a.id ? el.scrollTop : 0;
  el.dataset.id = a.id;
  const saved = !!state.saved[a.id];
  const date = new Date(a.publishedAt);
  const dateText = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const basis = a.basis === 'abstract'
    ? '<span class="basis abs" title="Only the publisher\'s abstract was available">Abstract only</span>'
    : '<span class="basis">Full text</span>';

  // 1. The article explained from each module's point of view.
  const lenses = a.modules.map((m) => {
    const mod = state.mods[m.id];
    return `<div class="lens" style="--c:${mod.color}">${fitRow({ name: mod.name, color: mod.color, pct: m.relevance, label: `${m.relevance}%` })}${m.reading ? `<p>${esc(m.reading)}</p>` : ''}</div>`;
  }).join('');

  // 2. Theory applied to the article.
  const part = (label, text) => (text ? `<div><dt>${label}</dt><dd>${esc(text)}</dd></div>` : '');
  const apps = a.applications.map((p) => {
    const m = state.mods[p.moduleId];
    return `<div class="apply" style="--c:${m.color}">
      <div class="mod-name">${esc(m.name)}</div>
      <h4>${esc(p.concept)}</h4>
      <dl>${part('The theory', p.theory)}${part('In this article', p.link)}${part('Limits and critique', p.critique)}${part('In practice', p.practice)}</dl>
    </div>`;
  }).join('');

  // 3. How to use the article in a case-study exam.
  const cs = a.caseStudy;
  const caseHtml = cs && (cs.scenario || cs.question)
    ? `<section class="block case"><h3>Use it in a case study</h3>
        ${cs.scenario ? `<h5>The case</h5><p>${esc(cs.scenario)}</p>` : ''}
        ${cs.question ? `<h5>The task</h5><p class="q">${esc(cs.question)}</p>` : ''}
        ${(cs.evidence || []).length ? `<h5>Evidence you can cite</h5>${list(cs.evidence, 'ul', 'points')}` : ''}
        ${(cs.plan || []).length || (cs.pitfalls || []).length ? `<details><summary>Show answer plan</summary>
          ${list(cs.plan, 'ol', 'plan')}
          ${(cs.pitfalls || []).length ? `<h5>Pitfalls</h5>${list(cs.pitfalls, 'ul', 'pitfalls')}` : ''}
        </details>` : ''}
        ${(a.alsoConsider || []).length ? `<h5>Also consider</h5><div class="tags">${a.alsoConsider.map((t) => `<span class="tag plain">${esc(t)}</span>`).join('')}</div>` : ''}
      </section>`
    : '';

  const exam = a.exam && a.exam.question
    ? `<section class="block exam"><h3>Essay question</h3><p class="q">${esc(a.exam.question)}</p>${(a.exam.outline || []).length
        ? `<details><summary>Show answer outline</summary>${list(a.exam.outline)}</details>` : ''}</section>`
    : '';

  el.style.setProperty('--c', a.c);
  el.innerHTML = `
    <div class="d-bar">
      <button type="button" class="icon-btn" data-act="close" aria-label="Back to radar">${ICON.back}</button>
      <span class="d-bar-title">Study note</span>
      <button type="button" class="icon-btn${saved ? ' on' : ''}" data-act="save" aria-pressed="${saved}" aria-label="${saved ? 'Remove from saved' : 'Save article'}">${ICON.star}</button>
    </div>
    <div class="d-body">
      <p class="eyebrow"><span>${esc(a.source)}</span>${dateText ? ` · ${esc(dateText)}` : ''}${a.readingMinutes ? ` · ${esc(a.readingMinutes)} min read` : ''} ${basis}</p>
      <h2>${esc(a.title)}</h2>
      <p class="takeaway">${esc(a.takeaway)}</p>
      <section class="block"><h3>Summary</h3><p>${esc(a.summary)}</p>${list(a.keyPoints, 'ul', 'points')}</section>
      <section class="block"><h3>Through your modules</h3>${lenses}</section>
      ${apps ? `<section class="block"><h3>Theory in action</h3>${apps}</section>` : ''}
      ${caseHtml}
      ${exam}
      ${isHttp(a.url) ? `<a class="cta" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">Read the original article ${ICON.ext}</a>` : ''}
      <p class="fine">Study note written by AI from ${a.basis === 'abstract' ? 'the publisher\'s abstract' : 'the article text'}. Check it against the original and your course notes before you cite it.</p>
    </div>`;
  el.scrollTop = keepScroll;
}

function overview() {
  if (!state.data) return '';
  const counts = moduleCounts(visible({ view: 'today', ignoreModule: true }));
  const max = Math.max(1, ...Object.values(counts));
  const rows = state.data.modules
    .map((m) => ({ name: m.name, color: m.color, n: counts[m.id] || 0 }))
    .sort((x, y) => y.n - x.n)
    .map((r) => fitRow({ ...r, pct: Math.round((r.n / max) * 100), label: String(r.n) }));
  return `<div class="overview">
    <h2>Today's edition by module</h2>
    <p>Select a dot on the radar or an article in the feed to open its study note.</p>
    <div class="fit">${rows.join('')}</div>
  </div>`;
}

/* ── Navigation and events ──────────────────────────────── */

function route() {
  const m = /^#a=(.+)$/.exec(location.hash);
  const id = m ? decodeURIComponent(m[1]) : null;
  state.selected = id && state.byId[id] ? id : null;
  if (state.selected && !state.read.has(state.selected)) {
    state.read.add(state.selected);
    store.set('mr.read', [...state.read].slice(-1500));
  }
  document.body.classList.toggle('detail-open', !!state.selected);
  showTip(null);
  renderHeader();
  renderFeed();
  renderRadar();
  renderDetail();
}

function renderAll() {
  renderChips();
  route();
}

function refreshLists() {
  renderChips();
  renderFeed();
  renderRadar();
  if (!state.selected) renderDetail();
}

function closeDetail() {
  if (history.state && history.state.fromApp) { history.back(); return; }
  history.replaceState(null, '', location.pathname + location.search);
  route();
}

function setModule(id) {
  state.module = id && state.module !== id ? id : null;
  refreshLists();
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
}

function openArticle(id) {
  if (!state.byId[id]) return;
  if (state.selected) history.replaceState({ fromApp: true }, '', `#a=${encodeURIComponent(id)}`);
  else history.pushState({ fromApp: true }, '', `#a=${encodeURIComponent(id)}`);
  route();
}

function toggleSaved(id) {
  const a = state.byId[id];
  if (!a) return;
  if (state.saved[id]) delete state.saved[id];
  else {
    const { c, when, hasNote, ...clean } = a;   // keep the article itself, not the display fields
    state.saved[id] = clean;
  }
  store.set('mr.savedData', state.saved);
  toast(state.saved[id] ? 'Saved for revision' : 'Removed from saved');
  renderHeader(); renderDetail(); renderFeed();
}

function bind() {
  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);
  $('#refresh').addEventListener('click', () => load(true));

  $('#feed').addEventListener('click', (e) => {
    const opener = e.target.closest('[data-open]');
    if (!opener || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    openArticle(opener.dataset.open);
  });

  $('#chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) setModule(chip.dataset.m || null);
  });

  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    document.querySelectorAll('.seg button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    refreshLists();
  }));

  let qTimer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.query = e.target.value; refreshLists(); }, 120);
  });

  const radar = $('#radarWrap');
  const activate = (target) => {
    const dot = target.closest('.dot');
    if (dot) return openArticle(dot.dataset.id);
    const mod = target.closest('.mod');
    if (mod) setModule(mod.dataset.m);
  };
  radar.addEventListener('click', (e) => activate(e.target));
  radar.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(e.target); }
  });
  const hover = (e) => {
    const dot = e.target.closest && e.target.closest('.dot');
    drawLinks(dot ? dot.dataset.id : state.selected);
    showTip(dot ? dot.dataset.id : null);
  };
  radar.addEventListener('pointerover', (e) => { if (e.pointerType !== 'touch') hover(e); });
  radar.addEventListener('focusin', hover);
  radar.addEventListener('pointerleave', () => { drawLinks(state.selected); showTip(null); });
  radar.addEventListener('focusout', () => { drawLinks(state.selected); showTip(null); });

  $('#detail').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'close') closeDetail();
    if (btn.dataset.act === 'save' && state.selected) toggleSaved(state.selected);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.selected) closeDetail();
  });

  let raf;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderRadar); }).observe(radar);

  // Pick up a fresh edition when the app comes back to the foreground.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.data) load(false);
  });
}

// Articles saved with the first version of the app were stored as ids only: carry them over once loaded.
function migrateSaved() {
  const ids = store.get('mr.saved', null);
  if (!Array.isArray(ids)) return;
  ids.forEach((id) => {
    if (state.byId[id] && !state.saved[id]) { const { c, when, hasNote, ...clean } = state.byId[id]; state.saved[id] = clean; }
  });
  store.set('mr.savedData', state.saved);
  try { localStorage.removeItem('mr.saved'); } catch { /* nothing to clean */ }
}

bind();
load(false).then(() => { if (state.data) { migrateSaved(); renderHeader(); } });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
