const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('./server.js');
const P = require('./engine.js');
const V = require('./vision.js');

const analysis = {
  shelf_count: 2, notes: '',
  products: [
    { name: 'Panado 500mg x24', category: 'Pain relief', shelf: 1, position: 1, facings: 3, units_deep: 4, width_mm: 60, height_mm: 110, depth_mm: 40, confidence: 'high' },
    { name: 'Benylin 100ml', category: 'Cough & cold', shelf: 2, position: 1, facings: 2, units_deep: 3, width_mm: 50, height_mm: 140, depth_mm: 50, confidence: 'medium' },
  ],
};
const fakeClient = (capture) => ({ messages: { create: async (req) => { capture.req = req; return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(analysis) }] }; } } });

async function post(server, body) {
  await new Promise((r) => server.listen(0, r));
  const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/analyze', { method: 'POST', body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

test('photo goes to Claude as an image, result becomes quantified products', async () => {
  const cap = {}; const server = createServer(fakeClient(cap));
  const { status, json } = await post(server, { image: 'data:image/jpeg;base64,AAAA', daysCover: 7, hints: { bayWidthMm: 1200 } });
  server.close();
  assert.equal(status, 200);
  assert.equal(cap.req.model, 'claude-opus-5-5');
  assert.equal(cap.req.messages[0].content[0].type, 'image');
  assert.equal(cap.req.messages[0].content[0].source.media_type, 'image/jpeg');
  assert.ok(cap.req.messages[0].content[1].text.includes('1200 mm'));
  assert.equal(cap.req.output_config.format.type, 'json_schema');
  const [a] = json.products;
  assert.equal(a.fixedFacings, 3); assert.equal(a.unitsDeep, 4);
  assert.equal(a.velocity, +(12 / 7).toFixed(2)); // 3 facings x 4 deep = 12 units on shelf
});

test('quantities from the photo survive layout: facings and units per facing unchanged', async () => {
  const layout = P.generate(V.toProducts(analysis, 7), { bays: 2, shelves: 3 });
  const a = layout.placements.find((p) => p.product.name.startsWith('Panado'));
  assert.equal(a.facings, 3);
  assert.equal(a.product.unitsPerFacing, 4);
  assert.equal(layout.unplaced.length, 0);
});

test('bad image and refusals return clear errors', async () => {
  const server = createServer(fakeClient({}));
  const bad = await post(server, { image: 'not an image' });
  server.close();
  assert.equal(bad.status, 400);
  const refusing = createServer({ messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } });
  const r = await post(refusing, { image: 'data:image/png;base64,AAAA' });
  refusing.close();
  assert.equal(r.status, 422);
});

test('server serves the page as HTML, not JSON', async () => {
  const server = createServer(fakeClient({}));
  await new Promise((r) => server.listen(0, r));
  const res = await fetch('http://127.0.0.1:' + server.address().port + '/');
  const text = await res.text();
  server.close();
  assert.equal(res.headers.get('content-type'), 'text/html');
  assert.ok(text.startsWith('<!doctype html>'));
});
