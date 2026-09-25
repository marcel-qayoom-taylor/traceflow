'use strict';

// Local-only HTTP capture. Loaded with NODE_OPTIONS=--require.
// Fail open: a bug here must never take down the service.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

let SERVICE = process.env.TRACEFLOW_SERVICE;
if (!SERVICE) return;

let INGEST = process.env.TRACEFLOW_INGEST || 'http://127.0.0.1:9477';
let TOKEN = process.env.TRACEFLOW_TOKEN || '';
let ingestUrl = new URL(INGEST);
const als = new AsyncLocalStorage();
const MAX_STORE = 48_000;
const MAX_BUFFER = 1_000_000;
const LOG_CHUNK = 16_384;
const FLUSH_AT = 40;
const FLUSH_MS = 50;
const EVENT_QUEUE_MAX = 400;
const INGEST_BATCH_BYTES = 1_500_000;
const BROWSER_SCRIPT_PATH = '/__traceflow/browser.js';
const BROWSER_EVENT_PATH = '/__traceflow/browser-event';
let browserAgent = '';
try {
  browserAgent = fs.readFileSync(path.join(__dirname, 'browser.js'), 'utf8');
} catch {
  // Browser capture stays unavailable if the optional asset is missing.
}

const DEFAULT_IGNORE = ['/health', '/healthcheck', '/ready', '/metrics', '/favicon.ico'];

let control = {
  mode: 'run',
  pauseOnResponse: true,
  captureBrowser: true,
  captureDebug: false,
  capture: 'all',
  include: [],
  ignore: DEFAULT_IGNORE,
};

try {
  if (process.env.TRACEFLOW_CONTROL) {
    control = { ...control, ...JSON.parse(process.env.TRACEFLOW_CONTROL) };
  }
} catch {
  // keep defaults
}

let peers = [];
try {
  peers = JSON.parse(process.env.TRACEFLOW_PEERS || '[]');
} catch {
  peers = [];
}

const rawRequest = http.request;

function install() {
  const next = { service: SERVICE, ingest: INGEST, token: TOKEN, control, peers, browserAgent };
  if (global.__traceflowAgentController?.reconfigure) {
    global.__traceflowAgentController.reconfigure(next);
    global.__traceflowAttachState = 'reconfigured';
    return;
  }
  if (global.__traceflowInstalled) {
    global.__traceflowAttachState = 'restart-required';
    return;
  }
  global.__traceflowInstalled = true;
  global.__traceflowAttachState = 'installed';
  global.__traceflowAgentController = { reconfigure };
  patchModule(http);
  patchModule(https);
  patchFetch();
  patchServerEmit();
  patchOutput(process.stdout);
  patchOutput(process.stderr);
  scheduleControl(0);
  postNow({ type: 'hello', service: SERVICE });
  const hello = setInterval(() => postNow({ type: 'hello', service: SERVICE }), 2000);
  hello.unref();
}

function reconfigure(next) {
  SERVICE = next.service || SERVICE;
  INGEST = next.ingest || INGEST;
  TOKEN = next.token || '';
  ingestUrl = new URL(INGEST);
  control = { ...control, ...(next.control || {}) };
  peers = Array.isArray(next.peers) ? next.peers : peers;
  if (next.browserAgent) browserAgent = next.browserAgent;
  controlDelay = 1000;
  if (controlReq) {
    const previous = controlReq;
    controlReq = null;
    try { previous.destroy(); } catch { /* reconnecting */ }
  }
  scheduleControl(0);
  postNow({ type: 'hello', service: SERVICE });
}

let controlReq = null;
let controlTimer = null;
let controlDelay = 1000;

function scheduleControl(delay) {
  if (controlTimer) clearTimeout(controlTimer);
  controlTimer = setTimeout(connectControl, delay);
  controlTimer.unref();
}

function connectControl() {
  if (controlReq) {
    try { controlReq.destroy(); } catch { /* reconnecting */ }
    controlReq = null;
  }
  let buf = '';
  let done = false;
  const req = rawRequest(
    {
      hostname: ingestUrl.hostname,
      port: ingestUrl.port,
      path: '/api/control/stream',
      method: 'GET',
      headers: { accept: 'text/event-stream', 'x-traceflow-token': TOKEN },
    },
    (res) => {
      res.socket?.unref();
      if (res.statusCode !== 200) {
        res.resume();
        fail();
        return;
      }
      controlDelay = 1000;
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.length > 64_000) buf = buf.slice(-8_000);
        let split;
        while ((split = buf.indexOf('\n\n')) >= 0) {
          const packet = buf.slice(0, split);
          buf = buf.slice(split + 2);
          applyControlPacket(packet);
        }
      });
      res.on('end', fail);
      res.on('error', fail);
    },
  );
  controlReq = req;
  req.on('error', fail);
  unrefRequest(req);
  req.end();

  function fail() {
    if (done) return;
    done = true;
    if (controlReq === req) controlReq = null;
    try { req.destroy(); } catch { /* already closed */ }
    const wait = controlDelay;
    controlDelay = Math.min(controlDelay * 2, 15_000);
    scheduleControl(wait);
  }
}

