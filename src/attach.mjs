import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const openedByUs = new Set();

export function listenersByPort(ports) {
  const wanted = new Set(ports.map((port) => Number(port)));
  const result = listeningProcesses(wanted);
  if (!result.ok) return { ok: false, byPort: new Map() };
  const byPort = new Map();
  for (const listener of result.listeners) {
    if (wanted.has(listener.port) && !byPort.has(listener.port)) byPort.set(listener.port, listener);
  }
  return { ok: true, byPort };
}

export function listeners() {
  return listeningProcesses();
}

function listeningProcesses(wantedPorts = null) {
  let output = '';
  try {
    output = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-FpFn'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    output = err && err.stdout ? String(err.stdout) : '';
    if (!(err && err.status === 1)) return { ok: false, listeners: [] };
  }
  const sockets = [];
  const seen = new Set();
  let pid = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) {
      const match = line.match(/:(\d+)$/);
      if (!match) continue;
      const port = Number(match[1]);
      if (wantedPorts && !wantedPorts.has(port)) continue;
      const key = `${pid}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sockets.push({ pid, port });
    }
  }
  const cwdByPid = processCwds([...new Set(sockets.map((listener) => listener.pid))]);
  const processes = new Map();
  const found = sockets.map((listener) => {
    if (!processes.has(listener.pid)) {
      processes.set(listener.pid, processDetails(listener.pid, cwdByPid.get(listener.pid)));
    }
    return { ...listener, ...processes.get(listener.pid) };
  });
  return { ok: true, listeners: found.sort((a, b) => a.port - b.port || a.pid - b.pid) };
}

function isNodeCommand(command) {
  return /(?:^|\/)node(?:\s|$)/.test(command) || command.includes('/node ');
}

function processDetails(pid, cwd) {
  const command = commandOf(pid);
  const repoPath = repositoryDirectory(cwd);
  return {
    command,
    repo: repoPath ? path.basename(repoPath) : null,
    repoPath,
    workingDirectory: cwd || null,
    node: isNodeCommand(command),
  };
}

export function repositoryName(startDirectory) {
  const directory = repositoryDirectory(startDirectory);
  return directory ? path.basename(directory) : null;
}

function repositoryDirectory(startDirectory) {
  let directory = startDirectory;
  while (directory) {
    if (fs.existsSync(path.join(directory, '.git'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function processCwds(pids) {
  const directories = new Map();
  if (!pids.length) return directories;
  try {
    const output = execFileSync('lsof', ['-nP', '-a', '-p', pids.join(','), '-d', 'cwd', '-FpFn'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let pid = 0;
    for (const line of output.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid) directories.set(pid, line.slice(1));
    }
  } catch {
    // Repository names are optional metadata.
  }
  return directories;
}

export function listenerOn(port) {
  let output = '';
  try {
    output = execFileSync('lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const pid = Number((output.match(/^p(\d+)/m) || [])[1]);
  if (!pid) return null;
  const command = commandOf(pid);
  return { pid, command, node: isNodeCommand(command) };
}

export function stopListener(pid) {
  return signalDevTree(pid, 'SIGTERM');
}

export function killListener(pid) {
  return signalDevTree(pid, 'SIGKILL');
}

export function launchTarget(pid) {
  const root = devRoot(pid);
  const info = readProc(root);
  if (!info) return null;
  return {
    pid: root,
    command: info.command,
    cwd: processCwds([root]).get(root) || null,
    sameProcess: root === pid,
  };
}

export function workingDirectoryForCommand(command) {
  const paths = String(command || '').match(/\/[^\s'"]+/g) || [];
  for (const file of paths) {
    if (!fs.existsSync(file)) continue;
    const start = fs.statSync(file).isDirectory() ? file : path.dirname(file);
    const repo = repositoryDirectory(start);
    if (repo) return repo;
  }
  return null;
}

export async function attachToListener({ port, service, ingest, token, peers, control, agentPath }) {
  const listener = listenerOn(port);
  if (!listener) return { ok: false, error: `Nothing is listening on ${port}` };
  if (!listener.node) return { ok: false, error: `pid ${listener.pid} on ${port} is not Node` };

  await freeStuckInspector(listener.pid);
  const inspector = await ensureInspector(listener.pid);
  const expression = `(() => {
    const load = process.getBuiltinModule
      ? process.getBuiltinModule('module').createRequire(${JSON.stringify(agentPath)})
      : require;
    process.env.TRACEFLOW_SERVICE = ${JSON.stringify(service)};
    process.env.TRACEFLOW_INGEST = ${JSON.stringify(ingest)};
    process.env.TRACEFLOW_TOKEN = ${JSON.stringify(token)};
    process.env.TRACEFLOW_PEERS = ${JSON.stringify(JSON.stringify(peers))};
    process.env.TRACEFLOW_CONTROL = ${JSON.stringify(JSON.stringify(control))};
    if (load.cache) delete load.cache[load.resolve(${JSON.stringify(agentPath)})];
    load(${JSON.stringify(agentPath)});
    return {
      pid: process.pid,
      installed: !!globalThis.__traceflowInstalled,
      attachState: globalThis.__traceflowAttachState || 'installed',
    };
  })()`;
  const value = await evaluate(inspector.url, expression);
  if (inspector.opened) {
    try { await evaluate(inspector.url, "(process.getBuiltinModule ? process.getBuiltinModule('inspector') : require('inspector')).close()"); } catch { /* closing the inspector drops the socket */ }
    openedByUs.delete(listener.pid);
  }
  if (!value || value.pid !== listener.pid || !value.installed) {
    return { ok: false, error: 'The inspector connected, but the agent did not install' };
  }
  if (value.attachState === 'restart-required') {
    return { ok: false, error: 'This service has an older Traceflow agent loaded. Restart it once, then attach again.' };
  }
  return { ok: true, pid: listener.pid };
}

async function ensureInspector(pid) {
  const existing = await inspectorFor(pid);
  if (existing) return { url: existing, opened: false };
  // SIGUSR1 toggles the inspector. If one is already open and the scan missed it,
  // the first signal closes it and the second opens it again.
  for (let signal = 0; signal < 2; signal += 1) {
    process.kill(pid, 'SIGUSR1');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(100);
      const url = await inspectorFor(pid);
      if (url) {
        openedByUs.add(pid);
        return { url, opened: true };
      }
    }
  }
  throw new Error('Could not open the Node inspector on that process');
}

async function freeStuckInspector(targetPid) {
  for (const pid of openedByUs) {
    if (pid === targetPid) continue;
    const url = await inspectorFor(pid);
    if (!url) {
      openedByUs.delete(pid);
      continue;
    }
    try { await evaluate(url, "(process.getBuiltinModule ? process.getBuiltinModule('inspector') : require('inspector')).close()"); } catch { /* already closed */ }
    openedByUs.delete(pid);
  }
}

async function inspectorFor(pid) {
  for (const entry of listenAddresses(pid)) {
    if (entry.port < 1024) continue;
    const hosts = loopback(entry.host) ? [normalizeHost(entry.host)] : ['127.0.0.1', ...localIps()];
    for (const host of hosts) {
      const list = await fetchJson(`http://${host}:${entry.port}/json/list`);
      if (!Array.isArray(list)) continue;
      for (const target of list) {
        if (!target.webSocketDebuggerUrl) continue;
        const url = new URL(target.webSocketDebuggerUrl);
        url.hostname = host.includes(':') ? `[${host}]` : host;
        try {
          const actual = await evaluate(url.toString(), 'process.pid');
          if (actual === pid) return url.toString();
        } catch {
          // wrong process or a normal HTTP port
        }
      }
    }
  }
  return null;
}

