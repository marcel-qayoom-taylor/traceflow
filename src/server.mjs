#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { attachToListener, killListener, launchTarget, listenerOn, listeners, listenersByPort, repositoryName, stopListener, workingDirectoryForCommand } from './attach.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentPath = path.join(root, 'src', 'agent', 'preload.cjs');
const publicDir = path.join(root, 'src', 'public');

const DEFAULT_IGNORE = [
  '/health',
  '/healthcheck',
  '/ready',
  '/metrics',
  '/favicon.ico',
  '/__webpack',
  'hot-update',
  '/sockjs-node',
];
const SERVICE_COLORS = [
  '#7dd3fc',
  '#f9a8d4',
  '#86efac',
  '#fcd34d',
  '#c4b5fd',
  '#fdba74',
  '#67e8f9',
  '#fda4af',
  '#bef264',
  '#a5b4fc',
  '#5eead4',
  '#d8b4fe',
];

export async function startServer({ port = 9477, config, demo = false, limits } = {}) {
  const sessionToken = randomUUID();
  const activeConfig = config || (demo ? demoConfig() : loadConfig());
  if (!demo) restoreRememberedServices(activeConfig);
  const control = {
    mode: 'run',
    pauseOnResponse: true,
    captureBrowser: true,
    captureDebug: false,
    capture: 'all',
    include: activeConfig.include || [],
    ignore: activeConfig.ignore || DEFAULT_IGNORE,
  };
  const traces = new Map();
  const gates = [];
  const agents = new Map();
  const logEntries = [];
  const logRest = new Map();
  const runtimes = new Map();
  let discovered = [];
  const clients = new Set();
  const controlClients = new Set();
  let deltaQueued = false;
  let logQueued = false;
  let closed = false;
  let listenerDelay = 3000;
  let listenerTimer = null;
  let expireTimer = null;
  let controlPing = null;
  const pendingLogs = [];
  const maxTraces = limits?.maxTraces ?? 200;
  const maxSpans = limits?.maxSpans ?? 200;
  const incompleteTtlMs = limits?.incompleteTtlMs ?? 5 * 60 * 1000;
  const traceTtlMs = limits?.traceTtlMs ?? 30 * 60 * 1000;
  const dirty = {
    clear: false,
    logsClear: false,
    spans: new Map(),
    removed: new Set(),
    services: false,
    control: false,
    gates: false,
  };

  for (const service of activeConfig.services) {
    runtimes.set(service.name, {
      status: 'stopped',
      pid: null,
      exitCode: null,
      child: null,
      owner: null,
      attachedPid: null,
      message: '',
      problem: '',
      repo: repositoryName(path.resolve(activeConfig.baseDir || root, service.cwd || '.')),
    });
  }

  function peerTable() {
    const peers = activeConfig.services.map((service) => ({
      port: service.port,
      service: service.name,
    }));
    if (activeConfig.proxy?.port) {
      peers.push({
        port: activeConfig.proxy.port,
        service: 'proxy',
        byPath: activeConfig.proxy.byPath || [],
      });
    }
    return peers;
  }

  function listedTraces() {
    const all = [...traces.values()].sort((a, b) => b.startedAt - a.startedAt);
    const pinned = all.filter((trace) => trace.pinned);
    const rest = all.filter((trace) => !trace.pinned).slice(0, Math.max(maxTraces - pinned.length, 0));
    return [...pinned, ...rest].sort((a, b) => b.startedAt - a.startedAt);
  }

  function snapshot() {
    return {
      demo,
      control,
      gates: gates.map(gateView),
      services: activeConfig.services.map(serviceView),
      discovered,
      traces: listedTraces(),
      logEntries: [...logEntries],
      sampleUrl: demo ? '/api/sample' : null,
    };
  }

  function serviceView(service) {
    const runtime = runtimes.get(service.name);
    const seen = agents.get(service.name) || 0;
    return {
      name: service.name,
      port: service.port,
      color: service.color || SERVICE_COLORS[activeConfig.services.indexOf(service) % SERVICE_COLORS.length],
      status: runtime?.status || 'stopped',
      pid: runtime?.pid || null,
      exitCode: runtime?.exitCode ?? null,
      owner: runtime?.owner || null,
      attached: Boolean(runtime?.attachedPid && runtime.attachedPid === runtime.pid),
      discovered: Boolean(service.discovered),
      message: runtime?.message || '',
      problem: runtime?.problem || '',
      repo: runtime?.repo || service.repo || null,
      agent: Date.now() - seen < 5000,
      command: service.command || `node ${service.args?.join(' ')}`,
    };
  }

  function gateView(gate) {
    return {
      id: gate.id,
      traceId: gate.traceId,
      spanId: gate.spanId,
      phase: gate.phase,
      label: gate.label,
    };
  }

  function send(event, data) {
    const packet = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of [...clients]) {
      if (!writePacket(client, packet)) dropStream(clients, client);
    }
  }

  function noteSpan(trace, span) {
    if (dirty.clear) return;
    dirty.removed.delete(trace.id);
    dirty.spans.set(`${trace.id}\0${span.id}`, {
      traceId: trace.id,
      startedAt: trace.startedAt,
      spansTruncated: !!trace.spansTruncated,
      span,
    });
    scheduleDelta();
  }

  function noteTraceMeta(trace) {
    if (dirty.clear) return;
    dirty.removed.delete(trace.id);
    dirty.spans.set(`${trace.id}\0`, traceUpdate(trace, null));
    scheduleDelta();
  }

  function traceUpdate(trace, span) {
    return {
      traceId: trace.id,
      startedAt: trace.startedAt,
      spansTruncated: !!trace.spansTruncated,
      pinned: !!trace.pinned,
      span,
    };
  }

  function noteRemoved(id) {
    dirty.removed.add(id);
    for (const key of [...dirty.spans.keys()]) {
      if (key.startsWith(`${id}\0`)) dirty.spans.delete(key);
    }
    scheduleDelta();
  }

  function noteServices() {
    dirty.services = true;
    scheduleDelta();
  }

  function noteControl() {
    dirty.control = true;
    dirty.gates = true;
    pushControl();
    scheduleDelta();
  }

  function noteGates() {
    dirty.gates = true;
    scheduleDelta();
  }

  function noteClear() {
    dirty.clear = true;
    dirty.spans.clear();
    dirty.removed.clear();
    scheduleDelta();
  }

  function noteLogsClear() {
    dirty.logsClear = true;
    scheduleDelta();
  }

  function scheduleDelta() {
    if (deltaQueued) return;
    deltaQueued = true;
    queueMicrotask(flushDelta);
  }

  function flushDelta() {
    deltaQueued = false;
    const packet = {};
    if (dirty.clear) packet.clear = true;
    else {
      if (dirty.spans.size) packet.spans = [...dirty.spans.values()];
      if (dirty.removed.size) packet.removed = [...dirty.removed];
    }
    if (dirty.services) {
      packet.services = activeConfig.services.map(serviceView);
      packet.discovered = discovered;
    }
    if (dirty.control) packet.control = { ...control };
    if (dirty.gates) packet.gates = gates.map(gateView);
    if (dirty.logsClear) packet.logsClear = true;
    dirty.clear = false;
    dirty.logsClear = false;
    dirty.spans.clear();
    dirty.removed.clear();
    dirty.services = false;
    dirty.control = false;
    dirty.gates = false;
    if (!clients.size) return;
    if (!packet.clear && !packet.logsClear && !packet.spans && !packet.removed && !packet.services && !packet.control && !packet.gates) return;
    send('delta', packet);
  }

  function pushControl() {
    const packet = `data: ${JSON.stringify(control)}\n\n`;
    for (const client of [...controlClients]) {
      if (!writePacket(client, packet)) dropStream(controlClients, client);
    }
  }

  function pushLog(service, line, meta = {}) {
    const clean = stripAnsi(String(line)).trimEnd();
    if (!clean) return;
    const entry = {
      service,
      line: clean,
      at: Number.isFinite(meta.at) ? meta.at : Date.now(),
    };
    if (typeof meta.traceId === 'string' && meta.traceId) entry.traceId = meta.traceId;
    if (typeof meta.spanId === 'string' && meta.spanId) entry.spanId = meta.spanId;
    logEntries.push(entry);
    if (logEntries.length > 900) logEntries.shift();
    pendingLogs.push(entry);
    if (logQueued) return;
    logQueued = true;
    setTimeout(() => {
      logQueued = false;
      if (!pendingLogs.length) return;
      const batch = pendingLogs.splice(0, pendingLogs.length);
      send('log', batch);
    }, 80);
  }

  function evictTraces() {
    if (traces.size <= maxTraces) return;
    const ranked = [...traces.values()].sort((a, b) => Number(a.pinned) - Number(b.pinned) || a.startedAt - b.startedAt);
    for (const trace of ranked) {
      if (traces.size <= maxTraces) return;
      traces.delete(trace.id);
      noteRemoved(trace.id);
    }
  }

  function expireTraces() {
    const now = Date.now();
    const held = new Set(gates.map((gate) => gate.traceId));
    for (const trace of [...traces.values()]) {
      if (trace.pinned || held.has(trace.id)) continue;
      const updated = trace.updatedAt || trace.startedAt;
      const incomplete = trace.spans.some((span) => !span.endedAt);
      if (now - updated > (incomplete ? incompleteTtlMs : traceTtlMs)) {
        traces.delete(trace.id);
        noteRemoved(trace.id);
      }
    }
  }

  function applySpan(event) {
    if (!control.captureDebug && isDebugTraffic(event.path)) return null;
    let trace = traces.get(event.traceId);
    if (!trace) {
      trace = {
        id: event.traceId,
        startedAt: event.at || Date.now(),
        updatedAt: event.at || Date.now(),
        spans: [],
        spansTruncated: false,
        pinned: false,
      };
      traces.set(trace.id, trace);
      evictTraces();
    }
    trace.updatedAt = event.at || Date.now();
    let span = trace.spans.find((item) => item.id === event.spanId);
    if (!span) {
      if (trace.spans.length >= maxSpans) {
        trace.spansTruncated = true;
        noteTraceMeta(trace);
        return null;
      }
      span = {
        id: event.spanId,
        parentId: event.parentId || null,
        from: event.from,
        to: event.to,
        method: event.method,
        path: event.path,
        requestHeaders: {},
        requestBody: '',
        responseHeaders: {},
        responseBody: '',
        status: null,
        error: null,
        startedAt: event.at || Date.now(),
        endedAt: null,
        hold: null,
        requestTruncated: false,
        responseTruncated: false,
      };
      trace.spans.push(span);
    }
    if (event.parentId) span.parentId = event.parentId;
    span.from = preferName(span.from, event.from);
    span.to = preferName(span.to, event.to);
    if (event.requestBody) span.requestBody = event.requestBody;
    if (event.requestTruncated) span.requestTruncated = true;
    if (event.requestHeaders) span.requestHeaders = { ...span.requestHeaders, ...event.requestHeaders };
    if (event.phase === 'end') {
      if (event.status || event.status === 0) span.status = event.status;
      if (event.responseBody) span.responseBody = event.responseBody;
      if (event.responseTruncated) span.responseTruncated = true;
      if (event.responseHeaders) span.responseHeaders = { ...span.responseHeaders, ...event.responseHeaders };
      if (event.error) span.error = event.error;
      span.endedAt = event.at || Date.now();
    }
    if (control.capture === 'armed' && event.phase === 'start' && !event.parentId) {
      control.capture = 'off';
      noteControl();
    }
    noteSpan(trace, span);
    return span;
  }

  function clearHold(gate) {
    const trace = traces.get(gate.traceId);
    const span = trace?.spans.find((item) => item.id === gate.spanId);
    if (!span || !span.hold) return;
    span.hold = null;
    noteSpan(trace, span);
  }

  function releaseGate(id) {
    const index = gates.findIndex((gate) => gate.id === id);
    if (index < 0) return false;
    const [gate] = gates.splice(index, 1);
    clearTimeout(gate.timer);
    clearHold(gate);
    gate.done();
    noteGates();
    return true;
  }

  function holdEvent(event, res) {
    const gate = {
      id: randomUUID(),
      traceId: event.traceId,
      spanId: event.spanId,
      phase: event.phase,
      label: `${event.from} → ${event.to}  ${event.method} ${event.path}${event.phase === 'end' ? `  ${event.status || ''}` : ''}`,
      done: () => {},
    };
    gates.push(gate);
    const trace = traces.get(event.traceId);
    const span = trace?.spans.find((item) => item.id === event.spanId);
    if (span) span.hold = event.phase === 'end' ? 'response' : 'request';
    gate.timer = setTimeout(() => releaseGate(gate.id), 60000);
    gate.done = () => {
      try {
        if (!res.writableEnded && !res.destroyed) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }
      } catch {
        // the agent already moved on
      }
    };
    res.on('close', () => {
      if (!res.writableEnded) releaseGate(gate.id);
    });
    if (span && trace) noteSpan(trace, span);
    noteGates();
  }

  async function startService(name) {
    const spec = activeConfig.services.find((service) => service.name === name);
    if (!spec) return { ok: false, error: 'unknown service' };
    const runtime = runtimes.get(name);
    if (runtime?.owner === 'traceflow' && runtime.status === 'running' && runtime.child) return { ok: true, status: 'running' };
    if (!spec.cwd) spec.cwd = workingDirectoryForCommand(spec.command) || '';
    const listener = listenerOn(spec.port);
    if (listener) {
      runtime.message = `Already running in your terminal (pid ${listener.pid}). Stop it before starting a new one.`;
      runtime.problem = runtime.message;
      noteServices();
      return { ok: false, error: runtime.message };
    }
    const cwd = path.resolve(activeConfig.baseDir || root, spec.cwd || '.');
    const env = {
      ...process.env,
      ...spec.env,
      PORT: String(spec.port),
      TRACEFLOW_SERVICE: spec.name,
      TRACEFLOW_INGEST: `http://127.0.0.1:${listenPort}`,
      TRACEFLOW_TOKEN: sessionToken,
      TRACEFLOW_PEERS: JSON.stringify(peerTable()),
      TRACEFLOW_CONTROL: JSON.stringify(control),
      NODE_OPTIONS: joinNodeOptions(process.env.NODE_OPTIONS, agentPath),
    };
    const nodeBin = nodeBinForProject(cwd);
    if (nodeBin) env.PATH = `${nodeBin}${path.delimiter}${env.PATH || ''}`;
    const child = spec.args
      ? spawn(process.execPath, spec.args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('bash', ['-c', spec.command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    runtime.child = child;
    runtime.pid = child.pid;
    runtime.status = 'running';
    runtime.owner = 'traceflow';
    runtime.message = '';
    runtime.problem = '';
    runtime.repo = repositoryName(cwd);
    runtime.exitCode = null;
    const take = (chunk) => {
      const key = `${name}:rest`;
      const split = takeLogLines(logRest.get(key) || '', chunk.toString('utf8'));
      logRest.set(key, split.rest);
      for (const line of split.lines) pushLog(name, line);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('exit', (code, signal) => {
      const stoppedByUser = runtime.status === 'stopping';
      const reason = code !== null ? `code ${code}` : signal ? `signal ${signal}` : 'unknown reason';
      runtime.status = stoppedByUser ? 'stopped' : 'exited';
      runtime.pid = null;
      runtime.exitCode = code;
      runtime.child = null;
      runtime.owner = null;
      runtime.attachedPid = null;
      runtime.message = '';
      runtime.problem = stoppedByUser || code === 0 ? '' : `Process exited (${reason})`;
      pushLog(name, stoppedByUser ? `[traceflow] stopped pid ${child.pid}` : `[traceflow] process exited (${reason})`);
      noteServices();
    });
    child.on('error', (err) => {
      runtime.status = 'exited';
      runtime.problem = err.message;
      pushLog(name, `[traceflow] failed to start: ${err.message}`);
      noteServices();
    });
    pushLog(name, `[traceflow] started pid ${child.pid}`);
    noteServices();
    return { ok: true, pid: child.pid };
  }

  async function stopService(name) {
    const spec = activeConfig.services.find((service) => service.name === name);
    const runtime = runtimes.get(name);
    if (!spec || !runtime) return { ok: false, error: 'unknown service' };
    if (runtime.child) {
      const pid = runtime.child.pid;
      runtime.status = 'stopping';
      runtime.message = 'Stopping…';
      runtime.problem = '';
      noteServices();
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try { runtime.child.kill('SIGTERM'); } catch { /* already gone */ }
      }
      const killer = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
      }, 1500);
      killer.unref?.();
      const stopped = await waitForPortToStop(spec.port);
      clearTimeout(killer);
      if (stopped) return { ok: true };
      runtime.status = 'running';
      runtime.message = `Process is still listening on ${spec.port}`;
      runtime.problem = runtime.message;
      noteServices();
      return { ok: false, error: runtime.message };
    }
    const listener = listenerOn(spec.port);
    if (!listener) {
      runtime.status = 'stopped';
      runtime.owner = null;
      runtime.pid = null;
      runtime.message = '';
      runtime.problem = '';
      noteServices();
      return { ok: true };
    }
    try {
      const rootPid = stopListener(listener.pid);
      runtime.status = 'stopping';
      runtime.message = 'Stopping…';
      runtime.problem = '';
      noteServices();
      if (!await waitForPortToStop(spec.port, 2000)) {
        const current = listenerOn(spec.port);
        if (current) {
          try { killListener(current.pid); } catch { /* already gone */ }
        }
      }
      if (!await waitForPortToStop(spec.port, 2000)) {
        const current = listenerOn(spec.port);
        runtime.status = 'running';
        runtime.pid = current?.pid || listener.pid;
        runtime.owner = 'terminal';
        runtime.message = `Process is still listening on ${spec.port}`;
        runtime.problem = runtime.message;
        noteServices();
        return { ok: false, error: runtime.message };
      }
      runtime.status = 'stopped';
      runtime.pid = null;
      runtime.owner = null;
      runtime.attachedPid = null;
      runtime.message = '';
      runtime.problem = '';
      pushLog(name, `[traceflow] stopped pid ${rootPid}`);
      noteServices();
      return { ok: true, pid: rootPid };
    } catch (err) {
      runtime.message = err.message;
      runtime.problem = err.message;
      noteServices();
      return { ok: false, error: err.message };
    }
  }

  async function waitForPortToStop(port, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!listenerOn(port)) return true;
      await sleep(100);
    }
    return !listenerOn(port);
  }

  async function attachService(name) {
    const spec = activeConfig.services.find((service) => service.name === name);
    const runtime = runtimes.get(name);
    if (!spec || !runtime) return { ok: false, error: 'unknown service' };
    try {
      const previousHello = agents.get(spec.name) || 0;
      const result = await attachToListener({
        port: spec.port,
        service: spec.name,
        ingest: `http://127.0.0.1:${listenPort}`,
        token: sessionToken,
        peers: peerTable(),
        control,
        agentPath,
      });
      if (result.ok && !(await waitForFreshAgent(spec.name, previousHello))) {
        result.ok = false;
        result.error = 'The agent loaded, but did not connect to Traceflow. Restart the service once, then attach again.';
      }
      runtime.message = result.ok ? '' : result.error;
      runtime.problem = result.ok || runtime.status === 'running' ? '' : result.error;
      if (result.ok) runtime.attachedPid = result.pid;
      if (result.ok) pushLog(name, `[traceflow] attached to pid ${result.pid}`);
      noteServices();
      return result;
    } catch (err) {
      runtime.message = err.message;
      runtime.problem = runtime.status === 'running' ? '' : err.message;
      noteServices();
      return { ok: false, error: err.message };
    }
  }

  async function waitForFreshAgent(name, previousHello, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((agents.get(name) || 0) > previousHello) return true;
      await sleep(50);
    }
    return (agents.get(name) || 0) > previousHello;
  }

  function discoverySignature(items) {
    return items.map((listener) => [
      listener.port,
      listener.pid,
      listener.repo || '',
      listener.repoPath || '',
      listener.workingDirectory || '',
    ].join('\0')).join('\n');
  }

  function scanListeners() {
    const result = listeners();
    if (!result.ok) return { ok: false, error: 'Could not inspect local listening ports' };
    const configuredPorts = new Set(activeConfig.services.map((service) => Number(service.port)));
    const next = result.listeners
      .filter((listener) => listener.node && listener.pid !== process.pid && !configuredPorts.has(listener.port))
      .map((listener) => ({
        ...listener,
        attachable: true,
      }));
    const changed = discoverySignature(discovered) !== discoverySignature(next);
    discovered = next;
    if (changed) noteServices();
    return { ok: true, listeners: discovered };
  }

  async function attachDiscovered(port) {
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1 || value > 65535) return { ok: false, error: 'A valid port is required' };
    const scan = scanListeners();
    if (!scan.ok) return scan;
    const listener = discovered.find((item) => item.port === value);
    if (!listener) return { ok: false, error: `Nothing is listening on ${value}` };
    if (!listener.node) return { ok: false, error: `pid ${listener.pid} on ${value} is not Node` };
    const launch = launchTarget(listener.pid);
    const service = {
      name: `localhost-${value}`,
      port: value,
      command: launch && !launch.sameProcess ? launch.command : listener.command,
      cwd: launch?.cwd || listener.workingDirectory || workingDirectoryForCommand(listener.command) || '',
      repo: listener.repo,
      discovered: true,
    };
    activeConfig.services.push(service);
    runtimes.set(service.name, {
      status: 'running', pid: listener.pid, exitCode: null, child: null, owner: 'terminal', attachedPid: null, message: 'Connecting to existing process…', problem: '', repo: listener.repo,
    });
    discovered = discovered.filter((item) => item.port !== value);
    saveRememberedServices(activeConfig);
    noteServices();
    return attachService(service.name);
  }

  async function refreshListeners() {
    const scanned = listenersByPort(activeConfig.services.map((service) => service.port));
    if (!scanned.ok) {
      listenerDelay = Math.min(Math.max(listenerDelay, 3000) * 2, 30_000);
      return;
    }
    listenerDelay = 3000;
    let changed = false;
    for (const service of activeConfig.services) {
      const runtime = runtimes.get(service.name);
      if (runtime.owner === 'traceflow' && runtime.child && runtime.status === 'running') continue;
      if (runtime.status === 'stopping') continue;
      const listener = scanned.byPort.get(Number(service.port)) || null;
      if (listener) {
        if (runtime.repo !== listener.repo) {
          runtime.repo = listener.repo;
          changed = true;
        }
        const pidChanged = runtime.pid !== listener.pid;
        if (runtime.status !== 'running' || pidChanged || runtime.owner !== 'terminal') {
          runtime.status = 'running';
          runtime.pid = listener.pid;
          runtime.owner = 'terminal';
          runtime.child = null;
          runtime.attachedPid = null;
          runtime.problem = '';
          changed = true;
        }
        if (service.discovered && (pidChanged || !service.cwd) && rememberLaunch(service, listener.pid)) {
          changed = true;
          saveRememberedServices(activeConfig);
        }
      } else if (runtime.owner === 'terminal') {
        runtime.status = 'stopped';
        runtime.pid = null;
        runtime.owner = null;
        runtime.attachedPid = null;
        runtime.problem = '';
        changed = true;
      }
    }
    if (changed) noteServices();
  }

  function scheduleListeners() {
    if (closed) return;
    listenerTimer = setTimeout(() => {
      void refreshListeners().finally(scheduleListeners);
    }, listenerDelay);
    listenerTimer.unref();
  }

  function applyIngest(event, res) {
    expireTraces();
    if (!event || typeof event !== 'object') return false;
    event = sanitizeEvent(event);
    if (event.type === 'hello') {
      const previous = agents.get(event.service) || 0;
      agents.set(event.service, Date.now());
      const runtime = runtimes.get(event.service);
      let changed = Date.now() - previous > 5000;
      if (runtime && (runtime.message || (runtime.problem && runtime.status === 'running'))) {
        runtime.message = '';
        if (runtime.status === 'running') runtime.problem = '';
        changed = true;
      }
      if (changed) noteServices();
      return false;
    }
    if (event.type === 'log' && event.service && typeof event.line === 'string') {
      pushLog(event.service, event.line, {
        at: typeof event.at === 'number' ? event.at : undefined,
        traceId: event.traceId,
        spanId: event.spanId,
      });
      return false;
    }
    if (event.type === 'span' && event.traceId && event.spanId) {
      applySpan(event);
      if (res && event.hold && control.mode === 'step') {
        holdEvent(event, res);
        return true;
      }
    }
    return false;
  }

  let listenPort = port;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      applySecurityHeaders(res);
      if (!requestOriginAllowed(req, listenPort)) return json(res, { error: 'forbidden origin' }, 403);
      if (requiresSessionToken(req, url) && requestToken(req, url) !== sessionToken) {
        return json(res, { error: 'invalid session token' }, 403);
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return file(res, path.join(publicDir, 'index.html'), 'text/html; charset=utf-8', {
          '__TRACEFLOW_TOKEN__': sessionToken,
        });
      }
      if (req.method === 'GET' && url.pathname === '/app.js') {
        return file(res, path.join(publicDir, 'app.js'), 'text/javascript; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/styles.css') {
        return file(res, path.join(publicDir, 'styles.css'), 'text/css; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        clients.add(res);
        const packet = `event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`;
        if (!writePacket(res, packet)) dropStream(clients, res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/control/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        controlClients.add(res);
        if (!writePacket(res, `data: ${JSON.stringify(control)}\n\n`)) dropStream(controlClients, res);
        req.on('close', () => controlClients.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/control') return json(res, control);
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, snapshot());
      if (req.method === 'POST' && url.pathname === '/ingest') {
        const event = await readJson(req);
        if (event.type === 'batch' && Array.isArray(event.events)) {
          for (const item of event.events) applyIngest(item, null);
          return json(res, { ok: true });
        }
        if (applyIngest(event, res)) return;
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/control') {
        const body = await readJson(req);
        if (body.mode === 'run' || body.mode === 'step') control.mode = body.mode;
        if (typeof body.pauseOnResponse === 'boolean') control.pauseOnResponse = body.pauseOnResponse;
        if (typeof body.captureBrowser === 'boolean') control.captureBrowser = body.captureBrowser;
        if (typeof body.captureDebug === 'boolean') control.captureDebug = body.captureDebug;
        if (['all', 'matched', 'armed', 'off'].includes(body.capture)) control.capture = body.capture;
        if (Array.isArray(body.include)) control.include = body.include.map(String).filter(Boolean);
        if (Array.isArray(body.ignore)) control.ignore = body.ignore.map(String).filter(Boolean);
        noteControl();
        return json(res, control);
      }
      if (req.method === 'POST' && url.pathname === '/api/step') {
        const gate = gates[0];
        if (gate) releaseGate(gate.id);
        return json(res, { ok: true, released: gate?.id || null, waiting: gates.length });
      }
      if (req.method === 'POST' && url.pathname === '/api/resume') {
        control.mode = 'run';
        while (gates[0]) releaseGate(gates[0].id);
        noteControl();
        return json(res, control);
      }
      if (req.method === 'POST' && url.pathname === '/api/pause') {
        control.mode = 'step';
        noteControl();
        return json(res, control);
      }
      const pinMatch = url.pathname.match(/^\/api\/traces\/([^/]+)\/pin$/);
      if (req.method === 'POST' && pinMatch) {
        const id = decodeURIComponent(pinMatch[1]);
        const trace = traces.get(id);
        if (!trace) return json(res, { error: 'unknown trace' }, 404);
        const body = await readJson(req);
        trace.pinned = Boolean(body.pinned);
        noteTraceMeta(trace);
        return json(res, { ok: true, id, pinned: trace.pinned });
      }
      if (req.method === 'POST' && url.pathname === '/api/clear') {
        traces.clear();
        noteClear();
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/clear-logs') {
        logEntries.length = 0;
        pendingLogs.length = 0;
        noteLogsClear();
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/sample') {
        if (!demo) return json(res, { error: 'sample request is only available in demo mode' }, 404);
        const frontend = activeConfig.services.find((service) => service.name === 'frontend');
        if (!frontend?.port) return json(res, { error: 'demo frontend is not configured' }, 503);
        const response = await fetch(`http://127.0.0.1:${frontend.port}/request`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'Mozilla/5.0 Traceflow Demo',
          },
          body: JSON.stringify({ message: 'hello', count: 2 }),
        });
        const body = await response.text();
        return json(res, { ok: response.ok, status: response.status, body }, response.ok ? 200 : 502);
      }
      if (req.method === 'POST' && url.pathname === '/api/discovery/scan') {
        const result = scanListeners();
        return json(res, result, result.ok === false ? 500 : 200);
      }
      if (req.method === 'POST' && url.pathname === '/api/discovery/attach') {
        const body = await readJson(req);
        const result = await attachDiscovered(body.port);
        return json(res, result, result.ok === false ? 409 : 200);
      }
      const serviceMatch = url.pathname.match(/^\/api\/services\/([^/]+)\/(start|stop|attach)$/);
      if (req.method === 'POST' && serviceMatch) {
        const name = decodeURIComponent(serviceMatch[1]);
        const action = serviceMatch[2];
        const result = action === 'start' ? await startService(name)
          : action === 'stop' ? await stopService(name)
            : await attachService(name);
        return json(res, result, result.ok === false ? 409 : 200);
      }
      json(res, { error: 'not found' }, 404);
    } catch (err) {
      json(res, { error: err.message }, err.statusCode || 500);
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  listenPort = server.address().port;
  await refreshListeners();
  scheduleListeners();
  expireTimer = setInterval(expireTraces, 5000);
  expireTimer.unref();
  controlPing = setInterval(() => {
    for (const client of [...controlClients]) {
      if (!writePacket(client, ': ping\n\n')) dropStream(controlClients, client);
    }
  }, 15_000);
  controlPing.unref();

  async function close() {
    closed = true;
    clearTimeout(listenerTimer);
    clearInterval(expireTimer);
    clearInterval(controlPing);
    const ownedServices = activeConfig.services
      .filter((service) => runtimes.get(service.name)?.owner === 'traceflow');
    await Promise.all(ownedServices.map((service) => stopService(service.name)));
    for (const client of clients) {
      try { client.end(); } catch { /* already gone */ }
    }
    for (const client of controlClients) {
      try { client.end(); } catch { /* already gone */ }
    }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }

  return {
    port: listenPort,
    url: `http://127.0.0.1:${listenPort}`,
    token: sessionToken,
    close,
    startService,
    stopService,
    scanListeners,
    config: activeConfig,
  };
}

function demoConfig() {
  const baseEnv = {
    DEMO_DELAY: '120',
    DEMO_FRONTEND_PORT: '9101',
    DEMO_API_PORT: '9102',
    DEMO_WORKER_PORT: '9103',
  };
  return {
    include: ['/request', '/process', '/lookup'],
    ignore: DEFAULT_IGNORE,
    services: [
      {
        name: 'frontend',
        cwd: '.',
        args: ['src/demo/trio.cjs'],
        port: 9101,
        color: '#ffb25b',
        env: { ...baseEnv, DEMO_ROLE: 'frontend' },
      },
      {
        name: 'api',
        cwd: '.',
        args: ['src/demo/trio.cjs'],
        port: 9102,
        color: '#7ee0c6',
        env: { ...baseEnv, DEMO_ROLE: 'api' },
      },
      {
        name: 'worker',
        cwd: '.',
        args: ['src/demo/trio.cjs'],
        port: 9103,
        color: '#d6ff4a',
        env: { ...baseEnv, DEMO_ROLE: 'worker' },
      },
    ],
  };
}

function isDebugTraffic(value) {
  const pathname = String(value || '/').split('?')[0];
  return pathname === '/message' || pathname.startsWith('/inspector/');
}

const SENSITIVE_FIELD = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passcode|secret|token|access[-_]?token|refresh[-_]?token|api[-_]?key|session)$/i;

