'use strict';

const http = require('http');

const role = process.env.DEMO_ROLE || 'frontend';
const port = Number(process.env.PORT || 9101);
const delay = Number(process.env.DEMO_DELAY || 0);
const ports = {
  frontend: Number(process.env.DEMO_FRONTEND_PORT || 9101),
  api: Number(process.env.DEMO_API_PORT || 9102),
  worker: Number(process.env.DEMO_WORKER_PORT || 9103),
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function pause() {
  if (!delay) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function postJson(targetPort, path, raw) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: targetPort,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(raw),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    req.end(raw);
  });
}

const handlers = {
  async frontend(req, res) {
    if (req.url.startsWith('/health')) return send(res, 200, { ok: true, service: 'frontend' });
    const raw = await readBody(req);
    await pause();
    const result = await postJson(ports.api, '/process', raw.length ? raw : Buffer.from('{}'));
    send(res, 200, { accepted: true, result: JSON.parse(result.text) });
  },
  async api(req, res) {
    if (req.url.startsWith('/health')) return send(res, 200, { ok: true, service: 'api' });
    const raw = await readBody(req);
    const incoming = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    await pause();
    const workerResponse = await fetch(`http://127.0.0.1:${ports.worker}/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: incoming.message || null }),
    });
    const worker = await workerResponse.json();
    send(res, 201, { id: 'job_demo', message: incoming.message || null, ...worker });
  },
  async worker(req, res) {
    if (req.url.startsWith('/health')) return send(res, 200, { ok: true, service: 'worker' });
    const raw = await readBody(req);
    const incoming = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    await pause();
    send(res, 200, { value: `value_${incoming.key || 'none'}`, apiKey: 'demo-key' });
  },
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      });
      return res.end();
    }
    await handlers[role](req, res);
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[demo] ${role} listening on ${port}\n`);
});