function applyControlPacket(packet) {
  const data = packet
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');
  if (!data) return;
  try {
    const next = JSON.parse(data);
    if (next && next.capture) control = { ...control, ...next };
  } catch {
    // ignore malformed control
  }
}

const pendingEvents = [];
let flushTimer = null;
let flushing = false;

function postAsync(event) {
  if (!event) return;
  if (event.type === 'hello') {
    postNow(event);
    return;
  }
  enqueueEvent(event);
}

function enqueueEvent(event) {
  if (pendingEvents.length >= EVENT_QUEUE_MAX) {
    if (event.type !== 'log') flushEvents();
    else {
      const index = pendingEvents.findIndex((item) => item.type === 'log');
      if (index >= 0) pendingEvents.splice(index, 1);
      else return;
    }
  }
  pendingEvents.push(event);
  if (pendingEvents.length >= FLUSH_AT) flushEvents();
  else scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer || flushing) return;
  flushTimer = setTimeout(flushEvents, FLUSH_MS);
  flushTimer.unref();
}

function flushEvents() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (flushing) return;
  flushing = true;
  try {
    while (pendingEvents.length) {
      const batch = takeBatch();
      if (!batch.length) break;
      if (batch.length === 1) postNow(batch[0]);
      else postNow({ type: 'batch', events: batch });
    }
  } finally {
    flushing = false;
  }
}

function takeBatch() {
  const batch = [];
  let bytes = 2;
  while (pendingEvents.length && batch.length < FLUSH_AT) {
    const raw = JSON.stringify(pendingEvents[0]);
    if (batch.length && bytes + raw.length > INGEST_BATCH_BYTES) break;
    bytes += raw.length + 1;
    batch.push(pendingEvents.shift());
  }
  return batch;
}

function unrefRequest(req) {
  req.unref?.();
  req.on('socket', (socket) => socket.unref());
}

function postNow(event) {
  try {
    const data = Buffer.from(JSON.stringify(event));
    const req = rawRequest(
      {
        hostname: ingestUrl.hostname,
        port: ingestUrl.port,
        path: '/ingest',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': data.length,
          'x-traceflow-token': TOKEN,
        },
      },
      (res) => res.resume(),
    );
    req.on('error', () => {});
    req.setTimeout(2000, () => req.destroy());
    unrefRequest(req);
    req.end(data);
  } catch {
    // collector down
  }
}

function patchOutput(stream) {
  if (!stream || stream.__traceflowLogPatched) return;
  stream.__traceflowLogPatched = true;
  const originalWrite = stream.write.bind(stream);
  let rest = '';
  stream.write = function write(chunk, encoding) {
    try {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8')
        : String(chunk);
      const split = takeLogLines(rest, text);
      rest = split.rest;
      for (const line of split.lines) {
        const ctx = store();
        postAsync({
          type: 'log',
          service: SERVICE,
          line,
          at: Date.now(),
          ...(ctx?.traceId ? { traceId: ctx.traceId } : {}),
          ...(ctx?.spanId ? { spanId: ctx.spanId } : {}),
        });
      }
    } catch {
      // logging must never affect the service output stream
    }
    return originalWrite.apply(stream, arguments);
  };
}

function takeLogLines(rest, text) {
  let pending = rest + text;
  const lines = [];
  const copy = pending.length > LOG_CHUNK;
  while (pending.length) {
    const match = /\r?\n/.exec(pending);
    if (match && match.index <= LOG_CHUNK) {
      lines.push(detach(pending.slice(0, match.index), copy));
      pending = pending.slice(match.index + match[0].length);
      continue;
    }
    if (pending.length <= LOG_CHUNK) break;
    lines.push(detach(pending.slice(0, LOG_CHUNK), true));
    pending = pending.slice(LOG_CHUNK);
  }
  return { lines, rest: pending ? detach(pending, copy) : '' };
}

function detach(value, copy) {
  if (!copy || !value) return value || '';
  return Buffer.from(value, 'utf8').toString('utf8');
}

function postHold(event) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const data = Buffer.from(JSON.stringify({ ...event, hold: true }));
      const req = rawRequest(
        {
          hostname: ingestUrl.hostname,
          port: ingestUrl.port,
          path: '/ingest',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': data.length,
            'x-traceflow-token': TOKEN,
          },
        },
        (res) => {
          res.resume();
          res.on('end', done);
        },
      );
      req.on('error', done);
      req.setTimeout(65000, () => {
        req.destroy();
        done();
      });
      req.end(data);
    } catch {
      done();
    }
  });
}

