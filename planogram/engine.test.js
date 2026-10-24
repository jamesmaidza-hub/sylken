const test = require('node:test');
const assert = require('node:assert');
const P = require('./engine.js');

const mk = (sku, category, velocity, over) =>
  Object.assign({ sku, name: sku, category, width: 60, height: 120, depth: 50, velocity }, over);

function overlaps(layout) {
  const byRow = {};
  layout.placements.forEach((p) => (byRow[p.row] = byRow[p.row] || []).push(p));
  return Object.values(byRow).some((list) => {
    list.sort((a, b) => a.x - b.x);
    return list.some((p, i) => i > 0 && p.x < list[i - 1].x + list[i - 1].width - 1e-6);
  });
}

test('facings follow velocity and depth', () => {
  const l = P.generate([mk('A', 'x', 16)], { daysCover: 7, shelfDepth: 400 });
  // 8 units deep, 112 units wanted -> 14 facings, capped by maxFacings 8
  assert.equal(l.placements[0].facings, 8);
  const l2 = P.generate([mk('A', 'x', 2)], { daysCover: 7, shelfDepth: 400 });
  assert.equal(l2.placements[0].facings, 2);
});

test('nothing overlaps or leaves the fixture, and heights fit', () => {
  const items = [];
  for (let i = 0; i < 60; i++) items.push(mk('S' + i, 'cat' + (i % 6), (i * 7) % 23 + 1, { width: 40 + (i % 5) * 15, height: 80 + (i % 4) * 40 }));
  const l = P.generate(items, { bays: 3, shelves: 5 });
  assert.equal(overlaps(l), false);
  l.placements.forEach((p) => {
    assert.ok(p.x >= 0 && p.x + p.width <= l.summary.fixtureWidth + 1e-6);
    assert.ok(l.rows[p.row].height >= p.product.height);
  });
});

test('fast sellers land on better shelves than slow ones', () => {
  const items = [mk('fast', 'a', 30), mk('slow', 'a', 0.5)];
  const l = P.generate(items, {});
  const fast = l.placements.find((p) => p.product.sku === 'fast');
  const slow = l.placements.find((p) => p.product.sku === 'slow');
  assert.ok(l.rows[fast.row].score >= l.rows[slow.row].score);
});

test('categories stay in their own column block', () => {
  const items = [];
  for (let i = 0; i < 24; i++) items.push(mk('c' + i, i < 12 ? 'cough' : 'pain', 5 + (i % 7)));
  const l = P.generate(items, { bays: 3 });
  l.blocks.forEach((b) => {
    l.placements.filter((p) => p.product.category === b.category).forEach((p) => {
      assert.ok(p.x >= b.x - 1e-6 && p.x + p.width <= b.x + b.width + 1e-6, b.category + ' stays inside its block');
    });
  });
});

test('over-full range shrinks facings, then drops slowest, and reports why', () => {
  const items = [];
  for (let i = 0; i < 200; i++) items.push(mk('P' + i, 'c' + (i % 4), (i % 10) + 1));
  const l = P.generate(items, { bays: 2, shelves: 4 });
  assert.ok(l.summary.utilisation <= 0.9 + 1e-6);
  assert.ok(l.unplaced.length > 0);
  assert.ok(l.unplaced.every((u) => u.reason));
  assert.equal(overlaps(l), false);
});

test('bad rows and oversized items are unplaced, not thrown', () => {
  const l = P.generate([mk('ok', 'a', 3), mk('nosize', 'a', 3, { width: 0 }), mk('tall', 'a', 3, { height: 900 })], {});
  assert.equal(l.placements.length, 1);
  assert.deepEqual(l.unplaced.map((u) => u.product.sku).sort(), ['nosize', 'tall']);
});

test('csv in and out, with quotes and header aliases', () => {
  const csv = 'Stock Code,Description,Group,Width,Height,Depth,Sales per day\nA1,"Cough, syrup 100ml",cough,50,120,50,4\n';
  const prods = P.productsFromCsv(csv);
  assert.equal(prods[0].name, 'Cough, syrup 100ml');
  const out = P.layoutToCsv(P.generate(prods, {}));
  assert.ok(out.includes('"Cough, syrup 100ml"'));
});