function sanitizeEvent(event) {
  if (!event || typeof event !== 'object') return event;
  if (event.type === 'log') return { ...event, line: redactText(event.line) };
  if (event.type !== 'span') return event;
  return {
    ...event,
    path: redactPath(event.path),
    requestHeaders: redactHeaders(event.requestHeaders),
    responseHeaders: redactHeaders(event.responseHeaders),
    requestBody: redactBody(event.requestBody),
    responseBody: redactBody(event.responseBody),
  };
}

function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
    key,
    SENSITIVE_FIELD.test(key) ? '[redacted]' : value,
  ]));
}

function redactBody(body) {
  if (typeof body !== 'string' || !body) return body;
  try {
    return JSON.stringify(redactObject(JSON.parse(body)));
  } catch {
    return redactText(body);
  }
}

function redactObject(value) {
  if (Array.isArray(value)) return value.map(redactObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_FIELD.test(key) ? '[redacted]' : redactObject(item),
  ]));
}

function redactPath(value) {
  if (typeof value !== 'string' || !value.includes('?')) return value;
  try {
    const url = new URL(value, 'http://traceflow.local');
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_FIELD.test(key)) url.searchParams.set(key, '[redacted]');
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return redactText(value);
  }
}

function redactText(value) {
  return String(value || '')
    .replace(/((?:authorization|password|passcode|secret|token|access[-_]?token|refresh[-_]?token|api[-_]?key|session)["']?\s*[:=]\s*["']?)([^"'\s,&}]+)/gi, '$1[redacted]')
    .replace(/(bearer\s+)[a-z0-9._~+/-]+=*/gi, '$1[redacted]');
}