function ignored(path) {
  const value = path || '/';
  if (!control.captureDebug && isDebugTraffic(value)) return true;
  return (control.ignore || DEFAULT_IGNORE).some((part) => part && value.includes(part));
}

function isDebugTraffic(value) {
  const pathname = String(value || '/').split('?')[0];
  return pathname === '/message' || pathname.startsWith('/inspector/');
}

function shouldCaptureOutbound(path) {
  if (ignored(path)) return false;
  if (store()?.capture) return true;
  return pathAllowed(path);
}

function pathAllowed(path) {
  if (ignored(path)) return false;
  if (control.capture === 'off') return false;
  if (control.capture === 'matched') {
    const rules = control.include || [];
    if (!rules.length) return false;
    return rules.some((part) => part && String(path).includes(part));
  }
  return control.capture === 'all' || control.capture === 'armed';
}

function textBody(buf, contentType, byteLength = buf ? buf.length : 0) {
  if (!buf || !buf.length) return '';
  const type = String(contentType || '');
  if (/octet-stream|image\/|audio\/|video\/|pdf/.test(type)) {
    return `[binary ${byteLength} bytes]`;
  }
  const slice = buf.subarray(0, MAX_STORE);
  const text = slice.toString('utf8');
  return byteLength > MAX_STORE ? `${text}\n… truncated` : text;
}

function byteCap(max = MAX_STORE) {
  const chunks = [];
  let kept = 0;
  let seen = 0;
  return {
    push(chunk, encoding) {
      if (chunk == null || typeof chunk === 'function') return;
      let buf;
      try {
        buf = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
      } catch {
        return;
      }
      seen += buf.length;
      if (kept >= max) return;
      const room = max - kept;
      const slice = buf.length > room ? buf.subarray(0, room) : buf;
      chunks.push(Buffer.from(slice));
      kept += slice.length;
    },
    payload(contentType) {
      const buf = kept ? Buffer.concat(chunks, kept) : Buffer.alloc(0);
      const truncated = seen > kept;
      return {
        text: textBody(buf, contentType, truncated ? seen : buf.length),
        truncated,
      };
    },
  };
}

function formatCaptured(body, contentType) {
  const total = body ? body.length : 0;
  const slice = total > MAX_STORE ? body.subarray(0, MAX_STORE) : body;
  return {
    text: textBody(slice, contentType, total),
    truncated: total > MAX_STORE,
  };
}

function headerObject(headers) {
  const out = {};
  if (!headers) return out;
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) out[String(headers[i]).toLowerCase()] = String(headers[i + 1] ?? '');
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    out[String(key).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  }
  return out;
}

function store() {
  return als.getStore() || null;
}

function resolvePeer(hostname, port, path) {
  const numeric = Number(port) || (String(hostname).includes('https') ? 443 : 80);
  const pathName = path || '/';
  for (const peer of peers) {
    if (Number(peer.port) !== numeric) continue;
    if (peer.byPath) {
      const rule = peer.byPath.find((item) => pathName.startsWith(item.prefix));
      return rule ? rule.service : `proxy:${numeric}`;
    }
    return peer.service;
  }
  if (hostname === SERVICE) return SERVICE;
  return `${hostname || 'unknown'}:${numeric}`;
}

function childContext(method, path, host, port) {
  const current = store();
  const traceId = current?.traceId || randomUUID();
  const parentId = current?.spanId || null;
  const spanId = randomUUID();
  return {
    traceId,
    spanId,
    parentId,
    from: SERVICE,
    to: resolvePeer(host, port, path),
    method,
    path,
    capture: true,
  };
}

function stampHeaders(headers, ctx) {
  const next = { ...headers };
  next['x-traceflow-trace'] = ctx.traceId;
  next['x-traceflow-span'] = ctx.spanId;
  next['x-traceflow-from'] = SERVICE;
  next['x-traceflow-capture'] = '1';
  if (ctx.parentId) next['x-traceflow-parent'] = ctx.parentId;
  return next;
}

function isSelf(hostname, port, path) {
  return hostname === ingestUrl.hostname && String(port || '') === String(ingestUrl.port || '') && String(path || '').startsWith('/');
}

