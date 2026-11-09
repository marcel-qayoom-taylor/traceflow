#!/usr/bin/env node

import http from 'node:http';
import { preflight, readiness, healthStatus } from './preflight.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  attachToListener,
  attachToPid,
  killListener,
  launchTarget,
  listenerOn,
  listeners,
  listenersByPort,
  locateProcess,
  matchTokens,
  pidAlive,
  processCwds,
  processGroups,
  processTable,
  processTargets,
  repositoryName,
  signalProcessTree,
  stopListener,
  subtree,
  workingDirectoryForCommand,
} from './attach.mjs';

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
    autoReattach: activeConfig.autoReattach !== false,
    include: activeConfig.include || [],
    ignore: activeConfig.ignore || DEFAULT_IGNORE,
  };
  const traces = new Map();
  const gates = [];
  const agents = new Map();
  const logEntries = [];
  const logRest = new Map();
  const runtimes = new Map();
  const stackRuns = new Map();
  const startsInFlight = new Map();
  let stackBusy = false;
  let discovered = [];
  let discoveredProcesses = [];
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
  // Attaches in progress per service, so the refresh loop never starts a second one alongside.
  const attachesInFlight = new Map();
  const DIFFERENT_PROJECT = 'A different project is listening on this port, so it was left unattached.';
  const NOT_NODE = 'The process on this port is not Node, so it was left unattached.';
  const NO_NODE_PROCESS = 'No Node.js process is running under this command yet, so nothing was attached.';
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
    runtimes.set(service.name, newRuntime({
      repo: repositoryName(path.resolve(activeConfig.baseDir || root, service.cwd || '.')),
    }));
  }

  function newRuntime(overrides = {}) {
    return {
      status: 'stopped',
      pid: null,
      exitCode: null,
      child: null,
      owner: null,
      attachedPid: null,
      // Process services: the Node pids under the matched command, and the set last attached.
      targets: [],
      attachedTargets: '',
      message: '',
      problem: '',
      repo: null,
      ...overrides,
    };
  }

  function peerTable() {
    const peers = activeConfig.services.filter(hasPort).map((service) => ({
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
      discoveredProcesses: discoveredProcesses.map(discoveredProcessView),
      traces: listedTraces(),
      logEntries: [...logEntries],
      sampleUrl: demo ? '/api/sample' : null,
    };
  }

  function serviceView(service) {
    const runtime = runtimes.get(service.name);
    const seen = agents.get(service.name) || 0;
    const processService = isProcessService(service);
    return {
      name: service.name,
      kind: processService ? 'process' : 'port',
      port: processService ? null : service.port,
      match: processService ? processMatch(service) : null,
      processes: processService ? runtime?.targets.length || 0 : null,
      color: service.color || SERVICE_COLORS[activeConfig.services.indexOf(service) % SERVICE_COLORS.length],
      status: runtime?.status || 'stopped',
      pid: runtime?.pid || null,
      exitCode: runtime?.exitCode ?? null,
      owner: runtime?.owner || null,
      attached: processService
        ? Boolean(runtime?.attachedTargets && runtime.attachedTargets === targetKey(runtime.targets))
        : Boolean(runtime?.attachedPid && runtime.attachedPid === runtime.pid),
      discovered: Boolean(service.discovered),
      message: runtime?.message || '',
      problem: processService && runtime?.status === 'running' && !runtime?.targets.length ? 'Worker process not detected' : runtime?.problem || '',
      prerequisites: runtime?.prerequisites || [],
      repo: runtime?.repo || service.repo || null,
      agent: Date.now() - seen < 5000,
      command: service.command || `node ${service.args?.join(' ')}`,
    };
  }

  function discoveredProcessView(group) {
    return {
      kind: 'process',
      pid: group.pid,
      command: group.command,
      match: group.match,
      workingDirectory: group.workingDirectory,
      repo: group.repo,
      repoPath: group.repoPath,
      processes: group.processes,
      attachable: group.attachable,
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
      packet.discoveredProcesses = discoveredProcesses.map(discoveredProcessView);
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
    const clean = logText(line);
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

  // A service Traceflow starts writes each line twice: to the stdout pipe, and through its agent to
  // /ingest with the request it belongs to. Piped lines wait briefly so the agent's linked copy is
  // kept and the piped copy dropped; output from processes without an agent still appears.
  const PIPE_HOLD_MS = 300;
  const ECHO_WINDOW_MS = 2000;
  const heldLines = [];
  const recentLines = new Map();
  let heldTimer = null;

  function rememberLine(service, source, text) {
    const key = `${service}\0${source}`;
    if (!recentLines.has(key)) recentLines.set(key, new Map());
    const bucket = recentLines.get(key);
    if (!bucket.has(text)) bucket.set(text, []);
    bucket.get(text).push(Date.now());
    if (bucket.size > 1000) bucket.delete(bucket.keys().next().value);
  }

  function takeLine(service, source, text) {
    const bucket = recentLines.get(`${service}\0${source}`);
    const times = bucket?.get(text);
    if (!times) return false;
    const now = Date.now();
    while (times.length && now - times[0] > ECHO_WINDOW_MS) times.shift();
    const found = times.length > 0;
    if (found) times.shift();
    if (!times.length) bucket.delete(text);
    return found;
  }

  function holdPipedLine(service, line) {
    heldLines.push({ service, line, text: logText(line), at: Date.now() });
    scheduleHeldLines();
  }

  function scheduleHeldLines() {
    if (heldTimer || !heldLines.length) return;
    heldTimer = setTimeout(() => {
      heldTimer = null;
      releaseHeldLines();
    }, Math.max(0, heldLines[0].at + PIPE_HOLD_MS - Date.now()));
    heldTimer.unref?.();
  }

  // Release piped lines that have waited long enough, or every line of `service` when it exits.
  function releaseHeldLines(service = null) {
    const now = Date.now();
    for (let index = 0; index < heldLines.length;) {
      const held = heldLines[index];
      if (held.service !== service && now - held.at < PIPE_HOLD_MS) {
        index += 1;
        continue;
      }
      heldLines.splice(index, 1);
      if (takeLine(held.service, 'agent', held.text)) continue;
      pushLog(held.service, held.line, { at: held.at });
      rememberLine(held.service, 'pipe', held.text);
    }
    scheduleHeldLines();
  }

  function forgetLines(service) {
    recentLines.delete(`${service}\0agent`);
    recentLines.delete(`${service}\0pipe`);
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

  async function servicePreflight(name, { requireRunning = false } = {}) {
    const spec = activeConfig.services.find(service => service.name === name);
    if (!spec) return { service: name, ok: false, status: 'unhealthy', checks: [{ check: 'configuration', status: 'error', message: 'Service is not configured' }] };
    const cwd = path.resolve(activeConfig.baseDir || root, spec.cwd || '.');
    const listener = hasPort(spec) ? listenerOn(spec.port) : null;
    const running = hasPort(spec)
      ? Boolean(listener && sameProcessIdentity(spec, { workingDirectory: launchTarget(listener.pid)?.cwd }))
      : Boolean(runtimes.get(name)?.child || locateService(spec)?.root);
    const report = await preflight(spec, { baseDir: activeConfig.baseDir || root, nodeBin: nodeBinForProject(cwd), listener, running });
    if (requireRunning) {
      report.checks.push({ check: 'running', status: running ? 'ok' : 'error', message: running ? 'Service is running' : 'Service is not running' });
      if (!running) report.ok = false;
    }
    if (isProcessService(spec) && running) {
      const seen = agents.get(name);
      const recent = seen && Date.now() - seen < 5000;
      report.checks.push({ check: 'agent-heartbeat', status: recent ? 'ok' : 'warn', message: recent ? 'Traceflow agent heartbeat received; queue connectivity and job progress are not verified' : 'No recent Traceflow agent heartbeat; queue connectivity and job progress are not verified', ...(seen ? { lastSeen: new Date(seen).toISOString() } : {}) });
    }
    report.status = healthStatus(report.checks);
    return report;
  }

  async function stackAction(name, action) {
    if (!['start', 'stop'].includes(action)) return { ok: false, error: 'Unknown stack action' };
    if (stackBusy) return { ok: false, error: 'Another stack operation is in progress' };
    const members = activeConfig.stacks?.[name];
    const names = new Set(activeConfig.services.map(service => service.name));
    if (!Array.isArray(members) || !members.length || members.some(member => !names.has(member))) {
      return { ok: false, error: 'Unknown stack or invalid service members' };
    }
    stackBusy = true;
    try {
      const owned = stackRuns.get(name) || new Map();
      stackRuns.set(name, owned);
      const results = [];
      for (const member of action === 'stop' ? [...members].reverse() : members) {
        const runtime = runtimes.get(member);
        if (action === 'stop') {
          // Child identity prevents cleanup from stopping a replacement process, even if a PID is reused.
          if (!owned.has(member) || runtime?.owner !== 'traceflow' || runtime.child !== owned.get(member)) {
            results.push({ service: member, ok: true, skipped: true });
            owned.delete(member);
            continue;
          }
          const result = await stopService(member);
          results.push({ service: member, ...result });
          if (result.ok) owned.delete(member);
        } else {
          const spec = activeConfig.services.find(service => service.name === member);
          const existing = runtime?.child || (hasPort(spec) ? listenerOn(spec.port) : locateService(spec)?.root);
          if (existing) {
            const checks = await servicePreflight(member);
            results.push({ service: member, ok: checks.ok, reused: true, preflight: checks });
            if (!checks.ok) break;
            continue;
          }
          const alreadyStarting = startsInFlight.has(member);
          const result = await startService(member);
          if (result.ok && result.pid && !alreadyStarting) owned.set(member, runtime.child);
          if (result.ok && spec.healthPath) {
            const deadline = Date.now() + 10_000;
            let ready;
            do {
              ready = await readiness(spec, Boolean(runtime.child), Math.max(1, Math.min(2000, deadline - Date.now())));
              if (ready.status === 'ok') break;
              await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(500, deadline - Date.now()))));
            } while (runtime.child && Date.now() < deadline);
            result.readiness = ready;
            result.ok = ready.status === 'ok';
            if (!result.ok) result.error = 'Service did not become ready within 10 seconds';
          }
          results.push({ service: member, ...result });
          if (!result.ok) break;
        }
      }
      const failed = results.find(result => !result.ok);
      return { ok: !failed, stack: name, results, ...(failed ? { error: failed.error || `Preflight failed for ${failed.service}` } : {}) };
    } finally { stackBusy = false; }
  }

  async function startService(name) {
    if (startsInFlight.has(name)) return startsInFlight.get(name);
    const operation = startServiceImpl(name).finally(() => startsInFlight.delete(name));
    startsInFlight.set(name, operation);
    return operation;
  }

  async function startServiceImpl(name) {
    const spec = activeConfig.services.find((service) => service.name === name);
    if (!spec) return { ok: false, error: 'unknown service' };
    const runtime = runtimes.get(name);
    if (runtime?.owner === 'traceflow' && runtime.status === 'running' && runtime.child) return { ok: true, status: 'running' };
    if (!spec.cwd) spec.cwd = workingDirectoryForCommand(spec.command) || '';
    const runningPid = hasPort(spec) ? listenerOn(spec.port)?.pid : locateService(spec)?.root;
    if (runningPid) {
      runtime.message = `Already running in your terminal (pid ${runningPid}). Stop it before starting a new one.`;
      runtime.problem = runtime.message;
      noteServices();
      return { ok: false, error: runtime.message };
    }
    const cwd = path.resolve(activeConfig.baseDir || root, spec.cwd || '.');
    const checks = await servicePreflight(name);
    runtime.prerequisites = checks.checks?.filter(check => check.status !== 'ok' && check.check !== 'readiness') || [];
    // Readiness is evaluated after startup; only launch prerequisites block Start.
    if (checks.checks?.some(check => check.status === 'error' && check.check !== 'readiness')) {
      return { ok: false, error: checks.checks.filter(check => check.status === 'error' && check.check !== 'readiness').map(check => check.message).join('; '), preflight: checks };
    }
    const env = {
      ...process.env,
      ...spec.env,
      ...(hasPort(spec) ? { PORT: String(spec.port) } : {}),
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
      ? spawn(nodeBin ? path.join(nodeBin, 'node') : process.execPath, spec.args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('bash', ['-c', spec.command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    runtime.child = child;
    runtime.pid = child.pid;
    runtime.status = 'running';
    runtime.owner = 'traceflow';
    runtime.targets = [];
    runtime.attachedTargets = '';
    runtime.message = '';
    runtime.problem = '';
    runtime.repo = repositoryName(cwd);
    runtime.exitCode = null;
    const take = (chunk) => {
      const key = `${name}:rest`;
      const split = takeLogLines(logRest.get(key) || '', chunk.toString('utf8'));
      logRest.set(key, split.rest);
      for (const line of split.lines) holdPipedLine(name, line);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('exit', (code, signal) => {
      releaseHeldLines(name);
      forgetLines(name);
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
      const stopped = hasPort(spec) ? await waitForPortToStop(spec.port) : await waitForGroupToExit(pid);
      clearTimeout(killer);
      if (stopped) return { ok: true };
      runtime.status = 'running';
      runtime.message = hasPort(spec) ? `Process is still listening on ${spec.port}` : `Process group ${pid} is still running`;
      runtime.problem = runtime.message;
      noteServices();
      return { ok: false, error: runtime.message };
    }
    if (isProcessService(spec)) return stopTerminalProcess(spec, runtime);
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

  async function stopTerminalProcess(spec, runtime) {
    const found = locateService(spec);
    if (!found) {
      markStopped(runtime);
      noteServices();
      return { ok: true };
    }
    runtime.status = 'stopping';
    runtime.message = 'Stopping…';
    runtime.problem = '';
    noteServices();
    const gone = () => !found.pids.some(pidAlive);
    signalProcessTree(found.root, 'SIGTERM');
    if (!await waitUntil(gone, 2000)) signalProcessTree(found.root, 'SIGKILL');
    if (!await waitUntil(gone, 2000)) {
      runtime.status = 'running';
      runtime.pid = found.root;
      runtime.owner = 'terminal';
      runtime.message = `Process ${found.root} is still running`;
      runtime.problem = runtime.message;
      noteServices();
      return { ok: false, error: runtime.message };
    }
    markStopped(runtime);
    pushLog(spec.name, `[traceflow] stopped pid ${found.root}`);
    noteServices();
    return { ok: true, pid: found.root };
  }

  function markStopped(runtime) {
    runtime.status = 'stopped';
    runtime.pid = null;
    runtime.owner = null;
    runtime.attachedPid = null;
    runtime.targets = [];
    runtime.attachedTargets = '';
    runtime.message = '';
    runtime.problem = '';
  }

  async function waitForPortToStop(port, timeoutMs = 5000) {
    return waitUntil(() => !listenerOn(port), timeoutMs);
  }

  // A started service is its own process group, so the whole tree is gone once the group is empty.
  async function waitForGroupToExit(pgid, timeoutMs = 5000) {
    return waitUntil(() => !groupAlive(pgid), timeoutMs);
  }

  /** Locate the running process tree for a process service, ignoring trees Traceflow started itself. */
  function locateService(spec, table = processTable()) {
    if (!table) return null;
    return locateProcess(table, { tokens: processMatch(spec), cwd: processDirectory(spec) }, {
      exclude: ownedPids(table),
      cwdOf: cachedCwds(table),
    });
  }

  // Relative and missing working directories resolve from the config file, as Start does, so a
  // configured command never matches (or stops) the same command in an unrelated project.
  function processDirectory(spec) {
    return canonicalDirectory(path.resolve(activeConfig.baseDir || root, spec.cwd || '.'));
  }

  // Working directories by pid, kept while the pid is alive, so polling does not run lsof each tick.
  const cwdCache = new Map();
  function cachedCwds(table) {
    if (!table) return processCwds;
    for (const pid of cwdCache.keys()) {
      if (!table.byPid.has(pid)) cwdCache.delete(pid);
    }
    return (pids) => {
      const missing = pids.filter((pid) => !cwdCache.has(pid));
      if (missing.length) {
        const found = processCwds(missing);
        for (const pid of missing) cwdCache.set(pid, found.get(pid) || null);
      }
      return new Map(pids.map((pid) => [pid, cwdCache.get(pid) || undefined]));
    };
  }

  function ownedPids(table) {
    const pids = new Set();
    for (const runtime of runtimes.values()) {
      if (runtime.owner !== 'traceflow' || !runtime.child?.pid) continue;
      for (const pid of subtree(table, runtime.child.pid)) pids.add(pid);
    }
    return pids;
  }

  async function attachService(name, options = {}) {
    attachesInFlight.set(name, (attachesInFlight.get(name) || 0) + 1);
    try {
      return await attachServiceNow(name, options);
    } finally {
      const left = attachesInFlight.get(name) - 1;
      if (left > 0) attachesInFlight.set(name, left);
      else attachesInFlight.delete(name);
    }
  }

  async function attachServiceNow(name, { remember = false } = {}) {
    const spec = activeConfig.services.find((service) => service.name === name);
    const runtime = runtimes.get(name);
    if (!spec || !runtime) return { ok: false, error: 'unknown service' };
    if (remember) spec.sticky = true;
    const checks = await servicePreflight(name);
    runtime.prerequisites = checks.checks?.filter(check => check.status !== 'ok' && check.check !== 'readiness') || [];
    noteServices();
    try {
      const previousHello = agents.get(spec.name) || 0;
      const options = {
        service: spec.name,
        ingest: `http://127.0.0.1:${listenPort}`,
        token: sessionToken,
        peers: peerTable(),
        control,
        agentPath,
      };
      const result = isProcessService(spec)
        ? await attachProcess(spec, runtime, options)
        : await attachToListener({ ...options, port: spec.port });
      if (result.ok && !(await waitForFreshAgent(spec.name, previousHello))) {
        result.ok = false;
        result.error = 'The agent loaded, but did not connect to Traceflow. Restart the service once, then attach again.';
      }
      runtime.message = result.ok ? result.warning || '' : result.error;
      runtime.problem = result.ok || runtime.status === 'running' ? '' : result.error;
      if (result.ok && isProcessService(spec)) {
        runtime.attachedTargets = targetKey(result.targets);
        pushLog(name, `[traceflow] attached to pid ${result.pids.join(', ')}`);
        if (result.warning) pushLog(name, `[traceflow] ${result.warning}`);
        if (spec.sticky) saveRememberedServices(activeConfig);
      } else if (result.ok) {
        runtime.attachedPid = result.pid;
        pushLog(name, `[traceflow] attached to pid ${result.pid}`);
        if (spec.sticky) {
          const launch = launchTarget(result.pid);
          if (launch?.cwd) spec.stickyCwd = canonicalDirectory(launch.cwd);
          if (spec.discovered) rememberLaunch(spec, result.pid);
          saveRememberedServices(activeConfig);
        }
      }
      noteServices();
      return result;
    } catch (err) {
      runtime.message = err.message;
      runtime.problem = runtime.status === 'running' ? '' : err.message;
      noteServices();
      return { ok: false, error: err.message };
    }
  }

  // Attach to every Node process under the matched command: the worker itself, not yarn or the watcher.
  async function attachProcess(spec, runtime, options) {
    const found = locateService(spec);
    if (!found) return { ok: false, error: `No running process matches "${processMatch(spec).join(' ')}"` };
    if (runtime.owner !== 'traceflow') {
      runtime.status = 'running';
      runtime.pid = found.root;
      runtime.owner = 'terminal';
      runtime.targets = found.targets;
      if (found.cwd) runtime.repo = repositoryName(found.cwd) || runtime.repo;
    }
    if (!found.targets.length) return { ok: false, error: NO_NODE_PROCESS };
    const pids = [];
    const failures = [];
    for (const pid of found.targets) {
      try {
        const result = await attachToPid({ ...options, pid });
        if (result.ok) pids.push(pid);
        else failures.push(`pid ${pid}: ${result.error}`);
      } catch (err) {
        failures.push(`pid ${pid}: ${err.message}`);
      }
    }
    if (!pids.length) return { ok: false, error: failures[0] || 'Could not attach to the process' };
    return {
      ok: true,
      pid: found.root,
      pids,
      targets: found.targets,
      warning: failures.length ? `Attached ${pids.length} of ${found.targets.length} processes. ${failures[0]}` : '',
    };
  }

  async function waitForFreshAgent(name, previousHello, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((agents.get(name) || 0) > previousHello) return true;
      await sleep(50);
    }
    return (agents.get(name) || 0) > previousHello;
  }

  function clearStickyMessage(runtime) {
    if (runtime.message !== DIFFERENT_PROJECT && runtime.message !== NOT_NODE && runtime.message !== NO_NODE_PROCESS) return false;
    runtime.message = '';
    return true;
  }

  function scheduleReattach(name) {
    if (closed || attachesInFlight.has(name)) return;
    void attachService(name);
  }

  function stickyDirectory(service) {
    const raw = service.stickyCwd || service.cwd;
    if (!raw) return null;
    return canonicalDirectory(path.resolve(activeConfig.baseDir || root, raw));
  }

  function sameProcessIdentity(service, listener) {
    const expected = stickyDirectory(service);
    const actual = listener?.workingDirectory ? canonicalDirectory(listener.workingDirectory) : '';
    if (!expected || !actual) return false;
    return actual === expected || actual.startsWith(`${expected}${path.sep}`) || expected.startsWith(`${actual}${path.sep}`);
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
    const table = processTable();
    const result = listeners({ table, cwdOf: cachedCwds(table) });
    if (!result.ok) return { ok: false, error: 'Could not inspect local listening ports' };
    const configuredPorts = new Set(activeConfig.services.map((service) => Number(service.port)));
    const next = result.listeners
      .filter((listener) => listener.node && listener.pid !== process.pid && !configuredPorts.has(listener.port))
      .map((listener) => ({
        ...listener,
        attachable: true,
      }));
    const groups = table ? scanProcesses(table, result.listeners) : [];
    const changed = discoverySignature(discovered) !== discoverySignature(next)
      || processSignature(discoveredProcesses) !== processSignature(groups);
    discovered = next;
    discoveredProcesses = groups;
    if (changed) noteServices();
    return { ok: true, listeners: discovered, processes: discoveredProcesses.map(discoveredProcessView) };
  }

  // Node process trees without a port, minus anything Traceflow already tracks or started.
  function scanProcesses(table, allListeners) {
    const exclude = ownedPids(table);
    for (const service of activeConfig.services) {
      if (!isProcessService(service)) continue;
      const runtime = runtimes.get(service.name);
      const rootPid = runtime?.pid || locateService(service, table)?.root;
      if (rootPid) for (const pid of subtree(table, rootPid)) exclude.add(pid);
    }
    return processGroups(table, {
      listenerPids: new Set(allListeners.map((listener) => listener.pid)),
      exclude,
      cwdOf: cachedCwds(table),
    });
  }

  function processSignature(groups) {
    return groups.map((group) => [group.pid, group.command, group.workingDirectory || '', targetKey(group.targets)].join('\0')).join('\n');
  }

  async function attachDiscoveredProcess(pid) {
    const value = Number(pid);
    if (!Number.isInteger(value) || value < 2) return { ok: false, error: 'A valid pid is required' };
    const scan = scanListeners();
    if (!scan.ok) return scan;
    const group = discoveredProcesses.find((item) => item.pid === value);
    if (!group) return { ok: false, error: `No unattached Node.js process tree has root pid ${value}` };
    const service = {
      name: uniqueServiceName(processServiceName(group)),
      command: group.command,
      cwd: group.workingDirectory || '',
      match: group.match,
      repo: group.repo,
      discovered: true,
    };
    activeConfig.services.push(service);
    runtimes.set(service.name, newRuntime({
      status: 'running',
      pid: group.pid,
      owner: 'terminal',
      targets: group.targets,
      message: 'Connecting to existing process…',
      repo: group.repo,
    }));
    discoveredProcesses = discoveredProcesses.filter((item) => item.pid !== value);
    saveRememberedServices(activeConfig);
    noteServices();
    return attachService(service.name, { remember: true });
  }

  function uniqueServiceName(base) {
    const names = new Set(activeConfig.services.map((service) => service.name));
    if (!names.has(base)) return base;
    for (let index = 2; ; index += 1) {
      if (!names.has(`${base}-${index}`)) return `${base}-${index}`;
    }
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
    runtimes.set(service.name, newRuntime({
      status: 'running', pid: listener.pid, owner: 'terminal', message: 'Connecting to existing process…', repo: listener.repo,
    }));
    discovered = discovered.filter((item) => item.port !== value);
    saveRememberedServices(activeConfig);
    noteServices();
    return attachService(service.name, { remember: true });
  }

  async function refreshListeners() {
    const portServices = activeConfig.services.filter(hasPort);
    const hasProcessServices = portServices.length < activeConfig.services.length;
    const table = hasProcessServices ? processTable() : null;
    const scanned = portServices.length
      ? listenersByPort(portServices.map((service) => service.port), { table, cwdOf: cachedCwds(table) })
      : { ok: true, byPort: new Map() };
    if (!scanned.ok) {
      listenerDelay = Math.min(Math.max(listenerDelay, 3000) * 2, 30_000);
      return;
    }
    // A failed ps only pauses process services; port services keep refreshing.
    listenerDelay = hasProcessServices && !table ? Math.min(Math.max(listenerDelay, 3000) * 2, 30_000) : 3000;
    let changed = false;
    for (const service of activeConfig.services) {
      const runtime = runtimes.get(service.name);
      if (runtime.owner === 'traceflow' && runtime.child && runtime.status === 'running') {
        if (isProcessService(service) && table && updateTargets(runtime, processTargets(table, runtime.child.pid))) changed = true;
        continue;
      }
      if (runtime.status === 'stopping') continue;
      if (isProcessService(service)) {
        if (table && refreshProcessService(service, runtime, locateService(service, table))) changed = true;
        continue;
      }
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
        const sameIdentity = sameProcessIdentity(service, listener);
        const foreign = service.sticky && Boolean(stickyDirectory(service) && listener.workingDirectory) && !sameIdentity;
        if (service.discovered && !foreign && (pidChanged || !service.cwd) && rememberLaunch(service, listener.pid)) {
          changed = true;
          saveRememberedServices(activeConfig);
        }
        if (!control.autoReattach || !service.sticky) {
          if (clearStickyMessage(runtime)) changed = true;
        } else if (runtime.attachedPid !== listener.pid) {
          const blocked = !listener.node ? NOT_NODE : foreign ? DIFFERENT_PROJECT : '';
          if (blocked && runtime.message !== blocked) {
            runtime.message = blocked;
            changed = true;
          } else if (sameIdentity) scheduleReattach(service.name);
        }
      } else if (runtime.owner === 'terminal') {
        runtime.status = 'stopped';
        runtime.pid = null;
        runtime.owner = null;
        runtime.attachedPid = null;
        runtime.problem = '';
        clearStickyMessage(runtime);
        changed = true;
      }
    }
    if (changed) noteServices();
  }

  // Track a process service started outside Traceflow. A new set of Node pids (a nodemon or tsx
  // restart) counts as a restart, so a sticky service is attached again, like a new listener pid.
  function refreshProcessService(service, runtime, found) {
    let changed = false;
    if (!found) {
      if (runtime.owner !== 'terminal') return false;
      markStopped(runtime);
      return true;
    }
    const repo = found.cwd ? repositoryName(found.cwd) : null;
    if (repo && runtime.repo !== repo) {
      runtime.repo = repo;
      changed = true;
    }
    if (runtime.status !== 'running' || runtime.pid !== found.root || runtime.owner !== 'terminal') {
      runtime.status = 'running';
      runtime.pid = found.root;
      runtime.owner = 'terminal';
      runtime.child = null;
      runtime.problem = '';
      changed = true;
    }
    const key = targetKey(found.targets);
    if (updateTargets(runtime, found.targets)) changed = true;
    if (!control.autoReattach || !service.sticky) {
      if (clearStickyMessage(runtime)) changed = true;
    } else if (runtime.attachedTargets !== key) {
      if (!found.targets.length) {
        if (runtime.message !== NO_NODE_PROCESS) {
          runtime.message = NO_NODE_PROCESS;
          changed = true;
        }
      } else {
        if (clearStickyMessage(runtime)) changed = true;
        scheduleReattach(service.name);
      }
    }
    return changed;
  }

  function updateTargets(runtime, targets) {
    if (targetKey(runtime.targets) === targetKey(targets)) return false;
    runtime.targets = targets;
    return true;
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
      const text = logText(event.line);
      const piped = runtimes.get(event.service)?.owner === 'traceflow';
      if (piped && takeLine(event.service, 'pipe', text)) return false;
      if (piped) rememberLine(event.service, 'agent', text);
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
      if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg')) {
        return file(res, path.join(publicDir, 'favicon.svg'), 'image/svg+xml');
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
      if (req.method === 'GET' && url.pathname === '/api/preflight') {
        const name = url.searchParams.get('service');
        const stack = url.searchParams.get('stack');
        if (stack && name) return json(res, { error: 'Choose a service or a stack' }, 400);
        if (stack) {
          const members = activeConfig.stacks?.[stack];
          if (!Array.isArray(members) || !members.length) return json(res, { error: 'Unknown or empty stack' }, 404);
          const services = await Promise.all(members.map(member => servicePreflight(member, { requireRunning: true })));
          return json(res, { stack, ok: services.every(service => service.ok), status: healthStatus(services.flatMap(service => service.checks)), services });
        }
        return json(res, { services: await Promise.all(activeConfig.services.filter(service => !name || service.name === name).map(service => servicePreflight(service.name))) });
      }
      if (req.method === 'GET' && url.pathname === '/api/stacks') {
        return json(res, { stacks: Object.entries(activeConfig.stacks || {}).map(([name, services]) => ({ name, services, owned: [...(stackRuns.get(name)?.keys() || [])] })) });
      }
      const stackMatch = url.pathname.match(/^\/api\/stacks\/([^/]+)\/(start|stop)$/);
      if (req.method === 'POST' && stackMatch) {
        const result = await stackAction(decodeURIComponent(stackMatch[1]), stackMatch[2]);
        return json(res, result, result.ok ? 200 : 409);
      }
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
        if (typeof body.autoReattach === 'boolean') {
          control.autoReattach = body.autoReattach;
          activeConfig.autoReattach = body.autoReattach;
          saveRememberedServices(activeConfig);
          if (body.autoReattach) void refreshListeners();
        }
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
        const result = body.pid !== undefined && body.port === undefined
          ? await attachDiscoveredProcess(body.pid)
          : await attachDiscovered(body.port);
        return json(res, result, result.ok === false ? 409 : 200);
      }
      const serviceMatch = url.pathname.match(/^\/api\/services\/([^/]+)\/(start|stop|attach)$/);
      if (req.method === 'POST' && serviceMatch) {
        const name = decodeURIComponent(serviceMatch[1]);
        const action = serviceMatch[2];
        const result = action === 'start' ? await startService(name)
          : action === 'stop' ? await stopService(name)
            : await attachService(name, { remember: true });
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
    servicePreflight,
    stackAction,
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

/** A service is found by its port when it has one, otherwise by its running command (a process service). */
function hasPort(service) {
  if (service?.port === undefined || service?.port === null || service?.port === '') return false;
  const port = Number(service.port);
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function isProcessService(service) {
  return !hasPort(service);
}

/** Tokens identifying a process service's running command: `match` when configured, else derived from `command`. */
function processMatch(service) {
  if (Array.isArray(service.match)) {
    const tokens = service.match.map((token) => String(token).trim()).filter(Boolean);
    if (tokens.length) return tokens;
  }
  if (typeof service.match === 'string' && service.match.trim()) return [service.match.trim()];
  return matchTokens(service.command || (Array.isArray(service.args) ? `node ${service.args.join(' ')}` : ''));
}

function processIdentity(service, baseDir) {
  return [canonicalDirectory(path.resolve(baseDir || root, service.cwd || '.')), ...processMatch(service)].join('\0');
}

function targetKey(pids) {
  return (pids || []).join(',');
}

function processServiceName(group) {
  const words = (group.match?.length ? group.match : [group.command]).map((token) => path.basename(String(token)));
  return words.join('-').replace(/[^\w:@.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'process';
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function waitUntil(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(100);
  }
  return check();
}

function canonicalDirectory(directory) {
  const resolved = path.resolve(directory);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
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
  config.autoReattach = parsed.autoReattach !== false;
  if (!Array.isArray(config.services)) config.services = [];
  const ports = new Set(config.services.filter(hasPort).map((service) => Number(service.port)));
  const names = new Set(config.services.map((service) => service.name));
  const processes = new Set(config.services.filter(isProcessService).map((service) => processIdentity(service, config.baseDir)));
  for (const service of parsed.services || []) {
    if (service?.kind === 'process') {
      const name = String(service.name || '');
      const match = Array.isArray(service.match) ? service.match.map(String).filter(Boolean) : [];
      if (!name || names.has(name) || (!match.length && !service.command)) continue;
      const restored = {
        name,
        kind: 'process',
        command: service.command ? String(service.command) : '',
        cwd: service.cwd ? String(service.cwd) : '',
        match,
        repo: service.repo || null,
        discovered: true,
        sticky: service.sticky !== false,
      };
      // A configured service for the same command and directory takes precedence.
      const identity = processIdentity(restored, config.baseDir);
      if (processes.has(identity)) continue;
      names.add(name);
      processes.add(identity);
      config.services.push(restored);
      continue;
    }
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
      sticky: service.sticky !== false,
      stickyCwd: service.stickyCwd ? String(service.stickyCwd) : '',
    });
  }
  const stickyByName = new Map((parsed.sticky || []).filter((item) => item?.name).map((item) => [String(item.name), item]));
  for (const service of config.services) {
    const saved = stickyByName.get(service.name);
    if (!saved || service.discovered) continue;
    service.sticky = true;
    if (saved.stickyCwd) service.stickyCwd = String(saved.stickyCwd);
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
  const services = (config.services || []).filter((service) => service.discovered).map((service) => (isProcessService(service) ? {
    name: service.name,
    kind: 'process',
    command: service.command || '',
    cwd: service.cwd || '',
    match: processMatch(service),
    repo: service.repo || null,
    discovered: true,
    sticky: Boolean(service.sticky),
  } : {
    name: service.name,
    port: service.port,
    command: service.command || '',
    cwd: service.cwd || '',
    repo: service.repo || null,
    discovered: true,
    sticky: Boolean(service.sticky),
    stickyCwd: service.stickyCwd || '',
  }));
  const sticky = (config.services || []).filter((service) => service.sticky && !service.discovered).map((service) => ({
    name: service.name,
    stickyCwd: service.stickyCwd || '',
  }));
  fs.writeFileSync(file, `${JSON.stringify({ autoReattach: config.autoReattach !== false, services, sticky }, null, 2)}\n`);
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

function logText(line) {
  return stripAnsi(redactText(String(line))).trimEnd();
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
