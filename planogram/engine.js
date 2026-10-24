/* Planogram auto-layout engine. No dependencies; works in the browser and in Node.
 *
 * Fixture: `shelves` rows (top to bottom) of `bays * bayWidth` mm. Dimensions are mm, velocity is units/day.
 * Steps: size facings from velocity -> shrink to fit -> block by category (vertical blocks)
 * -> put the fastest sellers on the best shelves (eye and hand level).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Planogram = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULTS = {
    bays: 4,
    bayWidth: 1000,
    shelves: 5,
    shelfHeights: null, // per shelf clearance in mm, top to bottom; default 300 each
    shelfDepth: 400,
    daysCover: 7, // days of sales to hold on the shelf
    fillTarget: 0.9, // leave 10% of the width free for packing losses
    shelfScores: null, // 0..1 value per shelf, top to bottom; default peaks at eye level
  };

  function num(v, fallback) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function normaliseProduct(p, i) {
    const out = {
      sku: String(p.sku != null && p.sku !== '' ? p.sku : 'P' + (i + 1)),
      name: String(p.name || p.sku || 'Item ' + (i + 1)),
      category: String(p.category || 'Uncategorised'),
      width: num(p.width, 0),
      height: num(p.height, 0),
      depth: num(p.depth, 0),
      velocity: Math.max(0, num(p.velocity, 0)),
      minFacings: Math.max(1, Math.floor(num(p.minFacings, 1))),
      maxFacings: Math.max(1, Math.floor(num(p.maxFacings, 8))),
    };
    if (out.maxFacings < out.minFacings) out.maxFacings = out.minFacings;
    return out;
  }

  function validate(p) {
    if (!(p.width > 0) || !(p.height > 0) || !(p.depth > 0)) return 'missing or zero size';
    return null;
  }

  function defaultScores(n) {
    if (n === 1) return [1];
    const s = [];
    for (let i = 0; i < n; i++) s.push(Math.max(0.1, 1 - Math.abs(i / (n - 1) - 0.4) * 1.2));
    return s;
  }

  function run(productsIn, o) {
    const S = o.shelves;
    const heights = o.shelfHeights && o.shelfHeights.length === S ? o.shelfHeights : Array(S).fill(300);
    const scores = o.shelfScores && o.shelfScores.length === S ? o.shelfScores : defaultScores(S);
    const rowLength = o.bays * o.bayWidth;
    const maxHeight = Math.max.apply(null, heights);

    const unplaced = [];
    const items = [];
    productsIn.map(normaliseProduct).forEach((p) => {
      const bad = validate(p);
      if (bad) return unplaced.push({ product: p, reason: bad });
      if (p.height > maxHeight) return unplaced.push({ product: p, reason: 'taller than every shelf' });
      if (p.width > rowLength) return unplaced.push({ product: p, reason: 'wider than the fixture' });
      const deep = Math.max(1, Math.floor(o.shelfDepth / p.depth));
      const wanted = Math.ceil((p.velocity * o.daysCover) / deep);
      p.unitsPerFacing = deep;
      p.facings = Math.min(p.maxFacings, Math.max(p.minFacings, wanted, 1));
      items.push(p);
    });

    // Shrink to fit: take a facing off whichever item has the most days of cover per width.
    const budget = rowLength * S * o.fillTarget;
    const used = () => items.reduce((a, p) => a + p.facings * p.width, 0);
    const cover = (p, f) => (p.velocity > 0 ? (f * p.unitsPerFacing) / p.velocity : Infinity);
    while (used() > budget) {
      let best = null;
      for (const p of items) {
        if (p.facings > p.minFacings) {
          const c = cover(p, p.facings - 1) / p.width; // cover left after the cut, per mm saved
          if (!best || c > best.c) best = { p, c };
        }
      }
      if (best) { best.p.facings--; continue; }
      // everything is at its minimum: drop the slowest item
      const slow = items.reduce((a, p) => (!a || p.velocity < a.velocity ? p : a), null);
      if (!slow) break;
      items.splice(items.indexOf(slow), 1);
      unplaced.push({ product: slow, reason: 'no room (slowest seller dropped)' });
    }

    // Group by category, biggest sellers first; within a category fastest first.
    const groups = {};
    items.forEach((p) => (groups[p.category] = groups[p.category] || []).push(p));
    const cats = Object.keys(groups).map((name) => {
      const list = groups[name].sort((a, b) => b.velocity - a.velocity || a.name.localeCompare(b.name));
      return { name, list, velocity: list.reduce((a, p) => a + p.velocity, 0), width: list.reduce((a, p) => a + p.facings * p.width, 0) };
    }).sort((a, b) => b.velocity - a.velocity || a.name.localeCompare(b.name));

    // Each shelf keeps its own cursor so category blocks stay in vertical columns.
    const rowsByScore = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);
    const placements = [];
    const rowFill = Array(S).fill(0);
    let cursor = 0;
    const blocks = [];

    for (const cat of cats) {
      const widest = Math.max.apply(null, cat.list.map((p) => p.facings * p.width));
      const start = cursor;
      let span = Math.max(widest, Math.ceil(cat.width / S / o.fillTarget));
      const rowEnd = () => Math.min(rowLength, start + span);
      for (let attempt = 0; attempt < 3; attempt++) {
        // Try the layout; if something doesn't fit in the span, widen it and retry.
        const trial = Array(S).fill(start);
        const placed = [];
        let failed = false;
        for (const p of cat.list) {
          const w = p.facings * p.width;
          let row = -1;
          for (const r of rowsByScore) {
            if (heights[r] >= p.height && trial[r] + w <= rowEnd() + 1e-6) { row = r; break; }
          }
          if (row < 0) { failed = true; break; }
          placed.push({ product: p, row, x: trial[row], width: w, facings: p.facings });
          trial[row] += w;
        }
        if (!failed) { placed.forEach((x) => placements.push(x)); trial.forEach((t, r) => (rowFill[r] = Math.max(rowFill[r], t))); break; }
        span += Math.ceil(widest / 2);
        if (attempt === 2 || start + span > rowLength) {
          // Last resort: place what fits, report the rest.
          const t2 = Array(S).fill(start);
          for (const p of cat.list) {
            const w = p.facings * p.width;
            const row = rowsByScore.find((r) => heights[r] >= p.height && t2[r] + w <= rowLength + 1e-6 && t2[r] + w <= start + span + 1e-6);
            if (row === undefined) { unplaced.push({ product: p, reason: 'no room left in the fixture' }); continue; }
            placements.push({ product: p, row, x: t2[row], width: w, facings: p.facings });
            t2[row] += w;
          }
          break;
        }
      }
      blocks.push({ category: cat.name, x: start, width: Math.min(span, rowLength - start) });
      cursor = Math.min(rowLength, start + span);
    }

    const placedWidth = placements.reduce((a, p) => a + p.width, 0);
    const rows = [];
    for (let r = 0; r < S; r++) rows.push({ index: r, height: heights[r], score: scores[r] });
    const summary = {
      products: productsIn.length,
      placed: new Set(placements.map((p) => p.product.sku)).size,
      unplaced: unplaced.length,
      fixtureWidth: rowLength,
      shelfSpace: rowLength * S,
      usedSpace: placedWidth,
      utilisation: placedWidth / (rowLength * S),
      // velocity-weighted shelf score: higher means fast sellers sit on better shelves
      attention: placements.reduce((a, p) => a + p.product.velocity * scores[p.row], 0) /
        (placements.reduce((a, p) => a + p.product.velocity, 0) || 1),
    };
    placements.forEach((p) => {
      p.daysCover = p.product.velocity > 0 ? (p.facings * p.product.unitsPerFacing) / p.product.velocity : null;
    });
    return { options: o, rows, blocks, placements, unplaced, summary };
  }

  // Column blocking wastes some width, so if items were dropped for lack of room, retry with a tighter budget.
  function generate(productsIn, optsIn) {
    const o = Object.assign({}, DEFAULTS, optsIn || {});
    let fill = o.fillTarget, best = null;
    for (let i = 0; i < 12 && fill >= 0.4; i++, fill -= 0.04) {
      const layout = run(productsIn, Object.assign({}, o, { fillTarget: fill }));
      if (!best || layout.unplaced.length < best.unplaced.length) best = layout;
      if (!layout.unplaced.some((u) => /no room left/.test(u.reason))) break;
    }
    return best;
  }

  // --- CSV -------------------------------------------------------------------------------
  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some((x) => x.trim() !== '')) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some((x) => x.trim() !== '')) rows.push(row);
    return rows;
  }

  const ALIASES = {
    sku: ['sku', 'code', 'stock code', 'item code', 'id'],
    name: ['name', 'description', 'product', 'item'],
    category: ['category', 'group', 'department', 'class'],
    width: ['width', 'w', 'width mm'],
    height: ['height', 'h', 'height mm'],
    depth: ['depth', 'd', 'depth mm', 'length'],
    velocity: ['velocity', 'sales per day', 'units per day', 'daily sales', 'sales/day'],
    minFacings: ['min facings', 'minfacings', 'min'],
    maxFacings: ['max facings', 'maxfacings', 'max'],
  };

  function productsFromCsv(text) {
    const table = parseCsv(text);
    if (!table.length) return [];
    const head = table[0].map((h) => h.trim().toLowerCase());
    const col = {};
    Object.keys(ALIASES).forEach((k) => {
      const i = head.findIndex((h) => ALIASES[k].includes(h));
      if (i >= 0) col[k] = i;
    });
    return table.slice(1).map((r) => {
      const p = {};
      Object.keys(col).forEach((k) => (p[k] = (r[col[k]] || '').trim()));
      return p;
    });
  }

  function layoutToCsv(layout) {
    const esc = (v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
    const lines = [['sku', 'name', 'category', 'shelf', 'x_mm', 'facings', 'units_per_facing', 'days_cover']];
    layout.placements
      .slice().sort((a, b) => a.row - b.row || a.x - b.x)
      .forEach((p) => lines.push([p.product.sku, p.product.name, p.product.category, p.row + 1, Math.round(p.x), p.facings, p.product.unitsPerFacing, p.daysCover == null ? '' : p.daysCover.toFixed(1)]));
    layout.unplaced.forEach((u) => lines.push([u.product.sku, u.product.name, u.product.category, '', '', '', '', 'UNPLACED: ' + u.reason]));
    return lines.map((l) => l.map(esc).join(',')).join('\n') + '\n';
  }

  return { DEFAULTS, generate, parseCsv, productsFromCsv, layoutToCsv };
});