function readAll(req) {
  return new Promise((resolve) => {
    const chunks = [];
    const onData = (chunk) => chunks.push(chunk);
    const onEnd = () => finish();
    const onError = () => finish();
    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      resolve(Buffer.concat(chunks));
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function overrideGetter(obj, key, get) {
  try {
    Object.defineProperty(obj, key, { configurable: true, enumerable: true, get });
  } catch {
    // some streams lock these; the patched listeners still replay the body
  }
}

function installReplay(req, body) {
  req.removeAllListeners('data');
  req.removeAllListeners('end');
  req.removeAllListeners('readable');

  const dataFns = [];
  const endFns = [];
  let flushed = false;
  let delivered = false;
  let queued = false;
  overrideGetter(req, 'readable', () => !delivered);
  overrideGetter(req, 'readableEnded', () => delivered);
  overrideGetter(req, 'complete', () => delivered);

  function flush() {
    if (flushed) return;
    flushed = true;
    if (body.length) {
      for (const fn of dataFns) fn(body);
    }
    for (const fn of endFns) fn();
    delivered = true;
  }

  function schedule() {
    if (flushed || queued) return;
    queued = true;
    setImmediate(flush);
  }

  function add(event, fn) {
    if (event === 'data') {
      if (flushed) {
        if (body.length) fn(body);
        return req;
      }
      dataFns.push(fn);
      schedule();
      return req;
    }
    if (event === 'end') {
      if (flushed) {
        fn();
        delivered = true;
        return req;
      }
      endFns.push(fn);
      schedule();
      return req;
    }
    return false;
  }

  const origOn = req.on.bind(req);
  const origOnce = req.once.bind(req);
  req.on = function on(event, fn) {
    const handled = add(event, fn);
    return handled === false ? origOn(event, fn) : req;
  };
  req.addListener = req.on;
  req.once = function once(event, fn) {
    const handled = add(event, fn);
    return handled === false ? origOnce(event, fn) : req;
  };
  req.pipe = function pipe(dest) {
    if (body.length) dest.write(body);
    dest.end();
    return dest;
  };
  let readDone = false;
  req.read = function read() {
    if (readDone) return null;
    readDone = true;
    return body.length ? body : null;
  };
  req.resume = () => req;
  req.pause = () => req;
  req[Symbol.asyncIterator] = async function* iterate() {
    if (body.length) yield body;
  };
}

function makeReplayResponse(res, body) {
  const stream = Readable.from(body.length ? [body] : []);
  stream.statusCode = res.statusCode;
  stream.statusMessage = res.statusMessage;
  stream.headers = res.headers;
  stream.rawHeaders = res.rawHeaders;
  stream.httpVersion = res.httpVersion;
  stream.trailers = res.trailers || {};
  stream.aborted = false;
  stream.complete = false;
  stream.httpVersionMajor = res.httpVersionMajor;
  stream.httpVersionMinor = res.httpVersionMinor;
  stream.req = res.req;
  stream.setTimeout = () => stream;
  stream.on('end', () => {
    stream.complete = true;
  });
  return stream;
}

function baseEvent(ctx, phase) {
  return {
    type: 'span',
    phase,
    service: SERVICE,
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentId: ctx.parentId || null,
    from: ctx.from,
    to: ctx.to,
    method: ctx.method,
    path: ctx.path,
    at: Date.now(),
  };
}

function patchModule(mod) {
  const original = mod.request;
  function traced(args, fallback) {
    try {
      const parsed = parseArgs(args, mod === https);
      if (!parsed) return fallback();
      if (isSelf(parsed.hostname, parsed.port, parsed.path)) return fallback();
      if (parsed.method === 'OPTIONS') return fallback();
      if (!shouldCaptureOutbound(parsed.path)) return fallback();

      const ctx = childContext(parsed.method, parsed.path, parsed.hostname, parsed.port);
      const headers = stampHeaders(parsed.headers, ctx);
      const options = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        method: parsed.method,
        path: parsed.path,
        headers,
        agent: parsed.agent,
        timeout: parsed.timeout,
      };
      const holdStart = control.mode === 'step';
      if (holdStart) return deferredRequest(original, options, parsed.callback, ctx);
      return observedRequest(original, options, parsed.callback, ctx);
    } catch {
      return fallback();
    }
  }

  mod.request = function request(...args) {
    return traced(args, () => original.apply(this, args));
  };
  mod.get = function get(...args) {
    const req = mod.request(...args);
    req.end();
    return req;
  };
}

function observedRequest(original, options, callback, ctx) {
  const cap = byteCap();
  let reportedBody = false;
  const req = original(options);
  const origWrite = req.write.bind(req);
  const origEnd = req.end.bind(req);
  postAsync({
    ...baseEvent(ctx, 'start'),
    requestHeaders: options.headers,
  });

  req.write = function write(chunk, enc, cb) {
    if (typeof enc === 'function') {
      cb = enc;
      enc = undefined;
    }
    if (chunk != null && typeof chunk !== 'function') cap.push(chunk, enc);
    return origWrite.apply(req, arguments);
  };
  req.end = function end(chunk, enc, cb) {
    if (typeof chunk === 'function') {
      cb = chunk;
      chunk = undefined;
      enc = undefined;
    } else if (typeof enc === 'function') {
      cb = enc;
      enc = undefined;
    }
    if (chunk != null && typeof chunk !== 'function') cap.push(chunk, enc);
    if (!reportedBody) {
      reportedBody = true;
      const type = options.headers['content-type'] || options.headers['Content-Type'];
      const captured = cap.payload(type);
      postAsync({
        ...baseEvent(ctx, 'start'),
        requestHeaders: options.headers,
        requestBody: captured.text,
        requestTruncated: captured.truncated,
      });
    }
    return origEnd.apply(req, arguments);
  };

  req.on('response', (res) => {
    observeResponse(res, ctx, callback, (replay) => {
      if (typeof callback === 'function') callback(replay || res);
    });
  });
  req.on('error', (err) => {
    postAsync({ ...baseEvent(ctx, 'end'), error: err.message, status: 0 });
  });
  return req;
}

function observeResponse(res, ctx, callback, deliver) {
  const cap = byteCap();
  const origEmit = res.emit.bind(res);
  res.emit = function emit(event, ...args) {
    try {
      if (event === 'data' && args[0]) cap.push(args[0]);
      if (event === 'end') {
        const captured = cap.payload(res.headers['content-type']);
        postAsync({
          ...baseEvent(ctx, 'end'),
          status: res.statusCode,
          responseHeaders: headerObject(res.headers),
          responseBody: captured.text,
          responseTruncated: captured.truncated,
        });
      }
    } catch {
      // capture must not break the response
    }
    return origEmit(event, ...args);
  };
  deliver(null);
}

function deferredRequest(original, options, callback, ctx) {
  const fake = new EventEmitter();
  const chunks = [];
  let started = false;
  fake.writable = true;
  fake.destroyed = false;
  fake.finished = false;
  fake.method = options.method;
  fake.path = options.path;
  fake.setHeader = (key, value) => {
    options.headers[String(key).toLowerCase()] = String(value);
    return fake;
  };
  fake.getHeader = (key) => options.headers[String(key).toLowerCase()];
  fake.removeHeader = (key) => {
    delete options.headers[String(key).toLowerCase()];
  };
  fake.write = (chunk, enc, cb) => {
    if (typeof enc === 'function') {
      cb = enc;
      enc = undefined;
    }
    if (chunk != null && typeof chunk !== 'function') {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc));
    }
    if (cb) cb();
    return true;
  };
  fake.end = (chunk, enc, cb) => {
    if (typeof chunk === 'function') {
      cb = chunk;
      chunk = undefined;
    } else if (typeof enc === 'function') {
      cb = enc;
      enc = undefined;
    }
    if (chunk != null && typeof chunk !== 'function') fake.write(chunk, enc);
    fake.finished = true;
    begin(cb);
    return fake;
  };
  fake.setTimeout = (ms, cb) => {
    fake.timeoutMs = ms;
    if (cb) fake.once('timeout', cb);
    if (fake.real) fake.real.setTimeout(ms);
    return fake;
  };
  fake.abort = () => fake.destroy();
  fake.destroy = (err) => {
    fake.destroyed = true;
    fake.aborted = true;
    if (fake.real) fake.real.destroy(err);
    if (err) fake.emit('error', err);
    return fake;
  };
  fake.flushHeaders = () => {};
  fake.setNoDelay = () => fake;
  fake.setSocketKeepAlive = () => fake;
  fake.aborted = false;
  fake.socket = null;
  fake.connection = null;

  async function begin(endCb) {
    if (started) return;
    started = true;
    const body = Buffer.concat(chunks);
    const type = options.headers['content-type'];
    const captured = formatCaptured(body, type);
    try {
      await postHold({
        ...baseEvent(ctx, 'start'),
        requestHeaders: options.headers,
        requestBody: captured.text,
        requestTruncated: captured.truncated,
      });
    } catch {
      // continue
    }
    if (fake.destroyed) {
      if (endCb) endCb();
      return;
    }
    const real = original(options);
    fake.real = real;
    fake.socket = real.socket || null;
    if (fake.timeoutMs) real.setTimeout(fake.timeoutMs);
    for (const eventName of ['socket', 'abort', 'aborted', 'timeout', 'close', 'connect']) {
      real.on(eventName, (...args) => {
        if (eventName === 'socket') fake.socket = args[0];
        fake.emit(eventName, ...args);
      });
    }
    real.on('error', (err) => {
      postAsync({ ...baseEvent(ctx, 'end'), error: err.message, status: 0 });
      fake.emit('error', err);
    });
    real.on('response', (res) => consumeResponse(res, ctx, fake));
    if (body.length) real.end(body, endCb);
    else real.end(endCb);
  }

  if (typeof callback === 'function') fake.once('response', callback);
  return fake;
}