function rememberedServicesFile(config) {
  if (!config?.baseDir) return null;
  return path.join(config.baseDir, 'traceflow.services.json');
}

export function restoreRememberedServices(config) {
  const file = rememberedServicesFile(config);
  if (!file || !fs.existsSync(file)) return;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  if (!Array.isArray(config.services)) config.services = [];
  const ports = new Set(config.services.map((service) => Number(service.port)));
  const names = new Set(config.services.map((service) => service.name));
  for (const service of parsed.services || []) {
    const port = Number(service?.port);
    const name = String(service?.name || `localhost-${port}`);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || ports.has(port) || names.has(name)) continue;
    ports.add(port);
    names.add(name);
    config.services.push({
      name,
      port,
      command: service.command ? String(service.command) : '',
      cwd: service.cwd ? String(service.cwd) : '',
      repo: service.repo || null,
      discovered: true,
    });
  }
}

function rememberLaunch(service, pid) {
  const launch = launchTarget(pid);
  if (!launch) return false;
  let changed = false;
  const command = !launch.sameProcess && launch.command ? launch.command : service.command;
  const cwd = launch.cwd || service.cwd || workingDirectoryForCommand(command) || '';
  if (command && service.command !== command) {
    service.command = command;
    changed = true;
  }
  if (cwd && service.cwd !== cwd) {
    service.cwd = cwd;
    changed = true;
  }
  return changed;
}

