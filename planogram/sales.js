/* Reads a sales history sheet (rows as arrays, from Excel or CSV) and matches it to planogram products.
 * Handles Compharm's "Stock Usage" export (date range in the title, one row per item) and plain
 * transaction logs (one row per sale with a date column). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlanogramSales = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const COLS = {
    code: ['stock code', 'code', 'sku', 'item code', 'barcode', 'stockcode'],
    name: ['stock description', 'description', 'item', 'product', 'name', 'item description'],
    qty: ['units', 'qty', 'quantity', 'units sold', 'qty sold', 'sold'],
    date: ['date', 'sale date', 'transaction date', 'trandate', 'day'],
    revenue: ['total excl', 'sales', 'revenue', 'value', 'total'],
  };
  const cell = (v) => (v == null ? '' : String(v).trim());
  const low = (v) => cell(v).toLowerCase();
  const DAY = 86400000;

  function toDate(v) {
    if (v instanceof Date && !isNaN(v)) return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate());
    if (typeof v === 'number' && v > 20000 && v < 80000) return Math.round((v - 25569) * DAY); // Excel serial
    const s = cell(v);
    let m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/.exec(s);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return null;
  }

  function num(v) {
    if (typeof v === 'number') return v;
    const n = parseFloat(cell(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function parseSales(rows) {
    let h = -1, col = {};
    for (let i = 0; i < Math.min(rows.length, 25) && h < 0; i++) {
      const cells = rows[i].map(low);
      const found = {};
      Object.keys(COLS).forEach((k) => {
        const idx = cells.findIndex((c) => COLS[k].includes(c));
        if (idx >= 0) found[k] = idx;
      });
      if ((found.code != null || found.name != null) && found.qty != null) { h = i; col = found; }
    }
    if (h < 0) throw new Error('Could not find a header row with an item (code or description) column and a quantity column (Units or Qty).');

    // Period: "from dd/mm/yyyy to dd/mm/yyyy" printed above the header, else the span of a date column.
    let from = null, to = null;
    for (let i = 0; i < h && from == null; i++) {
      const text = rows[i].map(cell).join(' ');
      const m = /from\s+(\d{1,2})\/(\d{1,2})\/(\d{4}).*?to\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(text);
      if (m) { from = Date.UTC(+m[3], +m[2] - 1, +m[1]); to = Date.UTC(+m[6], +m[5] - 1, +m[4]); }
    }

    const byKey = new Map();
    let minD = null, maxD = null;
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i];
      const code = col.code != null ? cell(r[col.code]) : '';
      const name = col.name != null ? cell(r[col.name]) : '';
      const q = num(r[col.qty]);
      if ((!code && !name) || q == null || /^totals?$/i.test(code) || /^totals?$/i.test(name)) continue;
      if (col.date != null) {
        const d = toDate(r[col.date]);
        if (d != null) { minD = minD == null ? d : Math.min(minD, d); maxD = maxD == null ? d : Math.max(maxD, d); }
      }
      const key = code || name.toLowerCase();
      const it = byKey.get(key) || { code, name, qty: 0, revenue: 0 };
      it.qty += q;
      if (col.revenue != null) it.revenue += num(r[col.revenue]) || 0;
      if (!it.name && name) it.name = name;
      byKey.set(key, it);
    }
    if (from == null && minD != null) { from = minD; to = maxD; }
    const days = from != null ? Math.round((to - from) / DAY) + 1 : null;
    const iso = (t) => (t == null ? null : new Date(t).toISOString().slice(0, 10));
    return { items: [...byKey.values()], days, from: iso(from), to: iso(to) };
  }

  // --- matching ------------------------------------------------------------------------
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const tokens = (s) => norm(s).split(' ').filter(Boolean);
  const hasDigit = (t) => /\d/.test(t);

  function similarity(a, b) {
    const A = new Set(tokens(a)), B = new Set(tokens(b));
    if (!A.size || !B.size) return 0;
    let inter = 0; A.forEach((t) => B.has(t) && inter++);
    let score = inter / (A.size + B.size - inter);
    const na = [...A].filter(hasDigit), nb = [...B].filter(hasDigit);
    if (na.length && nb.length && !na.some((t) => B.has(t))) score *= 0.4; // sizes disagree (100ml vs 200ml)
    return score;
  }

  /* One-to-one: exact code first, then best name similarity at or above `threshold`. */
  function matchProducts(products, salesItems, threshold) {
    const min = threshold == null ? 0.5 : threshold;
    const result = products.map(() => null);
    const used = new Set();
    const byCode = new Map(salesItems.map((s, i) => [norm(s.code), i]).filter(([c]) => c));
    products.forEach((p, i) => {
      const k = norm(p.sku);
      if (k && byCode.has(k)) { result[i] = { item: salesItems[byCode.get(k)], score: 1, by: 'code' }; used.add(byCode.get(k)); }
    });
    const pairs = [];
    products.forEach((p, i) => {
      if (result[i]) return;
      salesItems.forEach((s, j) => { if (!used.has(j)) { const sc = similarity(p.name, s.name); if (sc >= min) pairs.push([sc, i, j]); } });
    });
    pairs.sort((a, b) => b[0] - a[0]);
    pairs.forEach(([sc, i, j]) => { if (!result[i] && !used.has(j)) { result[i] = { item: salesItems[j], score: sc, by: 'name' }; used.add(j); } });
    return result;
  }

  return { parseSales, matchProducts, similarity };
});