function consumeResponse(res, ctx, fake) {
  // Step mode replays this buffer after the hold, so the service still receives every byte.
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', async () => {
    const body = Buffer.concat(chunks);
    const captured = formatCaptured(body, res.headers['content-type']);
    const event = {
      ...baseEvent(ctx, 'end'),
      status: res.statusCode,
      responseHeaders: headerObject(res.headers),
      responseBody: captured.text,
      responseTruncated: captured.truncated,
    };
    try {
      if (control.mode === 'step' && control.pauseOnResponse) await postHold(event);
      else postAsync(event);
    } catch {
      // continue
    }
    fake.emit('response', makeReplayResponse(res, body));
  });
  res.on('error', (err) => fake.emit('error', err));
}

function parseArgs(args, secure) {
  let url;
  let options;
  let callback;
  if (typeof args[0] === 'string' || args[0] instanceof URL) {
    url = new URL(args[0]);
    if (typeof args[1] === 'function') callback = args[1];
    else {
      options = args[1] && typeof args[1] === 'object' ? args[1] : {};
      callback = typeof args[2] === 'function' ? args[2] : typeof args[1] === 'function' ? args[1] : undefined;
    }
  } else if (args[0] && typeof args[0] === 'object') {
    options = args[0];
    callback = typeof args[1] === 'function' ? args[1] : undefined;
    if (options.href || options.protocol || options.hostname || options.host) {
      const protocol = options.protocol || (secure ? 'https:' : 'http:');
      const host = options.hostname || options.host || 'localhost';
      url = new URL(`${protocol}//${host}${options.path || options.pathname || '/'}`);
    }
  }
  options = options || {};
  if (!url && options.path) {
    url = new URL(`http://localhost${options.path.startsWith('/') ? '' : '/'}${options.path}`);
  }
  if (!url) return null;
  const headers = headerObject(options.headers);
  const method = String(options.method || 'GET').toUpperCase();
  let port = options.port || url.port;
  if (!port) port = url.protocol === 'https:' ? 443 : 80;
  return {
    protocol: url.protocol,
    hostname: options.hostname || url.hostname,
    port,
    method,
    path: `${url.pathname || '/'}${url.search || ''}`,
    headers,
    agent: options.agent,
    timeout: options.timeout,
    callback,
  };
}

