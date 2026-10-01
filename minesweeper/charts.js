/**
 * The statistics sheet's trend charts: small multiples, one measure each (time, 3BV/s, efficiency), over the same
 * recent wins, so one game lines up across all three. Inline SVG drawn to the width it is given, in the page's quiet
 * style: a grey line with grey dots (the de-emphasis colour), the latest game in the accent, hollow dots for wins
 * with a hint, and two hairlines with their values on the right for scale. Each measure gets its own chart and axis,
 * never a second axis on one. Above each, its best and average; below them all, the latest game's values in words.
 *
 * Reading it: hover, touch or (once focused) the arrow keys pick a game in all three at once, and the line under them
 * says that game's values, politely announced. Each chart's `aria-label` says what it shows in words, and a table
 * of every point sits in a closed <details> beneath, so nothing is only in the picture.
 */

const NS = 'http://www.w3.org/2000/svg';
const HEIGHT = 58; // px of each chart: the plot plus room for the dots at its edges
const PAD = { top: 9, bottom: 9, left: 4, right: 40 }; // the right margin holds the latest value

const el = (doc, name, attrs = {}, parent = null) => {
  const node = doc.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (parent) parent.appendChild(node);
  return node;
};

/**
 * Round outwards to a step of 1, 2 or 5 times a power of ten (a fifth to a tenth of the span), so the hairlines sit
 * on clean numbers that their labels show exactly.
 */
export function niceRange(values) {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo;
  const power = 10 ** Math.floor(Math.log10(span));
  const m = span / power;
  const step = power * (m < 2 ? 0.2 : m < 5 ? 0.5 : 1);
  const round = (v) => Number(v.toPrecision(12)); // 0.6, not 0.6000000000000001
  return [round(Math.floor(lo / step + 1e-9) * step), round(Math.ceil(hi / step - 1e-9) * step)];
}

/**
 * The figure. `games` are the wins, oldest first: `{ when, hinted }`; `metrics` are
 * `{ title, unit, values (one per game), format(v), better: 'low' | 'high', describe }`; `width` is the px to draw to.
 * Returns the <figure> element, ready to insert.
 */