export function saveRememberedServices(config) {
  const file = rememberedServicesFile(config);
  if (!file) return;
  const services = (config.services || []).filter((service) => service.discovered).map((service) => ({
    name: service.name,
    port: service.port,
    command: service.command || '',
    cwd: service.cwd || '',
    repo: service.repo || null,
    discovered: true,
  }));
  fs.writeFileSync(file, `${JSON.stringify({ services }, null, 2)}\n`);
}

export function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const file = env.TRACEFLOW_CONFIG
    ? path.resolve(cwd, env.TRACEFLOW_CONFIG)
    : path.join(cwd, 'traceflow.config.json');
  if (!fs.existsSync(file)) {
    return { port: 9477, include: [], ignore: DEFAULT_IGNORE, services: [], baseDir: cwd };
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed.services !== undefined && !Array.isArray(parsed.services)) throw new Error('traceflow.config.json services must be an array');
  return { ...parsed, services: parsed.services || [], baseDir: path.dirname(file) };
}

export function nodeBinForProject(cwd, { homedir = os.homedir(), fnmDir = process.env.FNM_DIR } = {}) {
  const requested = readProjectNodeVersion(cwd);
  if (!requested) return null;
  const bins = [];
  const roots = [
    fnmDir && path.join(fnmDir, 'node-versions'),
    path.join(homedir, '.local/share/fnm/node-versions'),
    path.join(homedir, 'Library/Application Support/fnm/node-versions'),
    path.join(homedir, '.fnm/node-versions'),
    path.join(homedir, '.nvm/versions/node'),
  ].filter(Boolean);
  for (const rootDir of roots) {
    let entries = [];
    try { entries = fs.readdirSync(rootDir); } catch { continue; }
    for (const entry of entries) {
      const version = entry.replace(/^v/, '');
      if (!versionMatches(version, requested)) continue;
      for (const bin of [path.join(rootDir, entry, 'installation/bin'), path.join(rootDir, entry, 'bin')]) {
        if (fs.existsSync(path.join(bin, 'node'))) bins.push({ version, bin });
      }
    }
  }
  bins.sort((a, b) => compareVersions(b.version, a.version));
  return bins[0]?.bin || null;
}