async function readFetchBody(response, max) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    try {
      const text = await response.text();
      const truncated = text.length > max;
      const slice = truncated ? Buffer.from(text.slice(0, max), 'utf8').toString('utf8') : text;
      return { text: truncated ? `${slice}\n… truncated` : slice, truncated };
    } catch {
      return { text: '', truncated: false };
    }
  }
  const reader = response.body.getReader();
  const chunks = [];
  let kept = 0;
  let seen = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      seen += value.byteLength;
      if (kept >= max) {
        truncated = true;
        continue;
      }
      const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      const room = max - kept;
      if (buf.length > room) {
        chunks.push(Buffer.from(buf.subarray(0, room)));
        kept = max;
        truncated = true;
        continue;
      }
      chunks.push(buf);
      kept += buf.length;
    }
  } catch {
    return { text: '', truncated: false };
  }
  const buf = kept ? Buffer.concat(chunks, kept) : Buffer.alloc(0);
  return {
    text: textBody(buf, response.headers.get('content-type'), truncated ? Math.max(seen, max + 1) : buf.length),
    truncated,
  };
}

function patchFetch() {
  if (typeof globalThis.fetch !== 'function') return;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async function tracedFetch(input, init = {}) {
    let sent = false;
    try {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(urlString);
      if (isSelf(url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80), url.pathname)) {
        return original(input, init);
      }
      const method = String(init.method || (typeof input !== 'string' && !(input instanceof URL) && input.method) || 'GET').toUpperCase();
      const path = `${url.pathname}${url.search}`;
      if (method === 'OPTIONS' || !shouldCaptureOutbound(path)) return original(input, init);

      const ctx = childContext(method, path, url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80));
      const headers = new Headers(init.headers || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
      headers.set('x-traceflow-trace', ctx.traceId);
      headers.set('x-traceflow-span', ctx.spanId);
      headers.set('x-traceflow-from', SERVICE);
      headers.set('x-traceflow-capture', '1');
      if (ctx.parentId) headers.set('x-traceflow-parent', ctx.parentId);

      let requestBody = '';
      let requestTruncated = false;
      if (typeof init.body === 'string') {
        requestTruncated = init.body.length > MAX_STORE;
        const slice = requestTruncated
          ? Buffer.from(init.body.slice(0, MAX_STORE), 'utf8').toString('utf8')
          : init.body;
        requestBody = requestTruncated ? `${slice}\n… truncated` : slice;
      } else if (Buffer.isBuffer(init.body)) {
        const captured = formatCaptured(init.body, headers.get('content-type'));
        requestBody = captured.text;
        requestTruncated = captured.truncated;
      } else if (init.body) requestBody = '[non-text body]';

      const headerDump = {};
      headers.forEach((value, key) => {
        headerDump[key] = value;
      });
      const start = {
        ...baseEvent(ctx, 'start'),
        requestHeaders: headerDump,
        requestBody,
        requestTruncated,
      };
      if (control.mode === 'step') await postHold(start);
      else postAsync(start);

      sent = true;
      const response = await original(urlString, { ...init, method, headers });
      const copy = response.clone();
      const captured = await readFetchBody(copy, MAX_STORE);
      const responseHeaders = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      const end = {
        ...baseEvent(ctx, 'end'),
        status: response.status,
        responseHeaders,
        responseBody: captured.text,
        responseTruncated: captured.truncated,
      };
      if (control.mode === 'step' && control.pauseOnResponse) await postHold(end);
      else postAsync(end);
      return response;
    } catch (err) {
      if (sent) throw err;
      return original(input, init);
    }
  };
}