export function trendFigure(doc, { games, metrics, width, caption }) {
  const fig = doc.createElement('figure');
  fig.className = 'trends';
  fig.tabIndex = 0;
  fig.setAttribute('role', 'group');
  fig.setAttribute('aria-label', `${caption} Arrow keys pick a game.`);
  const n = games.length;
  const w = Math.max(200, Math.floor(width));
  const plotW = w - PAD.left - PAD.right;
  const x = (k) => PAD.left + (n === 1 ? plotW / 2 : (k * plotW) / (n - 1));
  const charts = [];

  for (const m of metrics) {
    const box = doc.createElement('div');
    box.className = 'trend';
    const head = doc.createElement('p');
    head.className = 'trend-head';
    const title = doc.createElement('span');
    title.className = 'trend-title';
    title.textContent = m.title;
    const sum = doc.createElement('span');
    sum.className = 'trend-sum';
    const clean = m.values.filter((v, k) => !games[k].hinted);
    const best = clean.length ? (m.better === 'low' ? Math.min(...clean) : Math.max(...clean)) : null;
    const avg = clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
    sum.textContent = best === null ? '' : `best ${m.format(best)} · average ${m.format(avg)}`;
    head.append(title, sum);

    const [lo, hi] = niceRange(m.values);
    const y = (v) => PAD.top + (1 - (v - lo) / (hi - lo)) * (HEIGHT - PAD.top - PAD.bottom);
    const svg = el(doc, 'svg', { width: w, height: HEIGHT, viewBox: `0 0 ${w} ${HEIGHT}`, role: 'img', class: 'trend-svg' });
    svg.setAttribute('aria-label', m.describe({ best, avg, first: m.values[0], last: m.values[n - 1], n }));
    // Scale: a hairline at each end of the range, with its value.
    for (const v of [hi, lo]) {
      el(doc, 'line', { x1: PAD.left, x2: PAD.left + plotW, y1: y(v), y2: y(v), class: 'trend-grid' }, svg);
      const t = el(doc, 'text', { x: PAD.left + plotW + 6, y: y(v) + 3.5, class: 'trend-tick' }, svg);
      t.textContent = m.format(v);
    }
    const cross = el(doc, 'line', { y1: 2, y2: HEIGHT - 2, class: 'trend-cross', visibility: 'hidden' }, svg);
    if (n > 1) el(doc, 'polyline', { points: m.values.map((v, k) => `${x(k).toFixed(1)},${y(v).toFixed(1)}`).join(' '), class: 'trend-line' }, svg);
    const dots = m.values.map((v, k) => el(doc, 'circle', {
      cx: x(k).toFixed(1), cy: y(v).toFixed(1), r: 3.5,
      class: `trend-dot${games[k].hinted ? ' is-hollow' : ''}${k === n - 1 ? ' is-last' : ''}`,
    }, svg));
    box.append(head, svg);
    fig.appendChild(box);
    charts.push({ svg, cross, dots, m });
  }

  const readout = doc.createElement('p');
  readout.className = 'trend-readout';
  readout.setAttribute('aria-live', 'polite');
  const cap = doc.createElement('figcaption');
  cap.className = 'trend-note';
  cap.textContent = caption + (games.some((g) => g.hinted) ? ' Hollow: with a hint, left out of best and average.' : '');
  fig.append(readout, cap);

  // A table of every point: the charts' values without the charts.
  const details = doc.createElement('details');
  details.className = 'trend-table';
  const summary = doc.createElement('summary');
  summary.textContent = 'As a table';
  const table = doc.createElement('table');
  const headRow = table.createTHead().insertRow();
  for (const label of ['Game', ...metrics.map((m) => m.title)]) {
    const th = doc.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    headRow.appendChild(th);
  }
  const body = table.createTBody();
  for (let k = n - 1; k >= 0; k--) {
    const row = body.insertRow();
    const th = doc.createElement('th');
    th.scope = 'row';
    th.textContent = games[k].when + (games[k].hinted ? ', hint' : '');
    row.appendChild(th);
    for (const m of metrics) row.insertCell().textContent = m.format(m.values[k]);
  }
  details.append(summary, table);
  fig.appendChild(details);

  // Picking a game: one index for every chart.
  let picked = -1;
  const describeGame = (k) => [games[k].when, ...metrics.map((m) => `${m.title} ${m.format(m.values[k])}`)].join(' · ') + (games[k].hinted ? ' · with a hint' : '');
  function pick(k) {
    picked = k;
    for (const c of charts) {
      c.cross.setAttribute('visibility', k < 0 ? 'hidden' : 'visible');
      if (k >= 0) { c.cross.setAttribute('x1', x(k)); c.cross.setAttribute('x2', x(k)); }
      c.dots.forEach((d, j) => {
        d.classList.toggle('is-picked', j === k);
        d.setAttribute('r', j === k ? 5 : 3.5);
      });
    }
    readout.textContent = k < 0 ? `Latest: ${describeGame(n - 1)}` : describeGame(k);
  }
  pick(-1);
  const fromPointer = (e) => {
    const r = charts[0].svg.getBoundingClientRect();
    const k = n === 1 ? 0 : Math.round(((e.clientX - r.left - PAD.left) / plotW) * (n - 1));
    pick(Math.max(0, Math.min(n - 1, k)));
  };
  for (const c of charts) {
    c.svg.addEventListener('pointermove', fromPointer);
    c.svg.addEventListener('pointerdown', fromPointer);
  }
  fig.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') pick(-1); });
  fig.addEventListener('keydown', (e) => {
    const keys = { ArrowLeft: -1, ArrowRight: 1 };
    if (e.key in keys) pick(Math.max(0, Math.min(n - 1, (picked < 0 ? n : picked) + keys[e.key])));
    else if (e.key === 'Home') pick(0);
    else if (e.key === 'End') pick(n - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  fig.addEventListener('blur', () => pick(-1));
  return fig;
}
