'use strict';

/* MBA Radar — Freight desk.

   Pick two ports, a carrier and a container: a 3D globe draws the sea route with a ship sailing it,
   and the panel builds an indicative door-free cost (ocean freight plus terminal handling at each end)
   from the data the daily collector writes:

     data/ports.json          ports, regions and coordinates (static)
     data/routes/XXXXX.json   sea routes from port XXXXX to every other port (static)
     data/freight.json        today's public indices, exchange rates, and researched port charges,
                              lane rates and carrier surcharges, each with its sources            */

window.Freight = (() => {
  const GLOBE_JS = 'https://cdn.jsdelivr.net/npm/globe.gl@2.46.2/dist/globe.gl.min.js';
  const IMG = 'https://cdn.jsdelivr.net/npm/three-globe@2.45.6/example/img/';
  const SPEED = 16;                // knots: a typical container service speed today (slow steaming)
  const SPEEDS = [14, 19];         // the usual range between slow and fast services
  const CANAL_DAYS = { suez: 1, panama: 1.5 };   // transit plus a typical wait at the canal
  // Where each passage sits, to label it on the globe.
  const PASSAGE_AT = {
    suez: [32.35, 30.6], babalmandab: [43.4, 12.6], gibraltar: [-5.6, 35.95], malacca: [100.8, 2.9],
    panama: [-79.65, 9.1], ormuz: [56.4, 26.55], south_africa: [18.47, -34.8], sunda: [105.8, -6.0],
    bosporus: [29.05, 41.1], chili: [-70.9, -53.5], bering: [-168.9, 65.8], northwest: [-95, 74],
  };
  const PASSAGES = {
    suez: 'Suez Canal', babalmandab: 'Bab el-Mandeb', gibraltar: 'Strait of Gibraltar', malacca: 'Strait of Malacca',
    panama: 'Panama Canal', ormuz: 'Strait of Hormuz', south_africa: 'Cape of Good Hope', sunda: 'Sunda Strait',
    bosporus: 'Bosporus', chili: 'Strait of Magellan', bering: 'Bering Strait', northwest: 'Northwest Passage',
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, f) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch { return f; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* not persisted */ } },
  };
  const usd = (n) => (n == null || Number.isNaN(n) ? '—' : `$${Math.round(n).toLocaleString('en-GB')}`);
  const range = (lo, hi) => (lo == null ? '—' : Math.round(lo) === Math.round(hi) ? usd(lo) : `${usd(lo)} – ${usd(hi).slice(1)}`);
  const ext = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M11 7H6v11h11v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const day = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? (iso || '') : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };

  const S = {
    ready: false, ports: [], byCode: {}, regions: {}, data: null, routes: {},
    sel: store.get('mr.freight', { from: 'CNSHA', to: 'MAPTM', carrier: '', container: '40DV', route: 'main' }),
    globe: null, ship: null, path: null, anim: null,
  };

  /* ── Data ─────────────────────────────────────────────── */

  async function loadData() {
    const [p, f] = await Promise.all([
      fetch('data/ports.json', { cache: 'no-store' }).then((r) => r.json()),
      fetch('data/freight.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    S.ports = p.ports;
    S.regions = p.regions;
    S.byCode = Object.fromEntries(p.ports.map((x) => [x.code, x]));
    S.data = f;
    if (S.sel.cape) { S.sel.route = 'cape'; delete S.sel.cape; }   // older saved choice
    if (!S.sel.route) S.sel.route = 'main';
    if (!S.byCode[S.sel.from]) S.sel.from = 'CNSHA';
    if (!S.byCode[S.sel.to] || S.sel.to === S.sel.from) S.sel.to = S.sel.from === 'MAPTM' ? 'NLRTM' : 'MAPTM';
  }

  async function routeFor(from, to) {
    if (!S.routes[from]) S.routes[from] = fetch(`data/routes/${from}.json`).then((r) => r.json());
    const all = await S.routes[from];
    return all[to] || null;
  }

  /* ── Pricing ──────────────────────────────────────────── */

  const parent = (r) => (S.regions[r] && S.regions[r].parent) || r;

  // The trade lane a pair of ports is priced on: exact regions first, then their parent regions (Morocco -> Mediterranean).
  function laneData(o, d) {
    const tries = [[o.region, d.region], [parent(o.region), d.region], [o.region, parent(d.region)], [parent(o.region), parent(d.region)]];
    const indices = (S.data && S.data.indices) || [];
    const research = (S.data && S.data.research && S.data.research.lanes) || {};
    for (const [a, b] of tries) {
      const idx = indices.filter((x) => x.from === a && x.to === b);
      const res = research[`${a}>${b}`];
      if (idx.length || (res && res.found)) return { from: a, to: b, indices: idx, research: res && res.found ? res : null, viaParent: a !== o.region || b !== d.region };
    }
    const planned = ((S.data && S.data.researchLanes) || []).some((l) => tries.some(([a, b]) => l.from === a && l.to === b));
    return { from: o.region, to: d.region, indices: [], research: null, planned };
  }

  function container() {
    const list = (S.data && S.data.containers) || [];
    return list.find((c) => c.id === S.sel.container) || list[1] || { id: '40DV', name: "40' dry", size: '40', factor: [1, 1], teuFactor: [1.6, 2] };
  }

  function ocean(lane) {
    const c = container();
    if (lane.indices.length) {
      const vals = lane.indices.map((x) => x.value);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      return { lo: lo * c.factor[0], hi: hi * c.factor[1], basis: 'index' };
    }
    if (lane.research) {
      const r = lane.research;
      const lo = r.low ?? r.high, hi = r.high ?? r.low;
      const f = r.unit === 'TEU' ? c.teuFactor : c.factor;
      return { lo: lo * f[0], hi: hi * f[1], basis: 'research' };
    }
    return null;
  }

  function toUsd(amount, currency) {
    if (amount == null) return null;
    const cur = String(currency || 'USD').toUpperCase();
    if (cur === 'USD') return amount;
    const rate = S.data && S.data.fx && S.data.fx.rates && S.data.fx.rates[cur];
    return rate ? amount / rate : null;
  }

  function portCharge(port, side) {
    const r = S.data && S.data.research && S.data.research.ports && S.data.research.ports[port.code];
    if (!r) return { status: 'pending' };
    if (!r.found) return { status: 'none', checkedAt: r.checkedAt };
    const size = container().size;
    const amount = r[`thc_${side}_${size}`];
    return { status: amount == null ? 'partial' : 'ok', amount, currency: r.currency, usd: toUsd(amount, r.currency), r };
  }

  /* ── Panel ────────────────────────────────────────────── */

  function options(selected, exclude) {
    const groups = {};
    S.ports.forEach((p) => { (groups[p.country] = groups[p.country] || []).push(p); });
    const order = Object.keys(groups).sort((a, b) => (groups[b][0].focus - groups[a][0].focus) || groups[a][0].name.localeCompare(groups[b][0].name));
    return order.map((cty) => `<optgroup label="${esc(groups[cty][0].flag)} ${esc(cty)}">${groups[cty]
      .map((p) => `<option value="${p.code}"${p.code === selected ? ' selected' : ''}${p.code === exclude ? ' disabled' : ''}>${esc(p.flag)} ${esc(p.name)}</option>`).join('')}</optgroup>`).join('');
  }

  function renderForm() {
    const carriers = (S.data && S.data.carriers) || [];
    const containers = (S.data && S.data.containers) || [];
    $('#frForm').innerHTML = `
      <div class="fr-ports">
        <label class="fr-field"><span>From</span><select id="frFrom">${options(S.sel.from, S.sel.to)}</select></label>
        <button type="button" class="icon-btn fr-swap" id="frSwap" aria-label="Swap ports"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16M7 4L3 8M7 4l4 4M17 20V4M17 20l-4-4M17 20l4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <label class="fr-field"><span>To</span><select id="frTo">${options(S.sel.to, S.sel.from)}</select></label>
      </div>
      <div class="fr-row">
        <label class="fr-field"><span>Shipping line</span><select id="frCarrier"><option value="">Any line (market rate)</option>${carriers.map((c) => `<option value="${c.id}"${c.id === S.sel.carrier ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label class="fr-field"><span>Container</span><select id="frContainer">${containers.map((c) => `<option value="${c.id}"${c.id === S.sel.container ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      </div>
      <div class="fr-routes" id="frRoutes" role="radiogroup" aria-label="Itinerary" hidden></div>`;
  }

  /* ── Itineraries ──────────────────────────────────────── */

  // Every way to sail between the two ports: the shortest, then the alternatives stored with it.
  function itineraries(route) {
    if (!route) return [];
    return [{ id: 'main', ...route }, ...(route.alts || [])];
  }

  function chosen(route) {
    const list = itineraries(route);
    return list.find((r) => r.id === S.sel.route) || list[0] || null;
  }

  function routeName(leg) {
    const v = leg.via;
    if (v.includes('south_africa')) return 'Via the Cape of Good Hope';
    if (v.includes('suez')) return 'Via the Suez Canal';
    if (v.includes('panama')) return 'Via the Panama Canal';
    if (v.includes('chili')) return 'Via the Strait of Magellan';
    if (v.includes('ormuz')) return 'Via the Strait of Hormuz';
    if (v.includes('gibraltar')) return 'Via the Strait of Gibraltar';
    if (v.includes('malacca')) return 'Via the Strait of Malacca';
    return 'Direct';
  }

  function routeNote(leg) {
    if (leg.id === 'cape') return 'Avoids the Red Sea, as many lines still do';
    if (leg.id === 'nopanama') return 'Avoids the Panama Canal';
    return 'Shortest navigable route';
  }

  // Sailing time at a service speed, plus the time a canal transit usually takes.
  function seaDays(leg, knots = SPEED) {
    const canal = leg.via.reduce((t, v) => t + (CANAL_DAYS[v] || 0), 0);
    return leg.nm / (knots * 24) + canal;
  }

  const fmtNm = (n) => Math.round(n).toLocaleString('en-GB');
  const fmtDays = (d) => `${Math.max(1, Math.round(d))} day${Math.round(d) === 1 ? '' : 's'}`;

  function renderRoutes(route) {
    const box = $('#frRoutes');
    const list = itineraries(route);
    box.hidden = list.length < 2;
    if (list.length < 2) return;
    const best = list[0].nm;
    box.innerHTML = `<span class="fr-label">Itinerary</span>${list.map((leg) => `
      <button type="button" class="fr-opt${leg.id === (chosen(route) || {}).id ? ' on' : ''}" data-route="${leg.id}" role="radio" aria-checked="${leg.id === (chosen(route) || {}).id}">
        <span class="radio" aria-hidden="true"></span>
        <span><b>${esc(routeName(leg))}</b><small>${esc(routeNote(leg))}</small></span>
        <span class="fr-opt-n">${fmtNm(leg.nm)} nm<small>≈ ${fmtDays(seaDays(leg))}${leg.nm > best ? ` · +${fmtNm(leg.nm - best)} nm` : ''}</small></span>
      </button>`).join('')}`;
  }

  function renderHud(leg) {
    const o = S.byCode[S.sel.from], d = S.byCode[S.sel.to];
    $('#frHud').innerHTML = leg
      ? `<span><span class="leg-line"></span><b>${esc(o.name)} → ${esc(d.name)}</b></span><span class="sep"></span><span><b>${fmtNm(leg.nm)}</b> nm · ${fmtNm(leg.nm * 1.852)} km</span><span class="sep"></span><span>≈ <b>${fmtDays(seaDays(leg))}</b> at sea</span>`
      : '';
  }

  function sourceLinks(sources) {
    return (sources || []).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || new URL(s.url).hostname)} ${ext}</a>`).join('');
  }

  function renderResults(route) {
    const o = S.byCode[S.sel.from], d = S.byCode[S.sel.to];
    const c = container();
    const lane = laneData(o, d);
    const oc = ocean(lane);
    const exp = portCharge(o, 'export');
    const imp = portCharge(d, 'import');
    const carrier = ((S.data && S.data.carriers) || []).find((x) => x.id === S.sel.carrier);
    const carrierRes = carrier && S.data.research && S.data.research.carriers ? S.data.research.carriers[carrier.id] : null;

    const extra = (exp.usd || 0) + (imp.usd || 0);
    const total = oc ? [oc.lo + extra, oc.hi + extra] : null;
    const leg = chosen(route);

    // 1. Headline
    const missing = [];
    if (exp.usd == null) missing.push(`export handling at ${o.name}`);
    if (imp.usd == null) missing.push(`import handling at ${d.name}`);
    const head = `<div class="fr-total">
      <p class="eyebrow"><span>Indicative cost</span> · ${esc(c.name)} · ${esc(o.name)} → ${esc(d.name)}</p>
      <div class="fr-big">${total ? range(total[0], total[1]) : 'No public rate'}</div>
      <p class="fr-sub">${total
        ? `Ocean freight ${range(oc.lo, oc.hi)}${extra ? ` + port handling ${usd(extra)}` : ''}${missing.length ? `. Not included yet: ${esc(missing.join(' and '))}.` : '.'}`
        : `No free index or researched rate covers ${esc(S.regions[lane.from].name)} → ${esc(S.regions[lane.to].name)} yet.`}</p>
    </div>`;

    // 2. Voyage
    let voyage = '';
    if (leg) {
      const days = seaDays(leg);
      const eta = new Date(Date.now() + days * 86400000);
      voyage = `<section class="fr-block"><h3>Voyage</h3>
        <div class="fr-stats">
          <div><b>${fmtNm(leg.nm)}</b><span>nautical miles</span></div>
          <div><b>${fmtNm(leg.nm * 1.852)}</b><span>kilometres</span></div>
          <div><b>≈ ${Math.round(days)}</b><span>days at sea</span></div>
        </div>
        <div class="fr-eta"><span>Leaving today, arrival around</span><b>${eta.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long' })}</b></div>
        ${leg.via.length ? `<div class="fr-pass">${leg.via.map((v) => `<span>${esc(PASSAGES[v] || v)}</span>`).join('')}</div>` : ''}
        <p class="fr-note">${esc(routeName(leg))}: the shortest navigable sea distance on the main shipping lanes. Sailing time at ${SPEED} knots${leg.via.some((v) => CANAL_DAYS[v]) ? ', including the canal transit' : ''}; between ${fmtDays(seaDays(leg, SPEEDS[1]))} and ${fmtDays(seaDays(leg, SPEEDS[0]))} depending on the service. A direct call; transhipment and port stays add several days.</p>
      </section>`;
    }

    // 3. Ocean freight
    let oceanHtml;
    if (lane.indices.length) {
      const rows = lane.indices.map((x) => `<tr><td><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.source)}</a><small>${esc(x.date)}</small></td><td>${usd(x.value)}</td><td class="${x.change > 0 ? 'up' : x.change < 0 ? 'down' : ''}">${x.change == null ? '' : `${x.change > 0 ? '+' : ''}${x.change}%`}<small>${esc(x.changePeriod || '')}</small></td></tr>`).join('');
      oceanHtml = `<table class="fr-table"><thead><tr><th>Index, per 40' dry</th><th>USD</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table>
        <p class="fr-note">Spot market for ${esc(S.regions[lane.from].name)} → ${esc(S.regions[lane.to].name)}, base port to base port, ocean freight with bunker, before local charges.${lane.viaParent ? ` ${esc(o.region === 'MA' || d.region === 'MA' ? 'Moroccan ports are priced on the Mediterranean index; Casablanca and Agadir usually cost more than the Tanger Med hub.' : 'Priced on the nearest covered lane.')}` : ''}${c.id !== '40DV' ? ` Converted to a ${esc(c.name)} with an indicative factor of ${c.factor[0]}–${c.factor[1]}×${c.reefer ? '; public indices cover dry boxes only, so ask for a reefer quote' : ''}.` : ''}</p>
        ${S.data.wci && S.data.wci.outlook && lane.indices.some((x) => x.source.startsWith('Drewry')) ? `<p class="fr-outlook"><b>Drewry outlook (${esc(S.data.wci.date)}):</b> ${esc(S.data.wci.outlook)}</p>` : ''}`;
    } else if (lane.research) {
      const r = lane.research;
      oceanHtml = `<p class="fr-res"><b>${r.low != null && r.high != null && r.low !== r.high ? `${usd(r.low)} – ${usd(r.high).slice(1)}` : usd(r.low ?? r.high)}</b> per ${esc(r.unit)} ${esc(r.currency && r.currency !== 'USD' ? r.currency : '')} · ${esc(r.basis)} · ${esc(r.as_of)}</p>
        ${r.notes ? `<p class="fr-note">${esc(r.notes)}</p>` : ''}
        <div class="fr-src">${sourceLinks(r.sources)}</div>
        <p class="fr-note">Found by web research on ${esc(day(r.checkedAt))}; no free daily index covers this lane.</p>`;
    } else {
      oceanHtml = `<p class="fr-note">${lane.planned
        ? 'This lane is on the research rotation; its rate appears after one of the next morning collections.'
        : 'No free public index covers this lane, and it is not on the research list. Ask carriers or a forwarder for a quote.'}</p>`;
    }

    // 4. Port charges
    const portBlock = (port, side, ch) => {
      const label = side === 'export' ? 'Origin' : 'Destination';
      if (ch.status === 'pending') {
        return `<div class="fr-port"><h4>${label}: ${esc(port.flag)} ${esc(port.name)}</h4><p class="fr-note">${port.research
          ? 'This port is on the research rotation; its handling charges appear after one of the next morning collections.'
          : 'Handling charges are researched for the main ports only; ask the line or your forwarder for this port.'}</p></div>`;
      }
      if (ch.status === 'none') return `<div class="fr-port"><h4>${label}: ${esc(port.flag)} ${esc(port.name)}</h4><p class="fr-note">No published tariff found on ${esc(day(ch.checkedAt))}.</p></div>`;
      const r = ch.r;
      const others = (r.other_charges || []).filter((x) => x.applies === side || x.applies === 'both')
        .map((x) => `<li><span>${esc(x.name)}</span><b>${x.amount != null ? `${esc(x.currency || r.currency)} ${Number(x.amount).toLocaleString('en-GB')}` : ''}</b><small>${esc(x.per || '')}</small></li>`).join('');
      return `<div class="fr-port"><h4>${label}: ${esc(port.flag)} ${esc(port.name)}</h4>
        <ul class="fr-charges">
          <li><span>${side === 'export' ? 'Export' : 'Import'} THC, ${esc(container().size)}'</span><b>${ch.amount != null ? `${esc(r.currency)} ${Number(ch.amount).toLocaleString('en-GB')}` : 'not found'}</b><small>${ch.usd != null && r.currency !== 'USD' ? `≈ ${usd(ch.usd)}` : ''}</small></li>
          ${others}
        </ul>
        <p class="fr-note">${r.tariff_of ? `Tariff of ${esc(r.tariff_of)}. ` : ''}${r.effective ? `Applies from ${esc(r.effective)}. ` : ''}Checked ${esc(day(r.checkedAt))}.${container().reefer ? ' Reefer handling usually costs more.' : ''}</p>
        <div class="fr-src">${sourceLinks(r.sources)}</div>
      </div>`;
    };

    // 5. Carrier
    let carrierHtml = '';
    if (carrier) {
      const items = carrierRes && carrierRes.items ? carrierRes.items.map((i) => `<li><span class="kind">${esc(i.kind)}</span><div><b>${esc(i.name)}</b> ${esc(i.amount)}<small>${esc(i.trades)}${i.effective ? ` · from ${esc(i.effective)}` : ''}</small></div></li>`).join('') : '';
      carrierHtml = `<section class="fr-block"><h3>${esc(carrier.name)}</h3>
        <p class="fr-note">${esc(carrier.group)}. Lines do not publish their spot prices, so the ocean freight above is the market rate across carriers; ${esc(carrier.name)}'s own quote can sit above or below it.</p>
        ${carrierRes ? (items ? `<h4>Announced rate increases and surcharges</h4><ul class="fr-carrier">${items}</ul>` : '<p class="fr-note">No recent rate increase or surcharge found.</p>') + (carrierRes.summary ? `<p class="fr-note">${esc(carrierRes.summary)}</p>` : '') + `<div class="fr-src">${sourceLinks(carrierRes.sources)}</div><p class="fr-note">Checked ${esc(day(carrierRes.checkedAt))}.</p>` : '<p class="fr-note">This line\'s announcements have not been researched yet.</p>'}
        <a class="cta small" href="${esc(carrier.site)}" target="_blank" rel="noopener noreferrer">Request a quote from ${esc(carrier.name)} ${ext}</a>
      </section>`;
    }

    const updated = S.data ? `Indices and research updated ${esc(day(S.data.generatedAt))}. Exchange rates: <a href="${esc((S.data.fx || {}).source || '#')}" target="_blank" rel="noopener noreferrer">ExchangeRate-API</a>.` : '';
    $('#frResults').innerHTML = `${head}${voyage}
      <section class="fr-block"><h3>Ocean freight</h3>${oceanHtml}</section>
      <section class="fr-block"><h3>Port charges</h3>${portBlock(o, 'export', exp)}${portBlock(d, 'import', imp)}</section>
      ${carrierHtml}
      <p class="fine">Indicative only: market indices, published tariffs and AI web research, each with its source. Final prices depend on the line, contract, date and cargo; always confirm with a quote. ${updated}</p>`;
  }

  /* ── Globe ────────────────────────────────────────────── */

  function loadScript(src) {
    return new Promise((ok, fail) => {
      if (window.Globe) return ok();
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = () => ok(); s.onerror = () => fail(new Error('globe library'));
      document.head.appendChild(s);
    });
  }

  const SHIP_SVG = `<svg viewBox="0 0 40 40" aria-hidden="true"><defs><radialGradient id="shipglow"><stop offset="0" stop-color="#2de2e6" stop-opacity=".55"/><stop offset="1" stop-color="#2de2e6" stop-opacity="0"/></radialGradient></defs>
    <circle cx="20" cy="20" r="19" fill="url(#shipglow)"/>
    <path d="M20 5 L26 15 L26 31 L20 35 L14 31 L14 15 Z" fill="#e9eefb" stroke="#05070d" stroke-width="1.2"/>
    <rect x="16.5" y="16" width="7" height="3.2" fill="#ff8a4c"/><rect x="16.5" y="20.2" width="7" height="3.2" fill="#2de2e6"/><rect x="16.5" y="24.4" width="7" height="3.2" fill="#8b7cff"/>
    <rect x="17" y="28.6" width="6" height="3" fill="#05070d"/></svg>`;

  const dark = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const LOOK = {
    light: { img: 'earth-blue-marble.jpg', atmo: '#7dd3fc', route: ['#ffb020', '#ff5a36'], alt: 'rgba(255,255,255,0.55)', port: '#0891b2', other: 'rgba(255,255,255,0.75)', pass: '#fde68a' },
    dark: { img: 'earth-night.jpg', atmo: '#38bdf8', route: ['#22d3ee', '#a78bfa'], alt: 'rgba(148,163,184,0.45)', port: '#22d3ee', other: 'rgba(148,180,255,0.6)', pass: '#fde68a' },
  };
  const look = () => LOOK[dark() ? 'dark' : 'light'];

  async function initGlobe() {
    if (S.globe) return;
    const el = $('#globe');
    try { await loadScript(GLOBE_JS); } catch { el.innerHTML = '<p class="fr-note fr-noglobe">The 3D globe needs an internet connection.</p>'; return; }
    const shipEl = document.createElement('div');
    shipEl.className = 'ship';
    shipEl.innerHTML = SHIP_SVG;
    S.ship = { lat: 0, lng: 0, el: shipEl };
    S.globe = window.Globe({ animateIn: true })(el)
      .backgroundColor('rgba(0,0,0,0)')
      .globeImageUrl(`${IMG}${look().img}`)
      .bumpImageUrl(`${IMG}earth-topology.png`)
      .showAtmosphere(true).atmosphereColor(look().atmo).atmosphereAltitude(0.17)
      .pointsData([]).pointLat('lat').pointLng('lon').pointAltitude(0.005).pointRadius((p) => (p.sel ? 0.45 : 0.18))
      .pointColor((p) => (p.sel ? '#ffffff' : p.focus ? look().port : look().other)).pointsMerge(false)
      .onPointClick((p) => { setPort(p.code); })
      .labelsData([]).labelLat('lat').labelLng('lon').labelText('label').labelSize((l) => (l.pass ? 0.55 : 0.95))
      .labelDotRadius((l) => (l.pass ? 0.22 : 0.42)).labelColor((l) => (l.pass ? look().pass : '#ffffff'))
      .labelResolution(2).labelAltitude(0.012)
      .ringsData([]).ringLat('lat').ringLng('lon').ringColor(() => (t) => `rgba(45,226,230,${1 - t})`)
      .ringMaxRadius(3).ringPropagationSpeed(2).ringRepeatPeriod(1400)
      .pathsData([]).pathPoints('pts').pathPointLat((p) => p[1]).pathPointLng((p) => p[0]).pathPointAlt(0.004)
      .pathColor((p) => (p.on ? look().route : look().alt)).pathStroke((p) => (p.on ? 2.6 : 1.1))
      .pathDashLength((p) => (p.on ? 0.05 : 0.012)).pathDashGap((p) => (p.on ? 0.012 : 0.01))
      .pathDashAnimateTime((p) => (p.on ? 14000 : 0)).pathTransitionDuration(700)
      .htmlElementsData([S.ship]).htmlLat('lat').htmlLng('lng').htmlAltitude(0.02).htmlElement((d) => d.el)
      .htmlTransitionDuration(0);
    const ctl = S.globe.controls();
    ctl.autoRotate = false;
    ctl.enableDamping = true;
    sizeGlobe();
    new ResizeObserver(sizeGlobe).observe(el);
  }

  function sizeGlobe() {
    if (!S.globe) return;
    const el = $('#globe');
    S.globe.width(el.clientWidth).height(el.clientHeight);
  }

  // Unit vectors and slerp, so the ship follows great circles between route points like the drawn line.
  const toVec = ([lng, lat]) => { const a = lat * Math.PI / 180, b = lng * Math.PI / 180; return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)]; };
  const toLL = ([x, y, z]) => [Math.atan2(y, x) * 180 / Math.PI, Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI];
  function slerp(p, q, t) {
    const dot = Math.min(1, Math.max(-1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
    const w = Math.acos(dot);
    if (w < 1e-9) return p;
    const s = Math.sin(w), a = Math.sin((1 - t) * w) / s, b = Math.sin(t * w) / s;
    return [a * p[0] + b * q[0], a * p[1] + b * q[1], a * p[2] + b * q[2]];
  }

  function sailAlong(path) {
    cancelAnimationFrame(S.anim);
    const vecs = path.map(toVec);
    const seg = [0];
    for (let i = 1; i < vecs.length; i++) {
      const v = vecs[i - 1], w = vecs[i];
      seg.push(seg[i - 1] + Math.acos(Math.min(1, Math.max(-1, v[0] * w[0] + v[1] * w[1] + v[2] * w[2]))));
    }
    const total = seg[seg.length - 1] || 1;
    const duration = Math.min(28000, Math.max(9000, total * 9000));
    const start = performance.now();
    const at = (u) => {
      const dist = u * total;
      let i = 1;
      while (i < seg.length - 1 && seg[i] < dist) i++;
      const t = (dist - seg[i - 1]) / ((seg[i] - seg[i - 1]) || 1);
      return toLL(slerp(vecs[i - 1], vecs[i], Math.min(1, Math.max(0, t))));
    };
    let last = 0;
    const step = (now) => {
      S.anim = requestAnimationFrame(step);
      if (now - last < 33) return;   // about 30 frames a second is plenty
      last = now;
      const u = ((now - start) % (duration + 1500)) / duration;
      const k = Math.min(1, u);
      const [lng, lat] = at(k);
      const [lng2, lat2] = at(Math.min(1, k + 0.004));
      S.ship.lat = lat; S.ship.lng = lng;
      S.globe.htmlElementsData([S.ship]);
      const a = S.globe.getScreenCoords(lat, lng), b = S.globe.getScreenCoords(lat2, lng2);
      if (a && b && (Math.abs(b.x - a.x) + Math.abs(b.y - a.y) > 0.01)) {
        const deg = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI + 90;
        S.ship.el.firstElementChild.style.transform = `rotate(${deg.toFixed(1)}deg)`;
      }
      S.ship.el.style.opacity = u > 1 ? '0' : '1';
    };
    S.anim = requestAnimationFrame(step);
  }

  function frameRoute(path, nm) {
    // Centre the camera on the route's middle point, and back off for long routes.
    const mid = toLL(slerp(toVec(path[0]), toVec(path[path.length - 1]), 0.5));
    const midOnRoute = path[Math.floor(path.length / 2)];
    const lat = (mid[1] + midOnRoute[1]) / 2, lng = Math.abs(mid[0] - midOnRoute[0]) > 90 ? midOnRoute[0] : (mid[0] + midOnRoute[0]) / 2;
    const altitude = Math.min(2.6, Math.max(0.9, 0.7 + nm / 5500));
    S.globe.pointOfView({ lat, lng, altitude }, 1400);
  }

  function drawGlobe(route) {
    if (!S.globe) return;
    const leg = chosen(route);
    // Only redraw when the itinerary itself changes, not when the line or container does.
    const key = `${S.sel.from}>${S.sel.to}>${leg ? leg.id : '-'}>${dark() ? 'd' : 'l'}`;
    if (key === S.drawn) return;
    S.drawn = key;
    const o = S.byCode[S.sel.from], d = S.byCode[S.sel.to];
    S.globe.pointsData(S.ports.map((p) => ({ ...p, sel: p.code === o.code || p.code === d.code })));
    const passes = leg ? leg.via.filter((v) => PASSAGE_AT[v]).map((v) => ({ lon: PASSAGE_AT[v][0], lat: PASSAGE_AT[v][1], label: PASSAGES[v], pass: true })) : [];
    S.globe.labelsData([{ ...o, label: o.name }, { ...d, label: d.name }, ...passes]);
    S.globe.ringsData([o, d]);
    if (!leg) { S.globe.pathsData([]); return; }
    // The chosen itinerary is drawn bright and animated; the alternatives stay faint for comparison.
    S.globe.pathsData(itineraries(route).map((r) => ({ pts: r.path, on: r.id === leg.id })).sort((a, b) => a.on - b.on));
    frameRoute(leg.path, leg.nm);
    sailAlong(leg.path);
  }

  function retheme() {
    if (!S.globe) return;
    S.globe.globeImageUrl(`${IMG}${look().img}`).atmosphereColor(look().atmo);
    S.drawn = null;
    if (S.ready) update();
  }

  /* ── Flow ─────────────────────────────────────────────── */

  async function update() {
    store.set('mr.freight', S.sel);
    const route = await routeFor(S.sel.from, S.sel.to).catch(() => null);
    if (route && !itineraries(route).some((r) => r.id === S.sel.route)) S.sel.route = 'main';
    renderRoutes(route);
    renderHud(chosen(route));
    renderResults(route);
    drawGlobe(route);
  }

  function setPort(code) {
    // Clicking a port on the globe: it becomes the destination, or the origin when it already is the destination.
    if (code === S.sel.from || code === S.sel.to) return;
    S.sel.to = code;
    S.sel.route = 'main';
    renderForm(); bindForm(); update();
  }

  function bindForm() {
    $('#frFrom').addEventListener('change', (e) => { S.sel.from = e.target.value; S.sel.route = 'main'; renderForm(); bindForm(); update(); });
    $('#frTo').addEventListener('change', (e) => { S.sel.to = e.target.value; S.sel.route = 'main'; renderForm(); bindForm(); update(); });
    $('#frSwap').addEventListener('click', () => { [S.sel.from, S.sel.to] = [S.sel.to, S.sel.from]; renderForm(); bindForm(); update(); });
    $('#frCarrier').addEventListener('change', (e) => { S.sel.carrier = e.target.value; update(); });
    $('#frContainer').addEventListener('change', (e) => { S.sel.container = e.target.value; update(); });
    $('#frRoutes').addEventListener('click', (e) => {
      const b = e.target.closest('[data-route]');
      if (b) { S.sel.route = b.dataset.route; update(); }
    });
  }

  async function show() {
    if (!S.ready) {
      try { await loadData(); } catch {
        $('#frResults').innerHTML = '<div class="empty"><strong>Freight data could not be loaded</strong>Check your connection, then refresh.</div>';
        return;
      }
      S.ready = true;
      renderForm();
      bindForm();
    }
    await initGlobe();
    sizeGlobe();
    update();
  }

  function hide() { cancelAnimationFrame(S.anim); S.drawn = null; }

  async function refresh() {
    if (!S.ready) return show();
    try {
      const f = await fetch('data/freight.json', { cache: 'no-store' });
      if (f.ok) { S.data = await f.json(); renderForm(); bindForm(); update(); }
    } catch { /* keep what is shown */ }
  }

  function briefLine() {
    if (!S.data) return 'freight rates, port charges and sea routes';
    const fe = (S.data.indices || []).find((x) => x.from === 'FE' && x.to === 'NEU');
    return `${(S.data.indices || []).length} index lanes${fe ? ` · Asia → N. Europe ${usd(fe.value)}/40'` : ''}`;
  }

  return { show, hide, refresh, briefLine, retheme, get updated() { return S.data && S.data.generatedAt; } };
})();
