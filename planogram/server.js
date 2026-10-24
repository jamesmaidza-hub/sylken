/* Tiny server: serves the planogram page and POST /api/analyze (shelf photo -> products).
 * Run: ANTHROPIC_API_KEY=... node server.js   (or `ant auth login` first). PORT defaults to 3100. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { analyseShelfPhoto, toProducts } = require('./vision.js');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const STATIC = new Set(['index.html', 'engine.js']);

function createServer(client) {
  return http.createServer(async (req, res) => {
    const send = (code, body, type) => { res.writeHead(code, { 'content-type': type || 'application/json' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
    try {
      if (req.method === 'POST' && req.url === '/api/analyze') {
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 12e6) return send(413, { error: 'Photo too large (12 MB max).' }); chunks.push(c); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch (e) { return send(400, { error: 'Bad request body.' }); }
        const analysis = await analyseShelfPhoto(client, body.image, body.hints);
        return send(200, { analysis, products: toProducts(analysis, body.daysCover) });
      }
      if (req.method === 'GET') {
        const name = req.url === '/' ? 'index.html' : req.url.slice(1).split('?')[0];
        if (STATIC.has(name)) return send(200, fs.readFileSync(path.join(__dirname, name)), TYPES[path.extname(name)]);
      }
      send(404, { error: 'Not found' });
    } catch (e) {
      const status = e.status && e.status < 600 ? e.status : 500;
      send(status, { error: status === 401 ? 'No Claude credentials found. Set ANTHROPIC_API_KEY or run `ant auth login`.' : e.message });
    }
  });
}

module.exports = { createServer };

if (require.main === module) {
  const Anthropic = require('@anthropic-ai/sdk');
  const port = +process.env.PORT || 3100;
  createServer(new Anthropic()).listen(port, () => console.log('Planogram on http://localhost:' + port));
}
