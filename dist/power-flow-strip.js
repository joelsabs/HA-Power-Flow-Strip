/*
 * power-flow-strip  (v2: ribbon flow)
 * A slim, backdrop-free power flow for the band above a 3D floor plan.
 *
 * Borrowed from Power Flow Card Plus (flixlix/power-flow-card-plus):
 *   - the split of solar / battery / grid / home into the seven possible flows
 *   - moving particles whose speed follows PFC+'s "new flow rate model"
 *   - the Home Assistant energy colours
 * Different: sources on the left, destinations on the right, joined by
 * ribbons whose thickness is the power (a small live Sankey). No panel behind
 * it; text switches between dark and light ink with the sun, to match the
 * day and night floor plan renders.
 *
 * Install: through HACS (Dashboard) or copy to /config/www/ and add the resource
 *   /local/power-flow-strip.js  (JavaScript module). See README.md.
 *
 * Config:
 *   type: custom:power-flow-strip
 *   entities:
 *     solar: sensor.sigen_0_plant_pv_power
 *     solar_today: sensor.sigen_0_daily_pv_energy
 *     battery: sensor.sigen_0_plant_battery_power
 *     battery_soc: sensor.sigen_0_plant_battery_soc
 *     grid: sensor.sigen_0_plant_grid_sensor_active_power
 *     grid_today: sensor.sigen_0_grid_sensor_daily_import_energy
 *     home: sensor.sigen_0_consumed_power
 *     home_today: sensor.sigen_0_daily_consumed_energy
 *   battery_positive_is_charging: true   # same as PFC+ invert_state: true
 *   grid_positive_is_import: true
 *   zero_tolerance: 50                   # watts treated as zero
 *   thresholds:                          # optional: hide flows to/from a node below these watts
 *     grid: 400                          # keys: solar, battery, grid, home
 *   min_flow_rate: 0.75                  # seconds for a particle to cross at max power
 *   max_flow_rate: 6                     # ... and at min power
 *   min_expected_power: 0.01             # watts
 *   max_expected_power: 2000             # watts
 *   mode: auto                           # auto | light | dark
 *   night_entity: sun.sun                # auto mode: below_horizon = light ink
 *   width: 640                           # px
 *   height: 104                          # px
 *   full_scale_power: 6000               # watts that fill the full height
 */

const VERSION = '1.1.0';

const COLORS = {
  solar: 'var(--energy-solar-color, #ff9800)',
  grid: 'var(--energy-grid-consumption-color, #488fc2)',
  export: 'var(--energy-grid-return-color, #8353d1)',
  battIn: 'var(--energy-battery-in-color, #f06292)',
  battOut: 'var(--energy-battery-out-color, #4db6ac)',
  home: 'var(--pfs-home, currentColor)',
};
// Plain hex copies for SVG gradients (CSS variables don't resolve inside <stop>s everywhere).
const HEX = { solar: '#ff9800', grid: '#488fc2', export: '#8353d1', battIn: '#f06292', battOut: '#4db6ac' };

// Left column: where power comes from. Right column: where it goes.
const SOURCES = [
  { key: 'solar',   color: 'solar',   icon: 'mdi:solar-power-variant', name: 'Solar' },
  { key: 'battery', color: 'battOut', icon: 'mdi:battery-arrow-up-outline', name: 'Battery' },
  { key: 'grid',    color: 'grid',    icon: 'mdi:transmission-tower-import', name: 'Grid' },
];
const SINKS = [
  { key: 'home',    color: 'home',    icon: 'mdi:home-outline', name: 'Home' },
  { key: 'battery', color: 'battIn',  icon: 'mdi:battery-charging-outline', name: 'Battery' },
  { key: 'grid',    color: 'export',  icon: 'mdi:transmission-tower-export', name: 'Export' },
];
const FLOWS = [
  ['solar', 'home'], ['solar', 'battery'], ['solar', 'grid'],
  ['battery', 'home'], ['battery', 'grid'],
  ['grid', 'home'], ['grid', 'battery'],
];
const fid = (a, b) => `${a}-${b}`;
const DASH = 14;           // particle spacing in px