function readProjectNodeVersion(directory) {
  for (const file of ['.nvmrc', '.node-version']) {
    try {
      const line = fs.readFileSync(path.join(directory, file), 'utf8').split('\n').map((item) => item.trim()).find(Boolean);
      if (line) return line.replace(/^v/, '');
    } catch { /* not present */ }
  }
  try {
    const line = fs.readFileSync(path.join(directory, '.tool-versions'), 'utf8').split('\n').find((item) => /^(node|nodejs)\s+/.test(item));
    if (line) return line.split(/\s+/)[1].replace(/^v/, '');
  } catch { /* not present */ }
  return null;
}

function versionMatches(installed, requested) {
  const want = versionParts(requested);
  const have = versionParts(installed);
  return want.length > 0 && want.every((part, index) => have[index] === part);
}

function versionParts(version) {
  return String(version).replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10)).filter((part) => Number.isInteger(part));
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff) return diff;
  }
  return 0;
}

function joinNodeOptions(existing, preload) {
  const flag = `--require=${preload}`;
  return [existing, flag].filter(Boolean).join(' ').trim();
}

function preferName(current, next) {
  if (!next) return current;
  if (!current) return next;
  if (String(current).startsWith('proxy:') && !String(next).startsWith('proxy:')) return next;
  return current;
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function file(res, filePath, type, replacements = null) {
  let body = fs.readFileSync(filePath);
  if (replacements) {
    let text = body.toString('utf8');
    for (const [from, to] of Object.entries(replacements)) text = text.replaceAll(from, to);
    body = Buffer.from(text);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': body.length });
  res.end(body);
}

function applySecurityHeaders(res) {
  res.setHeader('content-security-policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cache-control', 'no-store');
}

function requestOriginAllowed(req, port) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) return true;
  try {
    return allowedHosts.has(new URL(req.headers.origin).host.toLowerCase());
  } catch {
    return false;
  }
}