function patchServerEmit() {
  const originalEmit = http.Server.prototype.emit;
  const wrapped = function emit(event, req, res, ...rest) {
    if (event !== 'request' || !req || !res) return originalEmit.call(this, event, req, res, ...rest);
    try {
      return handleIncoming(this, originalEmit, req, res);
    } catch {
      return originalEmit.call(this, event, req, res);
    }
  };
  http.Server.prototype.emit = wrapped;
  if (https.Server) https.Server.prototype.emit = wrapped;
}

function handleIncoming(server, originalEmit, req, res) {
  const path = req.url || '/';
  const method = String(req.method || 'GET').toUpperCase();
  const headers = headerObject(req.headers);
  if (handleBrowserEndpoint(req, res, path, method, headers)) return true;
  const browserDocument = headers['sec-fetch-dest'] === 'document'
    || String(headers.accept || '').toLowerCase().includes('text/html');
  if (control.captureBrowser && browserDocument) req.headers['accept-encoding'] = 'identity';
  const forced = headers['x-traceflow-capture'] === '1';
  if (method === 'OPTIONS' || (!forced && !pathAllowed(path))) {
    return originalEmit.call(server, 'request', req, res);
  }

  const ctx = {
    traceId: headers['x-traceflow-trace'] || randomUUID(),
    spanId: headers['x-traceflow-span'] || randomUUID(),
    parentId: headers['x-traceflow-parent'] || null,
    from: incomingSource(headers),
    to: SERVICE,
    method,
    path,
  };
  const length = Number(headers['content-length'] || 0);
  const hasBody = method !== 'GET' && method !== 'HEAD' && (length === 0 || length < MAX_BUFFER);
  const go = () => {
    als.run({ traceId: ctx.traceId, spanId: ctx.spanId, capture: true }, () => {
      originalEmit.call(server, 'request', req, res);
    });
  };
  const begin = (start) => {
    wireServerResponse(res, ctx, !headers['x-traceflow-from']);
    if (control.mode === 'step') postHold(start).then(go, go);
    else {
      postAsync(start);
      go();
    }
    return true;
  };

  if (control.mode === 'step' && hasBody) {
    readAll(req).then((body) => {
      installReplay(req, body);
      const captured = formatCaptured(body, headers['content-type']);
      begin({
        ...baseEvent(ctx, 'start'),
        requestHeaders: headers,
        requestBody: captured.text,
        requestTruncated: captured.truncated,
      });
    });
    return true;
  }

  const start = {
    ...baseEvent(ctx, 'start'),
    requestHeaders: headers,
    requestBody: '',
  };
  if (hasBody && control.mode !== 'step') {
    const cap = byteCap();
    let reported = false;
    tapStream(req, cap, () => {
      if (reported) return;
      reported = true;
      const captured = cap.payload(headers['content-type']);
      if (!captured.text && !captured.truncated) return;
      postAsync({
        ...baseEvent(ctx, 'start'),
        requestHeaders: headers,
        requestBody: captured.text,
        requestTruncated: captured.truncated,
      });
    });
  }
  return begin(start);
}

function handleBrowserEndpoint(req, res, requestPath, method, headers) {
  const pathname = requestPath.split('?')[0];
  if (method === 'GET' && pathname === BROWSER_SCRIPT_PATH) {
    if (!browserAgent || !control.captureBrowser) {
      res.writeHead(404);
      res.end();
      return true;
    }
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(browserAgent);
    return true;
  }
  if (method !== 'POST' || pathname !== BROWSER_EVENT_PATH) return false;
  const origin = String(headers.origin || '');
  const sameOrigin = headers['sec-fetch-site'] === 'same-origin';
  const loopbackOrigin = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin);
  if (!sameOrigin && !loopbackOrigin) {
    res.writeHead(403);
    res.end();
    return true;
  }
  readAll(req).then((body) => {
    try {
      const event = JSON.parse(body.toString('utf8'));
      if (control.captureBrowser && event?.type === 'span' && event.traceId && event.spanId && shouldCaptureOutbound(event.path)) {
        postAsync({
          ...event,
          type: 'span',
          from: 'browser',
          to: String(event.to || 'external'),
          method: String(event.method || 'GET').toUpperCase(),
          path: String(event.path || '/'),
        });
      }
      res.writeHead(204);
      res.end();
    } catch {
      res.writeHead(400);
      res.end();
    }
  }, () => {
    res.writeHead(400);
    res.end();
  });
  return true;
}