class PowerFlowStrip extends HTMLElement {
  setConfig(config) {
    if (!config || !config.entities) throw new Error('power-flow-strip: `entities` is required');
    this._config = {
      battery_positive_is_charging: true, grid_positive_is_import: true, zero_tolerance: 50,
      min_flow_rate: 0.75, max_flow_rate: 6, min_expected_power: 0.01, max_expected_power: 2000,
      mode: 'auto', night_entity: 'sun.sun', width: 640, height: 104, full_scale_power: 6000,
      ...config,
    };
    this._built = false;
    if (this._hass) this._update();
  }
  set hass(hass) { this._hass = hass; if (this._config) this._update(); }
  getCardSize() { return 2; }

  // Shown when the card is added from the dashboard card picker; replace with your own sensors.
  static getStubConfig() {
    return {
      entities: {
        solar: 'sensor.solar_power',
        battery: 'sensor.battery_power',
        battery_soc: 'sensor.battery_state_of_charge',
        grid: 'sensor.grid_power',
        home: 'sensor.home_power',
      },
    };
  }

  // ---------- states ----------
  _num(id) {
    const st = id && this._hass.states[id];
    const v = st ? parseFloat(st.state) : NaN;
    return Number.isFinite(v) ? v : null;
  }
  _watts(id) {
    const v = this._num(id);
    if (v === null) return 0;
    const u = (this._hass.states[id].attributes.unit_of_measurement || 'W').toLowerCase();
    return u === 'kw' ? v * 1000 : u === 'mw' ? v * 1e6 : v;
  }

  // Same split as PFC+: solar charges the battery and exports first, the home gets the rest;
  // any shortfall is covered by the grid, then the battery.
  _compute() {
    const c = this._config, e = c.entities, z = v => (Math.abs(v) <= c.zero_tolerance ? 0 : v);
    const solar = Math.max(z(this._watts(e.solar)), 0);
    const grid = z(this._watts(e.grid)) * (c.grid_positive_is_import ? 1 : -1);
    const batt = z(this._watts(e.battery)) * (c.battery_positive_is_charging ? 1 : -1);
    const fromGrid = Math.max(grid, 0), toGrid = Math.max(-grid, 0);
    const toBatt = Math.max(batt, 0), fromBatt = Math.max(-batt, 0);
    const f = {};
    f['solar-battery'] = Math.min(solar, toBatt);
    f['solar-grid'] = Math.min(solar - f['solar-battery'], toGrid);
    f['solar-home'] = solar - f['solar-battery'] - f['solar-grid'];
    f['grid-battery'] = Math.min(toBatt - f['solar-battery'], fromGrid);
    f['battery-grid'] = Math.min(toGrid - f['solar-grid'], fromBatt);
    f['grid-home'] = Math.max(fromGrid - f['grid-battery'], 0);
    f['battery-home'] = Math.max(fromBatt - f['battery-grid'], 0);
    const home = e.home ? this._watts(e.home) : f['solar-home'] + f['grid-home'] + f['battery-home'];

    // Thresholds only hide things: they run after the split, so the flows that
    // stay visible keep their true values.
    const t = c.thresholds || {}, below = (k, w) => w > 0 && w < t[k];
    const hidden = {
      solar: below('solar', solar),
      battery: below('battery', toBatt + fromBatt),
      grid: below('grid', fromGrid + toGrid),
      home: below('home', home),
    };
    for (const [a, b] of FLOWS) if (hidden[a] || hidden[b]) f[fid(a, b)] = 0;

    return { flows: f, solar, fromGrid, toGrid, toBatt: hidden.battery ? 0 : toBatt, fromBatt, home };
  }

  // PFC+ new flow rate model: seconds to cross, linear between max and min rate.
  _rate(w) {
    const c = this._config;
    if (w > c.max_expected_power) return c.min_flow_rate;
    return ((w - c.min_expected_power) * (c.min_flow_rate - c.max_flow_rate)) /
      (c.max_expected_power - c.min_expected_power) + c.max_flow_rate;
  }

  _fmtW(w) {
    const a = Math.abs(w);
    return a >= 1000 ? `${(a / 1000).toFixed(1)} kW` : `${Math.round(a)} W`;
  }
  _kwh(id) { const v = this._num(id); return v === null ? '' : `${v.toFixed(1)} kWh`; }