function requiresSessionToken(req, url) {
  return req.method === 'POST' || url.pathname === '/events' || url.pathname === '/api/control/stream';
}

function requestToken(req, url) {
  return req.headers['x-traceflow-token'] || url.searchParams.get('token') || '';
}

function json(res, body, status = 200) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

const MAX_JSON_BYTES = 4_000_000;
const LOG_CHUNK = 16_384;

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        const err = new Error('payload too large');
        err.statusCode = 413;
        fail(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = size ? Buffer.concat(chunks, size).toString('utf8') : '';
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', (err) => fail(err));
  });
}

function takeLogLines(rest, text) {
  let pending = rest + text;
  const lines = [];
  while (pending.length) {
    const match = /\r?\n/.exec(pending);
    if (match && match.index <= LOG_CHUNK) {
      lines.push(pending.slice(0, match.index));
      pending = pending.slice(match.index + match[0].length);
      continue;
    }
    if (pending.length <= LOG_CHUNK) break;
    lines.push(pending.slice(0, LOG_CHUNK));
    pending = pending.slice(LOG_CHUNK);
  }
  return { lines, rest: pending };
}

const backpressuredStreams = new WeakSet();

function writePacket(res, packet) {
  if (!res || res.writableEnded || res.destroyed) return false;
  if (backpressuredStreams.has(res)) return true;
  try {
    if (!res.write(packet)) {
      backpressuredStreams.add(res);
      res.once('drain', () => backpressuredStreams.delete(res));
    }
    return true;
  } catch {
    return false;
  }
}

function dropStream(set, res) {
  set.delete(res);
  try { res.end(); } catch { /* already gone */ }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const isMain = process.argv[1] && sameFile(process.argv[1], fileURLToPath(import.meta.url));
if (isMain) {
  const demo = process.env.TRACEFLOW_DEMO === '1';
  const config = demo ? undefined : loadConfig();
  const app = await startServer({ port: config?.port || 9477, demo, config });
  process.stdout.write(`Traceflow at ${app.url}\n`);
  if (demo) {
    for (const service of app.config.services) app.startService(service.name);
    process.stdout.write('Demo services: frontend :9101, api :9102, worker :9103\n');
  }
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function sameFile(first, second) {
  try {
    return fs.realpathSync(first) === fs.realpathSync(second);
  } catch {
    return false;
  }
}