function incomingSource(headers) {
  if (headers['x-traceflow-from']) return headers['x-traceflow-from'];
  const userAgent = String(headers['user-agent'] || '').toLowerCase();
  if (headers.origin || headers['sec-fetch-site'] || /mozilla|chrome|safari|firefox|edg\//.test(userAgent)) return 'browser';
  if (/node|undici|node-fetch|axios|got\//.test(userAgent)) return 'node client';
  return 'external';
}

function tapStream(stream, cap, onEnd) {
  const origEmit = stream.emit.bind(stream);
  let ended = false;
  stream.emit = function emit(event, ...args) {
    try {
      if (event === 'data' && args[0]) cap.push(args[0]);
      if (!ended && (event === 'end' || event === 'close')) {
        ended = true;
        onEnd();
      }
    } catch {
      // capture must not break the request
    }
    return origEmit(event, ...args);
  };
}

function wireServerResponse(res, ctx, isRoot) {
  const cap = byteCap();
  const captured = {};
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  const origSetHeader = res.setHeader.bind(res);
  const origWriteHead = res.writeHead.bind(res);
  let closed = false;
  let browserInjected = false;
  const injectBrowserAgent = (chunk, enc) => {
    if (!isRoot || browserInjected || !browserAgent || !control.captureBrowser || chunk == null) return chunk;
    const contentType = String(res.getHeader?.('content-type') || captured['content-type'] || '').toLowerCase();
    const contentEncoding = String(res.getHeader?.('content-encoding') || captured['content-encoding'] || '').toLowerCase();
    if (!contentType.includes('text/html') || contentEncoding) return chunk;
    const wasBuffer = Buffer.isBuffer(chunk);
    const text = wasBuffer ? chunk.toString(typeof enc === 'string' ? enc : 'utf8') : String(chunk);
    const match = text.match(/<head(?:\s[^>]*)?>/i) || text.match(/<\/body\s*>/i);
    if (!match) return chunk;
    if (res.headersSent && res.getHeader?.('content-length')) return chunk;
    const tag = `<script src="${BROWSER_SCRIPT_PATH}"></script>`;
    const next = /^<head/i.test(match[0])
      ? text.replace(match[0], `${match[0]}${tag}`)
      : text.replace(match[0], `${tag}${match[0]}`);
    browserInjected = true;
    if (!res.headersSent) res.removeHeader?.('content-length');
    return wasBuffer ? Buffer.from(next, typeof enc === 'string' ? enc : 'utf8') : next;
  };
  res.setHeader = function setHeader(name, value) {
    captured[String(name).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
    return origSetHeader(name, value);
  };
  res.writeHead = function writeHead(...args) {
    const headers = args.find((arg) => arg && typeof arg === 'object');
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        captured[String(key).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
      }
    }
    return origWriteHead.apply(res, args);
  };
  res.write = function write(chunk, enc, cb) {
    if (chunk && typeof chunk !== 'function') cap.push(chunk, enc);
    return origWrite(injectBrowserAgent(chunk, enc), enc, cb);
  };
  res.end = function end(...args) {
    const chunk = typeof args[0] === 'function' ? undefined : args[0];
    if (chunk != null) cap.push(chunk);
    const finish = () => {
      const outgoing = [...args];
      if (chunk != null) outgoing[0] = injectBrowserAgent(chunk, typeof args[1] === 'string' ? args[1] : undefined);
      return origEnd(...outgoing);
    };
    if (closed) return finish();
    closed = true;
    const body = cap.payload(res.getHeader && res.getHeader('content-type'));
    const event = {
      ...baseEvent(ctx, 'end'),
      status: res.statusCode,
      responseHeaders: { ...headerObject(typeof res.getHeaders === 'function' ? res.getHeaders() : {}), ...captured },
      responseBody: body.text,
      responseTruncated: body.truncated,
    };
    const holdResponse = isRoot && control.mode === 'step' && control.pauseOnResponse;
    if (holdResponse) {
      postHold(event).then(finish, finish);
      return res;
    }
    postAsync(event);
    return finish();
  };
}

try {
  install();
} catch (err) {
  process.stderr.write(`[traceflow] agent failed to install: ${err && err.message}\n`);
}
