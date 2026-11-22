'use strict';

/* MBA Radar — two desks in one app, both fed by the daily collectors. No build step, no dependencies.

   Study desk     data/articles.json   recent articles with their full study note
                  data/archive.json    older articles, kept as links only
   Maritime desk  data/maritime.json          the morning brief and recent briefing notes, placed by country
                  data/maritime-archive.json  older items, kept as links only                                  */

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

const fmtDate = (iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', opts);
};

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

const fitRow = (r) =>
  `<div class="fit-row" style="--c:${r.color}"><span class="nm">${esc(r.name)}</span><span class="track"><i style="width:${r.pct}%"></i></span><span class="pc">${esc(r.label)}</span></div>`;

const basisTag = (a) => (a.basis === 'abstract'
  ? '<span class="basis abs" title="Only the publisher\'s summary was available">Abstract only</span>'
  : '<span class="basis">Full text</span>');

const read = new Set(store.get('mr.read', []));
const strip = ({ c, when, hasNote, nodes, sub, ...rest }) => rest;   // what a saved article keeps

/* ── The two desks ──────────────────────────────────────── */

const DESKS = {
  study: {
    title: 'MBA Radar',
    hashKey: 'a',
    files: ['data/articles.json', 'data/archive.json'],
    savedKey: 'mr.savedData',
    allLabel: 'All modules',
    noteLabel: 'Study note',
    openLabel: 'Study note',
    radarLabel: "Radar of today's articles by module",

    prepare(data, archive) {
      const nodes = (data.modules || []).map((m) => ({
        id: m.id, name: m.name, short: m.short, color: color(m.color), focus: !!m.current, weight: 1,
      }));
      const ids = new Set(nodes.map((n) => n.id));
      const shape = (a, noted) => {
        a.modules = (a.modules || []).filter((m) => ids.has(m.id))
          .map((m) => ({ id: m.id, relevance: Math.max(0, Math.min(100, Math.round(Number(m.relevance) || 0))), reading: m.reading || '' }))
          .sort((x, y) => y.relevance - x.relevance);
        a.nodes = a.modules;
        a.applications = (a.applications || []).filter((p) => ids.has(p.moduleId));
        a.keyPoints = a.keyPoints || [];
        a.sub = a.takeaway || '';
        a.hasNote = noted;
        return a;
      };
      return {
        nodes,
        noted: (data.articles || []).filter((a) => a && a.id && a.title).map((a) => shape(a, true)).filter((a) => a.nodes.length),
        links: ((archive && archive.articles) || []).filter((a) => a && a.id && a.title).map((a) => shape(a, false)),
        reshape: shape,
        meta: { generatedAt: data.generatedAt, sample: !!data.sample },
      };
    },
    dotColor: (a, D) => (a.nodes.length ? D.nodeMap[a.nodes[0].id].color : '#2de2e6'),
    order: (x, y) => new Date(y.publishedAt) - new Date(x.publishedAt),

    briefLine(D) {
      const unread = D.today.filter((a) => !read.has(a.id)).length;
      const counts = nodeCounts(D.today);
      const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
      return D.today.length
        ? `${D.today.length} in today's edition · ${unread} unread${top ? ` · strongest: ${D.nodeMap[top].short}` : ''}`
        : 'no articles yet';
    },
    banner: (D) => (D.meta.sample
      ? 'Sample edition. These articles are invented to show the layout; real ones appear after the first collection run.'
      : ''),
    foot: () => '<p class="radar-hint">Each dot is an article, pulled toward the modules it applies to. Select a module to filter.</p>',
    nodeLabel: (n) => n.short,
    chipLabel: (n) => `${esc(n.short)}${n.focus ? '<u>studying now</u>' : ''}`,
    tagsHtml: (a, D, withScore) => a.nodes.slice(0, 3).map((m) =>
      `<span class="tag" style="--c:${D.nodeMap[m.id].color}">${esc(D.nodeMap[m.id].short)}${withScore ? `<em>${m.relevance}</em>` : ''}</span>`).join(''),
    cardTop: () => '',
    searchText: (a) => `${a.title} ${a.source} ${a.takeaway || ''}`,

    detail(a, D) {
      const lenses = a.modules.map((m) => {
        const mod = D.nodeMap[m.id];
        return `<div class="lens" style="--c:${mod.color}">${fitRow({ name: mod.name, color: mod.color, pct: m.relevance, label: `${m.relevance}%` })}${m.reading ? `<p>${esc(m.reading)}</p>` : ''}</div>`;
      }).join('');

      const part = (label, text) => (text ? `<div><dt>${label}</dt><dd>${esc(text)}</dd></div>` : '');
      const apps = a.applications.map((p) => {
        const m = D.nodeMap[p.moduleId];
        return `<div class="apply" style="--c:${m.color}">
          <div class="mod-name">${esc(m.name)}${p.unit ? `<span> · ${esc(p.unit)}</span>` : ''}</div>
          <h4>${esc(p.concept)}</h4>
          <dl>${part('The theory', p.theory)}${part('In this article', p.link)}${part('Limits and critique', p.critique)}${part('In practice', p.practice)}</dl>
        </div>`;
      }).join('');

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

      const date = fmtDate(a.publishedAt);
      return `
        <p class="eyebrow"><span>${esc(a.source)}</span>${date ? ` · ${esc(date)}` : ''}${a.readingMinutes ? ` · ${esc(a.readingMinutes)} min read` : ''} ${basisTag(a)}</p>
        <h2>${esc(a.title)}</h2>
        <p class="takeaway">${esc(a.takeaway)}</p>
        <section class="block"><h3>Summary</h3><p>${esc(a.summary)}</p>${list(a.keyPoints, 'ul', 'points')}</section>
        <section class="block"><h3>Through your modules</h3>${lenses}</section>
        ${apps ? `<section class="block"><h3>Theory in action</h3>${apps}</section>` : ''}
        ${caseHtml}
        ${exam}
        ${isHttp(a.url) ? `<a class="cta" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">Read the original article ${ICON.ext}</a>` : ''}
        <p class="fine">Study note written by AI from ${a.basis === 'abstract' ? 'the publisher\'s abstract' : 'the article text'}. Check it against the original and your course notes before you cite it.</p>`;
    },

    overview(D) {
      const counts = nodeCounts(D.today);
      const max = Math.max(1, ...Object.values(counts));
      const rows = D.nodes
        .map((m) => ({ name: m.name, color: m.color, n: counts[m.id] || 0 }))
        .sort((x, y) => y.n - x.n)
        .map((r) => fitRow({ ...r, pct: Math.round((r.n / max) * 100), label: String(r.n) }));
      return `<div class="overview">
        <h2>Today's edition by module</h2>
        <p>Select a dot on the radar or an article in the feed to open its study note.</p>
        <div class="fit">${rows.join('')}</div>
      </div>`;
    },
  },

  maritime: {
    title: 'Maritime Watch',
    hashKey: 'm',
    files: ['data/maritime.json', 'data/maritime-archive.json'],
    savedKey: 'mr.savedMaritime',
    allLabel: 'All countries',
    noteLabel: 'Briefing note',
    openLabel: 'Briefing',
    radarLabel: "Radar of today's maritime and port news by country",

    prepare(data, archive) {
      const nodes = (data.countries || []).map((c) => ({
        id: c.id, name: c.name, short: c.short, flag: c.flag || '', color: color(c.color), focus: !!c.focus, weight: c.focus ? 1.6 : 1,
      }));
      const ids = new Set(nodes.map((n) => n.id));
      const cats = {};
      (data.categories || []).forEach((c) => { cats[c.id] = { ...c, color: color(c.color) }; });
      const shape = (a, noted) => {
        a.countries = (a.countries || []).filter((c) => ids.has(c.id))
          .map((c) => ({ id: c.id, relevance: Math.max(0, Math.min(100, Math.round(Number(c.relevance) || 0))) }))
          .sort((x, y) => y.relevance - x.relevance);
        if (!a.countries.length && ids.has('GLOBAL')) a.countries = [{ id: 'GLOBAL', relevance: 50 }];
        a.nodes = a.countries;
        a.keyFigures = a.keyFigures || [];
        a.sub = a.summary || '';
        a.hasNote = noted;
        return a;
      };
      return {
        nodes,
        cats,
        brief: data.brief || null,
        noted: (data.items || []).filter((a) => a && a.id && a.title).map((a) => shape(a, true)).filter((a) => a.nodes.length),
        links: ((archive && archive.items) || []).filter((a) => a && a.id && a.title).map((a) => shape(a, false)),
        reshape: shape,
        meta: { generatedAt: data.generatedAt },
      };
    },
    dotColor: (a, D) => (D.cats[a.category] ? D.cats[a.category].color : '#d9dee9'),
    // Most urgent first, then the focus markets, then the newest.
    order(x, y) {
      const u = { high: 0, medium: 1, low: 2 };
      const f = (a) => (a.nodes.length && DESK_STATE.maritime.nodeMap[a.nodes[0].id].focus ? 0 : 1);
      return ((u[x.urgency] ?? 2) - (u[y.urgency] ?? 2)) || (f(x) - f(y)) || (new Date(y.publishedAt) - new Date(x.publishedAt));
    },

    briefLine(D) {
      const high = D.today.filter((a) => a.urgency === 'high').length;
      return D.today.length
        ? `${D.today.length} items today${high ? ` · ${high} high priority` : ''} · ${D.today.filter((a) => !read.has(a.id)).length} unread`
        : 'first edition tomorrow morning';
    },
    banner: () => '',
    foot(D) {
      const items = Object.values(D.cats).map((c) =>
        `<button type="button" class="leg${D.cat === c.id ? ' on' : ''}${D.cat && D.cat !== c.id ? ' off' : ''}" data-cat="${esc(c.id)}" style="--c:${c.color}" aria-pressed="${D.cat === c.id}"><i></i>${esc(c.name)}</button>`).join('');
      return `<div class="legend" role="group" aria-label="Filter by category">${items}</div>
        <p class="radar-hint">Each dot is a story, placed on the countries it affects. Colours show the category.</p>`;
    },
    nodeLabel: (n, narrow) => (narrow ? n.flag : `${n.flag} ${n.short}`),
    chipLabel: (n) => `<span class="flag">${n.flag}</span>${esc(n.short)}`,
    tagsHtml(a, D) {
      const cat = D.cats[a.category];
      const flags = a.nodes.slice(0, 4).map((c) => `<span class="tag flagtag" title="${esc(D.nodeMap[c.id].name)}">${D.nodeMap[c.id].flag} ${esc(D.nodeMap[c.id].short)}</span>`).join('');
      return `${cat ? `<span class="tag" style="--c:${cat.color}">${esc(cat.name)}</span>` : ''}${flags}`;
    },
    cardTop: (a) => (a.urgency === 'high' ? '<span class="urgent">High priority</span>' : ''),
    searchText: (a) => `${a.title} ${a.originalTitle || ''} ${a.source} ${a.summary || ''}`,

    detail(a, D) {
      const cat = D.cats[a.category];
      const date = fmtDate(a.publishedAt);
      const places = a.nodes.map((c) => {
        const n = D.nodeMap[c.id];
        return fitRow({ name: `${n.flag} ${n.name}`, color: n.color, pct: c.relevance, label: `${c.relevance}%` });
      }).join('');
      const facts = [
        a.effectiveDate ? `<li class="when"><b>Takes effect</b> ${esc(a.effectiveDate)}</li>` : '',
        ...(a.keyFigures || []).map((f) => `<li>${esc(f)}</li>`),
      ].join('');
      const urgency = { high: 'High priority', medium: 'Medium priority', low: 'Background' }[a.urgency] || '';
      const original = a.originalTitle && a.originalTitle.trim().toLowerCase() !== a.title.trim().toLowerCase();
      return `
        <p class="eyebrow"><span>${esc(a.source)}</span>${date ? ` · ${esc(date)}` : ''} ${basisTag(a)}</p>
        <div class="badges">${cat ? `<span class="tag" style="--c:${cat.color}">${esc(cat.name)}</span>` : ''}${urgency ? `<span class="prio ${esc(a.urgency)}">${urgency}</span>` : ''}</div>
        <h2>${esc(a.title)}</h2>
        ${original ? `<p class="orig">Original headline: ${esc(a.originalTitle)}</p>` : ''}
        <p class="takeaway">${esc(a.summary)}</p>
        <section class="block"><h3>Where it lands</h3><div class="fit">${places}</div></section>
        ${a.impact ? `<section class="block"><h3>What it means for you</h3><p>${esc(a.impact)}</p></section>` : ''}
        ${a.action ? `<section class="block action"><h3>What to do</h3><p>${esc(a.action)}</p></section>` : ''}
        ${facts ? `<section class="block"><h3>Key facts</h3><ul class="points facts">${facts}</ul></section>` : ''}
        ${isHttp(a.url) ? `<a class="cta" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">Read the source ${ICON.ext}</a>` : ''}
        <p class="fine">Briefing written by AI from ${a.basis === 'abstract' ? 'the publisher\'s summary' : 'the source text'}${original ? ', translated into English' : ''}. Check the source and the official notice before you act on it.</p>`;
    },

    overview(D) {
      const b = D.brief;
      const counts = nodeCounts(D.today);
      const max = Math.max(1, ...Object.values(counts));
      const rows = D.nodes.filter((n) => counts[n.id])
        .sort((x, y) => (counts[y.id] - counts[x.id]) || ((y.focus ? 1 : 0) - (x.focus ? 1 : 0)))
        .map((n) => fitRow({ name: `${n.flag} ${n.name}`, color: n.color, pct: Math.round((counts[n.id] / max) * 100), label: String(counts[n.id]) }));
      if (!b) {
        return `<div class="overview">
          <h2>Morning brief</h2>
          <p>The first maritime edition arrives with the next morning collection. It covers ports, customs, regulation and freight across Morocco, the UK, Spain, France, the Netherlands, the Gulf and the largest port countries.</p>
        </div>`;
      }
      const hi = (b.highlights || []).map((h) => {
        const a = D.byId[h.id];
        return `<li>${a ? `<button type="button" class="linkish" data-open="${esc(h.id)}">${esc(h.text)}</button>` : esc(h.text)}</li>`;
      }).join('');
      const dl = (b.deadlines || []).map((d) => {
        const n = D.nodeMap[d.country];
        return `<li><span class="dl-date">${esc(d.date)}</span><span class="dl-text">${n ? `${n.flag} ` : ''}${esc(d.text)}</span></li>`;
      }).join('');
      return `<div class="overview brief-view">
        <p class="eyebrow"><span>Morning brief</span> · ${esc(fmtDate(b.date, { weekday: 'long', day: 'numeric', month: 'long' }))}</p>
        <h2>${esc(b.headline)}</h2>
        <p class="takeaway">${esc(b.overview)}</p>
        ${hi ? `<section class="block"><h3>Highlights</h3><ul class="points">${hi}</ul></section>` : ''}
        ${dl ? `<section class="block"><h3>Deadlines and dates</h3><ul class="deadlines">${dl}</ul></section>` : ''}
        ${b.market ? `<section class="block"><h3>Freight market</h3><p>${esc(b.market)}</p></section>` : ''}
        ${rows.length ? `<section class="block"><h3>Today by country</h3><div class="fit">${rows.join('')}</div></section>` : ''}
        <p class="fine">Brief written by AI from today's sources. Check official notices before acting on a rule or deadline.</p>
      </div>`;
    },
  },
};

// Runtime state of each desk.
const DESK_STATE = {};
Object.keys(DESKS).forEach((id) => {
  DESK_STATE[id] = {
    loaded: false, failed: false, stamp: '', meta: {}, nodes: [], nodeMap: {}, cats: {}, brief: null,
    today: [], older: [], byId: {}, saved: store.get(DESKS[id].savedKey, {}),
    filter: null, cat: null, view: 'today', query: '',
  };
});

const state = {
  desk: DESKS[store.get('mr.desk', 'study')] ? store.get('mr.desk', 'study') : 'study',
  selected: null,      // an article id, or 'brief' for the maritime morning brief
};
let geom = null;       // last radar geometry, reused for hover links

const def = () => DESKS[state.desk];
const cur = () => DESK_STATE[state.desk];

function nodeCounts(articles) {
  const counts = {};
  articles.forEach((a) => a.nodes.forEach((m) => { counts[m.id] = (counts[m.id] || 0) + 1; }));
  return counts;
}

/* ── Data ───────────────────────────────────────────────── */

async function loadDesk(id) {
  const spec = DESKS[id];
  const D = DESK_STATE[id];
  const [res, arc] = await Promise.all([
    fetch(spec.files[0], { cache: 'no-store' }),
    fetch(spec.files[1], { cache: 'no-store' }).catch(() => null),
  ]);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const archive = arc && arc.ok ? await arc.json().catch(() => null) : null;
  const items = data.articles || data.items || [];
  const stamp = `${data.generatedAt}|${items.length}|${archive ? (archive.articles || archive.items || []).length : 0}`;
  if (stamp === D.stamp) return false;
  D.stamp = stamp;

  const p = spec.prepare(data, archive);
  D.nodes = p.nodes;
  D.nodeMap = Object.fromEntries(p.nodes.map((n) => [n.id, n]));
  D.cats = p.cats || {};
  D.brief = p.brief || null;
  D.meta = p.meta;
  p.noted.concat(p.links).forEach((a) => { a.c = spec.dotColor(a, D); a.when = a.addedAt || a.publishedAt || ''; });

  const latest = p.noted.reduce((max, a) => (a.addedAt && a.addedAt > max ? a.addedAt : max), '');
  D.today = p.noted.filter((a) => !latest || a.addedAt === latest).sort(spec.order);
  const seen = new Set(p.noted.map((a) => a.id));
  D.older = p.noted.filter((a) => latest && a.addedAt !== latest)
    .concat(p.links.filter((a) => !seen.has(a.id)))
    .sort((x, y) => (y.when > x.when ? 1 : y.when < x.when ? -1 : 0));
  D.byId = Object.fromEntries(p.noted.map((a) => [a.id, a]));
  Object.values(D.saved).forEach((a) => {
    if (a && a.id && !D.byId[a.id]) {
      const s = p.reshape({ ...a }, true);
      s.c = spec.dotColor(s, D);
      s.when = s.addedAt || s.publishedAt || '';
      D.byId[a.id] = s;
    }
  });
  if (D.filter && !D.nodeMap[D.filter]) D.filter = null;
  D.loaded = true;
  D.failed = false;
  return true;
}

async function load(manual) {
  const btn = $('#refresh');
  btn.classList.add('spin');
  const results = await Promise.allSettled(Object.keys(DESKS).map(loadDesk));
  results.forEach((r, i) => { if (r.status === 'rejected') DESK_STATE[Object.keys(DESKS)[i]].failed = true; });
  btn.classList.remove('spin');
  const changed = results.some((r) => r.status === 'fulfilled' && r.value);
  const failed = results.some((r) => r.status === 'rejected');
  if (changed) renderAll(); else renderHeader();
  if (manual) toast(failed && !changed ? 'Offline. Showing the last saved edition' : 'Edition up to date');
}

function pool(view, D = cur()) {
  if (view === 'archive') return D.older;
  if (view === 'saved') {
    return Object.keys(D.saved).map((id) => D.byId[id]).filter(Boolean)
      .sort((x, y) => new Date(y.publishedAt) - new Date(x.publishedAt));
  }
  return D.today;
}

function visible({ view, ignoreNode = false } = {}) {
  const D = cur();
  const spec = def();
  const q = D.query.trim().toLowerCase();
  return pool(view || D.view).filter((a) =>
    (ignoreNode || !D.filter || a.nodes.some((m) => m.id === D.filter)) &&
    (!D.cat || a.category === D.cat) &&
    (!q || spec.searchText(a).toLowerCase().includes(q)));
}

/* ── Header, desk switch, chips, feed ───────────────────── */

function renderHeader() {
  const spec = def();
  const D = cur();
  $('#title').textContent = spec.title;
  document.title = spec.title === 'MBA Radar' ? 'MBA Radar' : `${spec.title} · MBA Radar`;
  const date = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  $('#brief').textContent = D.loaded ? `${date} · ${spec.briefLine(D)}` : (D.failed ? `${date} · edition not available yet` : 'Loading today\'s edition');
  $('#updated').textContent = D.meta.generatedAt ? `Updated ${ago(D.meta.generatedAt)}` : '';
  const banner = D.loaded ? spec.banner(D) : '';
  $('#banner').innerHTML = banner ? `<div class="banner">${esc(banner)}</div>` : '';
  document.querySelectorAll('.desks button').forEach((b) => {
    const on = b.dataset.desk === state.desk;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    const unread = DESK_STATE[b.dataset.desk].today.filter((a) => !read.has(a.id)).length;
    b.querySelector('b').textContent = unread ? String(unread) : '';
  });
  document.querySelectorAll('.seg button').forEach((b) => {
    const on = b.dataset.view === D.view;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    const n = pool(b.dataset.view).length;
    b.querySelector('b').textContent = n ? String(n) : '';
  });
  $('#q').value = D.query;
  $('#q').placeholder = state.desk === 'maritime' ? 'Search ports, customs, freight' : 'Search articles';
  $('#chips').setAttribute('aria-label', state.desk === 'maritime' ? 'Filter by country' : 'Filter by module');
  $('.radar-panel').setAttribute('aria-label', spec.radarLabel);
}

function renderChips() {
  const spec = def();
  const D = cur();
  const all = visible({ ignoreNode: true });
  const counts = nodeCounts(all);
  const chip = (id, label, n, c, focus) =>
    `<button type="button" class="chip${D.filter === id ? ' on' : ''}${focus ? ' now' : ''}" data-m="${esc(id ?? '')}" aria-pressed="${D.filter === id}"${c ? ` style="--c:${c}"` : ''}>${c ? '<i></i>' : ''}${label}<b>${n}</b></button>`;
  // The maritime desk has many countries: show the focus markets and the ones with news today.
  const shown = state.desk === 'maritime' ? D.nodes.filter((n) => n.focus || counts[n.id] || D.filter === n.id) : D.nodes;
  const ordered = [...shown].sort((x, y) => (y.focus ? 1 : 0) - (x.focus ? 1 : 0));
  $('#chips').innerHTML = chip(null, esc(spec.allLabel), all.length, '') +
    ordered.map((m) => chip(m.id, spec.chipLabel(m), counts[m.id] || 0, m.color, m.focus)).join('');
}

function cardHtml(a) {
  const spec = def();
  const D = cur();
  const isRead = read.has(a.id);
  return `<a class="card ${isRead ? 'read' : 'unread'}${state.selected === a.id ? ' sel' : ''}" href="#${spec.hashKey}=${encodeURIComponent(a.id)}" data-open="${esc(a.id)}" style="--c:${a.c}">
    <div class="card-top"><span class="src">${esc(a.source)}</span><span>·</span><time datetime="${esc(a.publishedAt)}">${esc(ago(a.publishedAt))}</time>${spec.cardTop(a)}<span class="sp"></span>${D.saved[a.id] ? '<span class="star" title="Saved">★</span>' : ''}${isRead ? '' : '<span class="new" title="Unread"></span>'}</div>
    <h3>${esc(a.title)}</h3>
    <p class="take">${esc(a.sub)}</p>
    <div class="tags">${spec.tagsHtml(a, D, true)}</div>
  </a>`;
}

// Archive rows are deliberately light: the link to the original, and the note while it still exists.
function rowHtml(a) {
  const spec = def();
  const D = cur();
  const title = isHttp(a.url)
    ? `<a class="arow-title" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)} ${ICON.ext}</a>`
    : `<span class="arow-title">${esc(a.title)}</span>`;
  return `<div class="arow" style="--c:${a.c}">
    ${title}
    <div class="arow-meta"><span class="src">${esc(a.source)}</span>${spec.tagsHtml(a, D, false)}<span class="sp"></span>${a.hasNote ? `<button type="button" class="note-btn" data-open="${esc(a.id)}">${esc(spec.openLabel)}</button>` : ''}</div>
  </div>`;
}

function briefCard() {
  const D = cur();
  const b = D.brief;
  if (state.desk !== 'maritime' || !b || D.view !== 'today' || D.query || D.filter || D.cat) return '';
  return `<a class="card brief-card${state.selected === 'brief' ? ' sel' : ''}" href="#m=brief" data-open="brief">
    <div class="card-top"><span class="src">Morning brief</span><span>·</span><span>${esc(fmtDate(b.date, { weekday: 'long', day: 'numeric', month: 'short' }))}</span></div>
    <h3>${esc(b.headline)}</h3>
    <p class="take">${esc(b.overview)}</p>
    ${(b.deadlines || []).length ? `<div class="tags"><span class="tag" style="--c:#ffb454">${b.deadlines.length} date${b.deadlines.length > 1 ? 's' : ''} to watch</span></div>` : ''}
  </a>`;
}

function renderFeed() {
  const D = cur();
  if (!D.loaded) {
    $('#feed').innerHTML = D.failed
      ? `<div class="empty"><strong>${state.desk === 'maritime' ? 'The first maritime edition is on its way' : 'Couldn\'t load the edition'}</strong>${state.desk === 'maritime' ? 'It appears after the next morning collection.' : 'Check your connection, then refresh.'}</div>`
      : '';
    return;
  }
  const items = visible();
  if (!items.length) {
    const msg = {
      today: state.desk === 'maritime' && !D.today.length
        ? ['The first maritime edition is on its way', 'It appears after the next morning collection.']
        : ['Nothing matches', 'Clear the search or the filters.'],
      archive: D.older.length ? ['Nothing matches', 'Clear the search or the filters.'] : ['The archive starts tomorrow', 'Each morning, the previous edition moves here.'],
      saved: Object.keys(D.saved).length ? ['Nothing matches', 'Clear the search or the filters.'] : ['Save items to come back to them', 'Open one and select the star. Saved notes stay on this device.'],
    }[D.view];
    $('#feed').innerHTML = briefCard() + `<div class="empty"><strong>${msg[0]}</strong>${msg[1]}</div>`;
    return;
  }
  if (D.view === 'archive') {
    let last = '';
    $('#feed').innerHTML = items.map((a) => {
      const day = dayLabel(a.when);
      const head = day !== last ? `<div class="day">${esc(day)}</div>` : '';
      last = day;
      return head + rowHtml(a);
    }).join('');
    return;
  }
  const head = D.view === 'today' ? `<div class="day">Today's edition</div>` : '';
  $('#feed').innerHTML = briefCard() + head + items.map(cardHtml).join('');
}

