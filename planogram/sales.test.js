const test = require('node:test');
const assert = require('node:assert');
const S = require('./sales.js');
const P = require('./engine.js');

test('Compharm-style report: title dates, header row, totals skipped', () => {
  const rows = [
    ['Stock Usage & History Per Item'], ['Usage from 01/09/2026 to 30/09/2026'], [],
    ['Stock Code', 'Description', 'Units', 'Total Excl', 'Total Cost'],
    ['6001', 'PANADO 500MG 24', 300, 1500, 900],
    ['6002', 'BENYLIN COUGH SYRUP 100ML', 90, 1800, 1000],
    ['Totals', '', 390, 3300, 1900],
  ];
  const r = S.parseSales(rows);
  assert.equal(r.days, 30); assert.equal(r.from, '2026-09-01'); assert.equal(r.to, '2026-09-30');
  assert.equal(r.items.length, 2); assert.equal(r.items[0].qty, 300);
});

test('transaction log: sums per item, period from date column incl. Excel serials', () => {
  const rows = [
    ['Date', 'Item', 'Qty'],
    [46000, 'Panado 500mg', 2], [46001, 'Panado 500mg', 3], [46009, 'Vitamin C 1000mg', 1],
  ];
  const r = S.parseSales(rows);
  assert.equal(r.days, 10);
  assert.equal(r.items.find((i) => i.name === 'Panado 500mg').qty, 5);
});

test('no usable header gives a clear error', () => {
  assert.throws(() => S.parseSales([['a', 'b'], [1, 2]]), /header row/);
});

test('matching: code first, then names, sizes must agree, one-to-one', () => {
  const sales = [
    { code: '6001', name: 'PANADO 500MG 24', qty: 300 },
    { code: '6002', name: 'BENYLIN COUGH SYRUP 100ML', qty: 90 },
    { code: '6003', name: 'BENYLIN COUGH SYRUP 200ML', qty: 40 },
  ];
  const products = [
    { sku: 'PH001', name: 'Panado 500mg x24' },
    { sku: 'PH002', name: 'Benylin cough syrup 100ml' },
    { sku: '6003', name: 'something else entirely' },
    { sku: 'PH004', name: 'Unknown thing' },
  ];
  const m = S.matchProducts(products, sales);
  assert.equal(m[0].item.code, '6001');
  assert.equal(m[1].item.code, '6002'); // not the 200ml
  assert.equal(m[2].by, 'code');
  assert.equal(m[3], null);
});

test('sales drive facings when the photo count is dropped', () => {
  const mk = (sku, v) => ({ sku, name: sku, category: 'x', width: 60, height: 110, depth: 40, velocity: v, unitsDeep: 5 });
  const l = P.generate([mk('fast', 10), mk('slow', 0.5)], { daysCover: 7 });
  const f = (s) => l.placements.find((p) => p.product.sku === s).facings;
  assert.ok(f('fast') > f('slow'));
});