  _dark() {
    const c = this._config;
    if (c.mode === 'dark') return true;
    if (c.mode === 'light') return false;
    const s = this._hass.states[c.night_entity];
    return s ? s.state === 'below_horizon' : false;
  }

  // ---------- DOM ----------
  _build() {
    const c = this._config, Wd = c.width, Ht = c.height;
    const label = (side, n) => `
      <button class="lab ${side}" id="l-${side}-${n.key}" data-k="${n.key}" hidden>
        <ha-icon icon="${n.icon}" style="color:${COLORS[n.color]}"></ha-icon>
        <span class="txt"><span class="v"></span><span class="cap"></span></span>
      </button>`;
    const root = this.shadowRoot || this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { display: block; width: ${Wd}px; height: ${Ht}px;
          --ink: #16202b; --halo: rgba(255,255,255,.9); --pfs-home: #5b6b80; --rib: .26; }
        :host([dark]) { --ink: #f1f4f8; --halo: rgba(0,0,0,.65); --pfs-home: #c9d3df; --rib: .34; }
        .wrap { position: relative; width: 100%; height: 100%; color: var(--ink);
          font-family: var(--paper-font-body1_-_font-family, Roboto, system-ui, sans-serif); }
        svg { position: absolute; inset: 0; overflow: visible; }
        .rib { transition: d .8s cubic-bezier(.4,0,.2,1), opacity .5s; }
        .flow { fill: none; stroke-linecap: round; transition: d .8s cubic-bezier(.4,0,.2,1), stroke-width .8s, opacity .5s; }
        .bar { transition: y .8s cubic-bezier(.4,0,.2,1), height .8s cubic-bezier(.4,0,.2,1), opacity .5s; }
        .lab { position: absolute; display: flex; align-items: center; gap: 7px; transform: translateY(-50%);
          transition: top .8s cubic-bezier(.4,0,.2,1); background: none; border: 0; padding: 0; margin: 0;
          color: inherit; font: inherit; cursor: pointer; text-shadow: 0 0 6px var(--halo), 0 0 2px var(--halo); }
        .lab[hidden] { display: none; }
        .lab.src { flex-direction: row-reverse; right: ${Wd - c._lx}px; text-align: right; }
        .lab.snk { left: ${c._rx}px; text-align: left; }
        .lab ha-icon { --mdc-icon-size: 20px; width: 20px; height: 20px; flex: none;
          filter: drop-shadow(0 0 3px var(--halo)); }
        .txt { display: flex; flex-direction: column; line-height: 1.1; }
        .v { font-size: 16px; font-weight: 600; letter-spacing: -.2px; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .cap { font-size: 11px; opacity: .72; white-space: nowrap; letter-spacing: .1px; }
        @media (prefers-reduced-motion: reduce) { .flow { display: none; } }
      </style>
      <div class="wrap">
        <svg width="${Wd}" height="${Ht}" viewBox="0 0 ${Wd} ${Ht}">
          <defs>${FLOWS.map(([a, b]) => {
            const sa = SOURCES.find(n => n.key === a), sb = SINKS.find(n => n.key === b);
            const ca = HEX[sa.color], cb = sb.color === 'home' ? null : HEX[sb.color];
            return `<linearGradient id="g-${fid(a, b)}" gradientUnits="userSpaceOnUse" x1="${c._bx1}" x2="${c._bx2}" y1="0" y2="0">
              <stop offset="0" stop-color="${ca}"/><stop offset="1" stop-color="${cb || ca}" stop-opacity="${cb ? 1 : .35}"/></linearGradient>`;
          }).join('')}</defs>
          ${FLOWS.map(([a, b]) => `<path class="rib" id="r-${fid(a, b)}" fill="url(#g-${fid(a, b)})" style="opacity:0"/>`).join('')}
          ${FLOWS.map(([a, b]) => `<path class="flow" id="f-${fid(a, b)}" stroke="${HEX[SOURCES.find(n => n.key === a).color]}" stroke-dasharray="0.01 ${DASH}" style="opacity:0"/>`).join('')}
          ${SOURCES.map(n => `<rect class="bar" id="b-src-${n.key}" x="${c._bx1 - 3}" width="3" rx="1.5" fill="${COLORS[n.color]}" y="0" height="0"/>`).join('')}
          ${SINKS.map(n => `<rect class="bar" id="b-snk-${n.key}" x="${c._bx2}" width="3" rx="1.5" fill="${COLORS[n.color]}" y="0" height="0"/>`).join('')}
        </svg>
        ${SOURCES.map(n => label('src', n)).join('')}
        ${SINKS.map(n => label('snk', n)).join('')}
      </div>`;
    this._$ = s => root.querySelector(s);
    this._anim = {};
    for (const [a, b] of FLOWS) {
      const el = this._$(`#f-${fid(a, b)}`);
      this._anim[fid(a, b)] = el.animate
        ? el.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: -DASH }], { duration: 1000, iterations: Infinity, easing: 'linear' })
        : null;
    }
    root.querySelectorAll('.lab').forEach(l => l.addEventListener('click', () => {
      const id = this._config.entities[l.dataset.k];
      if (id) this.dispatchEvent(new CustomEvent('hass-more-info', { bubbles: true, composed: true, detail: { entityId: id } }));
    }));
    this._built = true;
  }

  // Spread label centres so they never overlap (min gap), staying inside the strip.
  _spread(items, gap, lo, hi) {
    items.sort((p, q) => p.y - q.y);
    for (let i = 0; i < items.length; i++) items[i].y = Math.max(items[i].y, i ? items[i - 1].y + gap : lo);
    for (let i = items.length - 1; i >= 0; i--) items[i].y = Math.min(items[i].y, i < items.length - 1 ? items[i + 1].y - gap : hi);
    return items;
  }

  _update() {
    const c = this._config;
    // geometry: labels | bar | ribbons | bar | labels
    c._lx = 150; c._bx1 = 158; c._bx2 = c.width - 158; c._rx = c.width - 150;
    if (!this._built) this._build();
    this.toggleAttribute('dark', this._dark());

    const e = c.entities, r = this._compute(), f = r.flows, $ = this._$;
    const out = { solar: 0, battery: 0, grid: 0 }, inn = { home: 0, battery: 0, grid: 0 };
    for (const [a, b] of FLOWS) { out[a] += f[fid(a, b)]; inn[b] += f[fid(a, b)]; }
    const total = Math.max(out.solar + out.battery + out.grid, 1);

    // stack the bar segments; flows thinner than 1.5 px are drawn at 1.5 px
    const H = c.height, pad = 6, gap = 6;
    const segs = (list, amount) => {
      const shown = list.filter(n => amount[n.key] > 0);
      const avail = H - 2 * pad - gap * Math.max(shown.length - 1, 0);
      const k = avail / Math.max(total, c.full_scale_power);   // fixed scale, so 1 kW always looks like 1 kW
      let y = pad + (avail - total * k) / 2;
      const pos = {};
      for (const n of shown) { const h = Math.max(amount[n.key] * k, 1.5); pos[n.key] = { y, h, k }; y += h + gap; }
      return pos;
    };
    const sp = segs(SOURCES, out), kp = segs(SINKS, inn);

    // ribbons: walk each node's segment in the other column's order to avoid crossings
    const srcOff = {}, snkOff = {};
    for (const n of SOURCES) srcOff[n.key] = sp[n.key] ? sp[n.key].y : 0;
    for (const n of SINKS) snkOff[n.key] = kp[n.key] ? kp[n.key].y : 0;
    const x1 = c._bx1, x2 = c._bx2, mx = (x1 + x2) / 2;
    const order = [...FLOWS].sort((p, q) =>
      SOURCES.findIndex(n => n.key === p[0]) - SOURCES.findIndex(n => n.key === q[0]) ||
      SINKS.findIndex(n => n.key === p[1]) - SINKS.findIndex(n => n.key === q[1]));
    const sinkStart = {};
    for (const n of SINKS) sinkStart[n.key] = snkOff[n.key];
    // sink side is ordered by source order, which `order` already follows
    for (const [a, b] of order) {
      const id = fid(a, b), w = f[id], rib = $(`#r-${id}`), fl = $(`#f-${id}`);
      if (!(w > 0)) { rib.style.opacity = 0; fl.style.opacity = 0; continue; }
      const t = Math.max(w * sp[a].k, 1.5);
      const ya = srcOff[a], yb = sinkStart[b];
      srcOff[a] += t; sinkStart[b] += t;
      const d = `M${x1},${ya} C${mx},${ya} ${mx},${yb} ${x2},${yb} V${yb + t} C${mx},${yb + t} ${mx},${ya + t} ${x1},${ya + t} Z`;
      const cl = `M${x1},${ya + t / 2} C${mx},${ya + t / 2} ${mx},${yb + t / 2} ${x2},${yb + t / 2}`;
      rib.style.d = `path('${d}')`; rib.style.opacity = 'var(--rib)';
      fl.style.d = `path('${cl}')`; fl.style.opacity = 1;
      fl.setAttribute('stroke-width', Math.min(Math.max(t * 0.45, 2.5), 5));
      // particles cross the ribbon in _rate(w) seconds, like PFC+'s dots
      const speed = (x2 - x1) / this._rate(w);
      const a2 = this._anim[id];
      if (a2) { const rate = speed / DASH; if (Math.abs(a2.playbackRate - rate) > 0.02) (a2.updatePlaybackRate ? a2.updatePlaybackRate(rate) : (a2.playbackRate = rate)); }
    }

    // bars
    for (const n of SOURCES) { const b = $(`#b-src-${n.key}`), p = sp[n.key]; b.setAttribute('y', p ? p.y : H / 2); b.setAttribute('height', p ? p.h : 0); }
    for (const n of SINKS) { const b = $(`#b-snk-${n.key}`), p = kp[n.key]; b.setAttribute('y', p ? p.y : H / 2); b.setAttribute('height', p ? p.h : 0); }

    // labels
    const soc = this._num(e.battery_soc), socTxt = soc === null ? '' : `${Math.round(soc)}%`;
    const text = {
      'src-solar': [this._fmtW(r.solar), `Solar · ${this._kwh(e.solar_today)}`],
      'src-battery': [this._fmtW(r.fromBatt), `Battery · ${socTxt}`],
      'src-grid': [this._fmtW(r.fromGrid), `Grid · ${this._kwh(e.grid_today)}`],
      'snk-home': [this._fmtW(r.home), `Home · ${this._kwh(e.home_today)}`],
      'snk-battery': [r.toBatt > 0 ? this._fmtW(r.toBatt) : socTxt, r.toBatt > 0 ? `Battery · ${socTxt}` : 'Battery · idle'],
      'snk-grid': [this._fmtW(r.toGrid), 'Exporting'],
    };
    for (const [side, list, pos] of [['src', SOURCES, sp], ['snk', SINKS, kp]]) {
      const items = list.map(n => ({ n, y: pos[n.key] ? pos[n.key].y + pos[n.key].h / 2 : null }))
        .filter(i => i.y !== null || (side === 'snk' && i.n.key === 'battery' && !sp.battery));
      // an idle battery keeps its label (state of charge) on the right, below Home
      for (const i of items) if (i.y === null) i.y = H - pad - 10;
      this._spread(items, 34, 16, H - 16);
      for (const n of list) {
        const el = $(`#l-${side}-${n.key}`), it = items.find(i => i.n === n);
        el.hidden = !it;
        if (!it) continue;
        el.style.top = `${it.y}px`;
        const [v, cap] = text[`${side}-${n.key}`];
        el.querySelector('.v').textContent = v;
        el.querySelector('.cap').textContent = cap.replace(/ · $/, '');
      }
    }
    const bi = $('#l-snk-battery ha-icon');
    const want = r.toBatt > 0 ? 'mdi:battery-charging-outline' : soc === null ? 'mdi:battery-outline'
      : soc > 85 ? 'mdi:battery' : soc > 55 ? 'mdi:battery-70' : soc > 25 ? 'mdi:battery-40' : 'mdi:battery-10';
    if (bi.getAttribute('icon') !== want) bi.setAttribute('icon', want);
  }
}

if (!customElements.get('power-flow-strip')) {
  customElements.define('power-flow-strip', PowerFlowStrip);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'power-flow-strip', name: 'Power Flow Strip', preview: false,
    description: 'Slim live power flow (solar, battery, grid, home) for floor plans and dashboards',
    documentationURL: 'https://github.com/joelsabs/HA-Power-Flow-Strip',
  });
  console.info(`%c POWER-FLOW-STRIP %c ${VERSION} `, 'color:#fff;background:#ff9800;font-weight:600', 'color:#ff9800;background:#1c1c1c');
}