function listenAddresses(pid) {
  let output = '';
  try {
    output = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  const addresses = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith('n')) continue;
    const value = line.slice(1);
    const match = value.match(/:(\d+)$/);
    if (!match) continue;
    addresses.push({ host: value.slice(0, -match[1].length - 1), port: Number(match[1]) });
  }
  return addresses;
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('inspector timed out'));
    }, 4000);
    const finish = (err, value) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      if (err) reject(err);
      else resolve(value);
    };
    ws.addEventListener('message', async (event) => {
      const text = typeof event.data === 'string' ? event.data : await event.data.text();
      const message = JSON.parse(text);
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    ws.addEventListener('error', () => finish(new Error('inspector connection failed')));
    ws.addEventListener('open', async () => {
      try {
        await send('Runtime.enable');
        const result = await send('Runtime.evaluate', { expression, returnByValue: true });
        if (result.exceptionDetails) {
          finish(new Error(result.exceptionDetails.text || result.result?.description || 'inject failed'));
          return;
        }
        finish(null, result.result?.value);
      } catch (err) {
        finish(err);
      }
    });

    function send(method, params) {
      const id = ++nextId;
      return new Promise((resolveSend, rejectSend) => {
        pending.set(id, { resolve: resolveSend, reject: rejectSend });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }
  });
}

function signalDevTree(pid, signal) {
  const root = devRoot(pid);
  const group = groupId(root);
  const leader = group ? readProc(group) : null;
  const killGroup = group
    && group !== process.pid
    && group !== process.ppid
    && leader
    && leader.pid !== process.pid
    && !isShell(leader.command);
  try {
    if (killGroup) process.kill(-group, signal);
    else process.kill(root, signal);
  } catch {
    try { process.kill(root, signal); } catch { /* already gone */ }
  }
  return root;
}

function groupId(pid) {
  try {
    const output = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const group = Number(output);
    return Number.isInteger(group) && group > 1 ? group : null;
  } catch {
    return null;
  }
}

function devRoot(pid) {
  let current = pid;
  while (current > 1) {
    const info = readProc(current);
    if (!info) return current;
    if (info.ppid === process.pid) return current;
    const parent = readProc(info.ppid);
    if (!parent || isShell(parent.command) || !isNodeTool(parent.command)) return current;
    current = parent.pid;
  }
  return pid;
}

function readProc(pid) {
  try {
    const output = execFileSync('ps', ['-o', 'pid=,ppid=,command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, COLUMNS: '1000' },
    }).trim();
    const match = output.match(/^(\d+)\s+(\d+)\s+([\s\S]+)$/);
    if (!match) return null;
    return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
  } catch {
    return null;
  }
}

function commandOf(pid) {
  return readProc(pid)?.command || '';
}

function isShell(command) {
  return /(^|\/)(zsh|bash|fish|sh|login)(\s|$)/.test(command) || command.startsWith('-');
}

function isNodeTool(command) {
  return /node|yarn|nodemon|concurrently|fnm|ts-node/.test(command);
}

function loopback(host) {
  return host === '127.0.0.1' || host === '[::1]' || host === '::1' || host === 'localhost';
}

function normalizeHost(host) {
  return host.replace(/^\[|\]$/g, '');
}

function localIps() {
  const ips = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) ips.push(entry.address);
    }
  }
  return ips;
}

function fetchJson(url) {
  return fetch(url, { signal: AbortSignal.timeout(400) })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