/* ── Radar (always today's edition) ─────────────────────── */

function renderRadar() {
  const wrap = $('#radarWrap');
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  const spec = def();
  const D = cur();
  $('#radarFoot').innerHTML = D.loaded ? spec.foot(D) : '';
  if (!D.loaded || W < 50 || H < 50) { $('#radar').innerHTML = ''; geom = null; return; }

  const nodes = D.nodes;
  const cx = W / 2;
  const cy = H / 2;
  const narrow = W < 520;
  // Leave room outside the ring for the longest label (about 7px per character).
  const longest = Math.max(8, ...nodes.map((n) => String(spec.nodeLabel(n, false)).length + 3));
  const margin = narrow ? 72 : Math.min(150, Math.max(80, longest * 7 + 18));
  const R = Math.max(70, Math.min(W / 2 - margin, H / 2 - 34));
  const k = Math.max(0.62, Math.min(1.5, R / 200));
  wrap.style.setProperty('--R', `${R}px`);

  // Nodes share the circle by weight, so focus nodes get more room. The first node sits at the top.
  const total = nodes.reduce((s, n) => s + n.weight, 0) || 1;
  const pos = {};
  let run = 0;
  nodes.forEach((n, i) => {
    const centre = run + n.weight / 2 - (nodes[0] ? nodes[0].weight / 2 : 0);
    run += n.weight;
    const ang = -Math.PI / 2 + (centre / total) * 2 * Math.PI;
    pos[n.id] = { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang), cos: Math.cos(ang), sin: Math.sin(ang), i };
  });

  const arts = visible({ view: 'today' }).slice(0, 70);
  const counts = nodeCounts(visible({ view: 'today', ignoreNode: true }));

  // Each article sits at the relevance-weighted centre of its nodes, pulled slightly inward.
  const pts = arts.map((a) => {
    let sx = 0, sy = 0, sw = 0;
    a.nodes.forEach((m) => {
      if (!pos[m.id]) return;
      const w = (m.relevance / 100) ** 3 + 0.001;
      sx += pos[m.id].x * w; sy += pos[m.id].y * w; sw += w;
    });
    if (!sw) { sx = cx; sy = cy; sw = 1; }
    const h = hash(a.id);
    const jitter = 16 * k;
    return {
      a,
      x: cx + (sx / sw - cx) * 0.84 + ((h % 1000) / 1000 - 0.5) * jitter,
      y: cy + (sy / sw - cy) * 0.84 + (((h >>> 10) % 1000) / 1000 - 0.5) * jitter,
      r: (4.2 + ((a.nodes[0] ? a.nodes[0].relevance : 50) / 100) * 4.6) * k * (a.urgency === 'high' ? 1.15 : 1),
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
  const spokes = nodes.map((m) => `<line class="spoke" x1="${f(cx)}" y1="${f(cy)}" x2="${f(pos[m.id].x)}" y2="${f(pos[m.id].y)}"/>`).join('');

  const flagLabels = state.desk === 'maritime';
  const modNodes = nodes.map((m) => {
    const p = pos[m.id];
    const on = D.filter === m.id;
    let anchor = p.cos > 0.25 ? 'start' : p.cos < -0.25 ? 'end' : 'middle';
    let lx = p.x + p.cos * 15;
    let ly = p.y + p.sin * 15 + (anchor === 'middle' ? (p.sin < 0 ? -4 : 13) : 4);
    let label;
    if (flagLabels) {
      // Flags sit just outside the ring; on a phone they stand alone, on a wider screen with the name.
      const text = spec.nodeLabel(m, narrow);
      const n = counts[m.id] || 0;
      if (narrow) { anchor = 'middle'; lx = p.x + p.cos * 17; ly = p.y + p.sin * 17 + 5; }
      label = `<text x="${f(lx)}" y="${f(ly)}" text-anchor="${anchor}" class="${narrow ? 'flagonly' : ''}">${esc(text)}${!narrow && n ? ` <tspan class="n">${n}</tspan>` : ''}</text>`;
    } else {
      // On a phone there is no room beside the far-left and far-right nodes: tuck those labels above the node.
      if (narrow && Math.abs(p.sin) < 0.3) {
        anchor = p.cos > 0 ? 'end' : 'start';
        lx = p.x + (p.cos > 0 ? 14 : -14);
        ly = p.y - 15;
      }
      // On a phone, side labels drop their count and break onto two lines so they stay inside the screen.
      const words = String(m.short).split(' ');
      label = narrow && anchor !== 'middle'
        ? `<text x="${f(lx)}" y="${f(ly - (words.length > 1 ? 7 : 0))}" text-anchor="${anchor}">${words.map((w, i) => `<tspan x="${f(lx)}"${i ? ' dy="1.15em"' : ''}>${esc(w)}</tspan>`).join('')}</text>`
        : `<text x="${f(lx)}" y="${f(ly)}" text-anchor="${anchor}">${esc(m.short)} <tspan class="n">${counts[m.id] || 0}</tspan></text>`;
    }
    const nodeR = (m.focus && flagLabels ? 7.5 : 6) * k;
    return `<g class="mod${on ? ' on' : ''}${D.filter && !on ? ' off' : ''}${m.focus ? ' focus' : ''}" data-m="${esc(m.id)}" style="--c:${m.color}" tabindex="0" role="button" aria-pressed="${on}" aria-label="${esc(m.name)}${m.focus ? (flagLabels ? ', focus market' : ', the module you are studying now') : ''}, ${counts[m.id] || 0} today">
      <circle class="glow" cx="${f(p.x)}" cy="${f(p.y)}" r="${f(13 * k)}"/>
      ${m.focus ? `<circle class="now" cx="${f(p.x)}" cy="${f(p.y)}" r="${f(nodeR + 5 * k)}"/>` : ''}
      <circle class="node" cx="${f(p.x)}" cy="${f(p.y)}" r="${f(nodeR)}"/>
      ${label}
    </g>`;
  }).join('');

  const dots = pts.map((p) => {
    const cls = `${read.has(p.a.id) ? 'read' : 'unread'}${state.selected === p.a.id ? ' sel' : ''}`;
    return `<g class="dot ${cls}" data-id="${esc(p.a.id)}" style="--c:${p.a.c}" tabindex="0" role="link" aria-label="${esc(p.a.title)}">
      <circle class="halo" cx="${f(p.x)}" cy="${f(p.y)}" r="${f(p.r + 3)}"/>
      <circle class="core" cx="${f(p.x)}" cy="${f(p.y)}" r="${f(p.r)}"/>
    </g>`;
  }).join('');

  $('#radar').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(spec.radarLabel)}">
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
  const D = cur();
  const p = id && geom.pts[id];
  g.innerHTML = p
    ? p.a.nodes.filter((m) => geom.pos[m.id]).map((m) => {
        const t = geom.pos[m.id];
        return `<line class="link" x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${t.x.toFixed(1)}" y2="${t.y.toFixed(1)}" stroke="${D.nodeMap[m.id].color}" stroke-width="${(0.8 + (m.relevance / 100) * 2.4).toFixed(1)}"/>`;
      }).join('')
    : '';
}

function showTip(id) {
  const tip = $('#tip');
  const D = cur();
  const p = id && geom && geom.pts[id];
  if (!p) { tip.hidden = true; return; }
  const wrapW = $('#radarWrap').clientWidth;
  const where = p.a.nodes.map((m) => (state.desk === 'maritime' ? `${D.nodeMap[m.id].flag} ${D.nodeMap[m.id].short}` : D.nodeMap[m.id].short)).join(' + ');
  tip.innerHTML = `<small>${esc(p.a.source)} · ${esc(where)}</small>${esc(p.a.title)}`;
  tip.style.left = `${Math.max(130, Math.min(wrapW - 130, p.x))}px`;
  tip.style.top = `${Math.max(70, p.y)}px`;
  tip.hidden = false;
}

/* ── Detail ─────────────────────────────────────────────── */

function renderDetail() {
  const el = $('#detail');
  const spec = def();
  const D = cur();
  const sel = state.selected;
  const a = sel && sel !== 'brief' && D.byId[sel];
  const key = `${state.desk}:${sel || ''}`;
  // Re-rendering the same view (e.g. after saving) must not jump back to the top.
  const keepScroll = el.dataset.key === key ? el.scrollTop : 0;
  el.dataset.key = key;

  if (!a) {
    const body = D.loaded ? spec.overview(D) : '';
    el.style.setProperty('--c', state.desk === 'maritime' ? '#2de2e6' : '#8b7cff');
    el.innerHTML = sel === 'brief'
      ? `<div class="d-bar"><button type="button" class="icon-btn" data-act="close" aria-label="Back to radar">${ICON.back}</button><span class="d-bar-title">Morning brief</span></div><div class="d-body">${body}</div>`
      : body;
    el.scrollTop = keepScroll;
    return;
  }

  const saved = !!D.saved[a.id];
  el.style.setProperty('--c', a.c);
  el.innerHTML = `
    <div class="d-bar">
      <button type="button" class="icon-btn" data-act="close" aria-label="Back to radar">${ICON.back}</button>
      <span class="d-bar-title">${esc(spec.noteLabel)}</span>
      <button type="button" class="icon-btn${saved ? ' on' : ''}" data-act="save" aria-pressed="${saved}" aria-label="${saved ? 'Remove from saved' : 'Save'}">${ICON.star}</button>
    </div>
    <div class="d-body">${spec.detail(a, D)}</div>`;
  el.scrollTop = keepScroll;
}

/* ── Navigation and events ──────────────────────────────── */

function parseHash() {
  const m = /^#([am])=(.+)$/.exec(location.hash);
  if (!m) return null;
  return { desk: m[1] === 'm' ? 'maritime' : 'study', id: decodeURIComponent(m[2]) };
}

function route() {
  const h = parseHash();
  if (h && h.desk !== state.desk) { state.desk = h.desk; store.set('mr.desk', state.desk); renderChips(); }
  const D = cur();
  state.selected = h && (h.id === 'brief' ? (state.desk === 'maritime' && D.brief ? 'brief' : null) : (D.byId[h.id] ? h.id : null));
  if (state.selected && state.selected !== 'brief' && !read.has(state.selected)) {
    read.add(state.selected);
    store.set('mr.read', [...read].slice(-3000));
  }
  document.body.classList.toggle('detail-open', !!state.selected);
  document.body.dataset.desk = state.desk;
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
  renderHeader();
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

function setFilter(id) {
  const D = cur();
  D.filter = id && D.filter !== id ? id : null;
  refreshLists();
}

function setDesk(id) {
  if (!DESKS[id]) return;
  if (id === state.desk && !state.selected) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  state.desk = id;
  store.set('mr.desk', id);
  state.selected = null;
  history.replaceState(null, '', location.pathname + location.search);
  window.scrollTo(0, 0);
  renderAll();
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
}

function openItem(id) {
  const D = cur();
  if (id !== 'brief' && !D.byId[id]) return;
  const url = `#${def().hashKey}=${encodeURIComponent(id)}`;
  if (state.selected) history.replaceState({ fromApp: true }, '', url);
  else history.pushState({ fromApp: true }, '', url);
  route();
}

function toggleSaved(id) {
  const D = cur();
  const a = D.byId[id];
  if (!a) return;
  if (D.saved[id]) delete D.saved[id];
  else D.saved[id] = strip(a);
  store.set(def().savedKey, D.saved);
  toast(D.saved[id] ? 'Saved' : 'Removed from saved');
  renderHeader(); renderDetail(); renderFeed();
}

function bind() {
  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);
  $('#refresh').addEventListener('click', () => load(true));

  document.querySelectorAll('.desks button').forEach((b) => b.addEventListener('click', () => setDesk(b.dataset.desk)));

  // Any element with data-open (cards, archive buttons, brief highlights) opens that item.
  document.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-open]');
    if (!opener || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    openItem(opener.dataset.open);
  });

  $('#chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) setFilter(chip.dataset.m || null);
  });

  $('#radarFoot').addEventListener('click', (e) => {
    const leg = e.target.closest('.leg');
    if (!leg) return;
    const D = cur();
    D.cat = D.cat === leg.dataset.cat ? null : leg.dataset.cat;
    refreshLists();
  });

  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    cur().view = b.dataset.view;
    refreshLists();
  }));

  let qTimer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { cur().query = e.target.value; refreshLists(); }, 120);
  });

  const radar = $('#radarWrap');
  const activate = (target) => {
    const dot = target.closest('.dot');
    if (dot) return openItem(dot.dataset.id);
    const mod = target.closest('.mod');
    if (mod) setFilter(mod.dataset.m);
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
    if (btn.dataset.act === 'save' && state.selected && state.selected !== 'brief') toggleSaved(state.selected);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.selected) closeDetail();
  });

  let raf;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderRadar); }).observe(radar);

  // Pick up a fresh edition when the app comes back to the foreground.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') load(false);
  });
}

// Articles saved with the first version of the app were stored as ids only: carry them over once loaded.
function migrateSaved() {
  const ids = store.get('mr.saved', null);
  if (!Array.isArray(ids)) return;
  const D = DESK_STATE.study;
  ids.forEach((id) => { if (D.byId[id] && !D.saved[id]) D.saved[id] = strip(D.byId[id]); });
  store.set(DESKS.study.savedKey, D.saved);
  try { localStorage.removeItem('mr.saved'); } catch { /* nothing to clean */ }
}

bind();
document.body.dataset.desk = state.desk;
renderHeader();
load(false).then(() => { migrateSaved(); renderHeader(); });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
