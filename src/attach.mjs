import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const openedByUs = new Set();
const DEFAULT_INSPECTOR_PORT = 9229;

// `table` (from processTable) and `cwdOf` are optional: passing them saves one `ps` per listener
// pid and repeated `lsof` working-directory lookups.
export function listenersByPort(ports, options = {}) {
  const wanted = new Set(ports.map((port) => Number(port)));
  const result = listeningProcesses(wanted, options);
  if (!result.ok) return { ok: false, byPort: new Map() };
  const byPort = new Map();
  for (const listener of result.listeners) {
    if (wanted.has(listener.port) && !byPort.has(listener.port)) byPort.set(listener.port, listener);
  }
  return { ok: true, byPort };
}

export function listeners(options = {}) {
  return listeningProcesses(null, options);
}

function listeningProcesses(wantedPorts = null, { table = null, cwdOf = processCwds } = {}) {
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
  const cwdByPid = cwdOf([...new Set(sockets.map((listener) => listener.pid))]);
  const processes = new Map();
  const found = sockets.map((listener) => {
    if (!processes.has(listener.pid)) {
      const command = table?.byPid.get(listener.pid)?.command ?? commandOf(listener.pid);
      processes.set(listener.pid, processDetails(command, cwdByPid.get(listener.pid)));
    }
    return { ...listener, ...processes.get(listener.pid) };
  });
  return { ok: true, listeners: found.sort((a, b) => a.port - b.port || a.pid - b.pid) };
}

function isNodeCommand(command) {
  return /(?:^|\/)node(?:\s|$)/.test(command) || command.includes('/node ');
}

function processDetails(command, cwd) {
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

export function processCwds(pids) {
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

export async function attachToListener({ port, ...options }) {
  const listener = listenerOn(port);
  if (!listener) return { ok: false, error: `Nothing is listening on ${port}` };
  if (!listener.node) return { ok: false, error: `pid ${listener.pid} on ${port} is not Node` };
  return attachToPid({ ...options, pid: listener.pid });
}

// The caller must have checked that pid is a Node process: SIGUSR1 ends most other programs.
export async function attachToPid({ pid, service, ingest, token, peers, control, agentPath }) {
  await freeStuckInspector(pid);
  const inspector = await ensureInspector(pid);
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
    openedByUs.delete(pid);
  }
  if (!value || value.pid !== pid || !value.installed) {
    return { ok: false, error: 'The inspector connected, but the agent did not install' };
  }
  if (value.attachState === 'restart-required') {
    return { ok: false, error: 'This service has an older Traceflow agent loaded. Restart it once, then attach again.' };
  }
  return { ok: true, pid };
}

// Process services: Node programs without a listening port, such as queue workers.
// They are found by command and working directory instead of by port.

// Package managers and watchers that start the real program as a child.
const LAUNCHER_NAMES = 'yarn|yarn-[\\d.]+|npm|npm-cli|npx|npx-cli|pnpm|pnpx|bun|bunx|nodemon|tsx|ts-node-dev|node-dev|fnm|corepack';
// Runners whose children are separate services, so a process tree is never grouped across them.
const MULTIPLEXER_NAMES = 'concurrently|turbo|nx|lerna|mprocs|overmind|foreman|honcho|pm2|tmux|screen';
const LAUNCHER_PROGRAM = new RegExp(`^(?:${LAUNCHER_NAMES})(?:\\.c?js|\\.mjs)?$`);
const LAUNCHER_PATH = new RegExp(`/node_modules/(?:${LAUNCHER_NAMES})/`);
const MULTIPLEXER_PROGRAM = new RegExp(`^(?:${MULTIPLEXER_NAMES})(?:\\.c?js|\\.mjs)?$`);
const MULTIPLEXER_PATH = new RegExp(`/node_modules/(?:${MULTIPLEXER_NAMES})/`);
const VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--env-file', '--title']);
const TOOLING = /^(?:claude|codex|gemini|aider|opencode|cursor-agent|tsserver|typingsInstaller|eslintServer|copilot[\w-]*|[\w-]*language-?server[\w-]*|[\w-]+-mcp|mcp-[\w-]+)(?:\.c?js|\.mjs)?$/i;
// Compilers and formatters in watch mode have no requests to trace.
const BUILD_TOOLING = /\/node_modules\/(?:typescript|tsc-alias|@babel\/cli|rollup|webpack|webpack-cli|prettier|eslint|@swc\/cli|tailwindcss|@tailwindcss\/cli)\//;
const RUNNER_WORDS = new Set(['node', 'nodejs', 'yarn', 'npm', 'pnpm', 'npx', 'pnpx', 'bun', 'bunx', 'run', 'run-script', 'exec', 'dlx', 'tsx', 'ts-node', 'nodemon']);

export function processTable() {
  try {
    const output = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,command='], {
      encoding: 'utf8',
      timeout: 1500,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseProcessTable(output);
  } catch {
    return null;
  }
}

export function parseProcessTable(output) {
  const byPid = new Map();
  for (const line of String(output || '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    byPid.set(pid, { pid, ppid: Number(match[2]), pgid: Number(match[3]), command: match[4].trim() });
  }
  const children = new Map();
  for (const proc of byPid.values()) {
    if (proc.ppid === proc.pid) continue;
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(proc.pid);
  }
  return { byPid, children };
}

export function subtree(table, rootPid) {
  if (!table?.byPid.has(rootPid)) return [];
  const pids = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    pids.push(pid);
    queue.push(...(table.children.get(pid) || []));
  }
  return pids;
}

function ancestors(table, pid) {
  const found = [];
  const seen = new Set([pid]);
  let current = table.byPid.get(pid);
  while (current && current.ppid > 0 && !seen.has(current.ppid)) {
    seen.add(current.ppid);
    found.push(current.ppid);
    current = table.byPid.get(current.ppid);
  }
  return found;
}

function splitCommand(command) {
  return (String(command || '').match(/"[^"]*"|'[^']*'|\S+/g) || [])
    .map((token) => token.replace(/^(["'])([\s\S]*)\1$/, '$2'))
    .filter(Boolean);
}

/** Tokens a running process must contain to count as this command, e.g. `yarn dev:queues` → ['dev:queues']. */
export function matchTokens(command) {
  const tokens = splitCommand(command);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token.startsWith('-') && !RUNNER_WORDS.has(path.basename(token).replace(/\.c?js$/, ''))) break;
    index += 1;
  }
  const required = tokens.slice(index).filter((token) => !token.startsWith('-'));
  if (required.length) return required;
  return tokens.filter((token) => !token.startsWith('-')).slice(-1).map((token) => path.basename(token));
}

function tokenMatches(actual, wanted) {
  if (actual === wanted) return true;
  const relative = wanted.replace(/^\.\//, '');
  return relative.length > 0 && actual.endsWith(`/${relative}`);
}

/** Whether a process command line contains every required token, each as whole words in order within itself. */
export function commandMatches(command, required) {
  if (!Array.isArray(required) || !required.length) return false;
  const actual = String(command || '').split(/\s+/).filter(Boolean);
  return required.every((token) => {
    const parts = String(token).split(/\s+/).filter(Boolean);
    if (!parts.length) return false;
    for (let start = 0; start + parts.length <= actual.length; start += 1) {
      if (tokenMatches(actual[start], parts[0]) && parts.slice(1).every((part, offset) => actual[start + offset + 1] === part)) return true;
    }
    return false;
  });
}

/** A runnable, readable form of a process command: `node /opt/homebrew/bin/yarn dev` → `yarn dev`. */
export function friendlyCommand(command) {
  const parts = String(command || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1 && /(?:^|\/)node$/.test(parts[0])) {
    const tool = path.basename(parts[1]).replace(/\.c?js$/, '');
    const name = /^yarn(?:-[\d.]+)?$/.test(tool) ? 'yarn'
      : tool === 'npm-cli' ? 'npm'
        : tool === 'npx-cli' ? 'npx'
          : tool === 'pnpm' ? 'pnpm'
            : null;
    return [name || 'node', ...parts.slice(name ? 2 : 1)].join(' ');
  }
  return parts.join(' ');
}

// Agents, editors and language servers run Node without a port too; only their program name is checked
// so a repository path that happens to contain such a word is still listed.
function isTooling(command) {
  const executable = String(command || '').split(/\s+/)[0] || '';
  const program = programOf(command);
  return TOOLING.test(path.basename(executable)) || TOOLING.test(path.basename(program)) || BUILD_TOOLING.test(program);
}

/**
 * The program a command runs: the executable, or for `node` the script after any flags, so
 * `node --require /x/node_modules/tsx/preflight.cjs src/queues.ts` runs `src/queues.ts`.
 */
function programOf(command) {
  const parts = String(command || '').split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (!/(?:^|\/)node$/.test(parts[0])) return parts[0];
  for (let index = 1; index < parts.length; index += 1) {
    if (!parts[index].startsWith('-')) return parts[index];
    if (VALUE_FLAGS.has(parts[index])) index += 1;
  }
  return parts[0];
}

function isLauncherProgram(command) {
  const program = programOf(command);
  return LAUNCHER_PROGRAM.test(path.basename(program)) || LAUNCHER_PATH.test(program);
}

function isMultiplexer(command) {
  const program = programOf(command);
  return MULTIPLEXER_PROGRAM.test(path.basename(program)) || MULTIPLEXER_PATH.test(program);
}

function isLauncher(command) {
  return isLauncherProgram(command) || isMultiplexer(command);
}

/** Node processes in a tree that run user code, excluding launchers and watchers. */
export function processTargets(table, rootPid) {
  const pids = subtree(table, rootPid);
  const nodes = new Set(pids.filter((pid) => isNodeCommand(table.byPid.get(pid).command)));
  return [...nodes].filter((pid) => !isLauncher(table.byPid.get(pid).command)).sort((a, b) => a - b);
}

function cwdWithin(actual, expected) {
  if (!expected) return true;
  if (!actual) return false;
  const real = canonical(actual);
  if (real === expected || real.startsWith(`${expected}${path.sep}`)) return true;
  // `yarn workspace x dev` runs from the repository root while the service lives in a package.
  return expected.startsWith(`${real}${path.sep}`) && repositoryDirectory(expected) === real;
}

function canonical(directory) {
  try { return fs.realpathSync(directory); } catch { return path.resolve(directory); }
}

/**
 * The topmost running process tree whose command contains `tokens` and whose working directory
 * matches `cwd`. Returns the root pid, every pid in the tree, and the Node pids to attach to.
 */
export function locateProcess(table, { tokens, cwd = null }, { exclude = new Set(), cwdOf = processCwds } = {}) {
  if (!table || !tokens?.length) return null;
  const blocked = new Set([process.pid, ...ancestors(table, process.pid), ...exclude]);
  const candidates = [...table.byPid.values()].filter((proc) => !blocked.has(proc.pid)
    && (isNodeCommand(proc.command) || isLauncherProgram(proc.command))
    && !isShell(proc.command)
    && !isMultiplexer(proc.command)
    && commandMatches(proc.command, tokens));
  if (!candidates.length) return null;
  const candidatePids = new Set(candidates.map((proc) => proc.pid));
  const tops = candidates.filter((proc) => !ancestors(table, proc.pid).some((pid) => candidatePids.has(pid)));
  const expected = cwd ? canonical(cwd) : null;
  const cwds = cwdOf(tops.map((proc) => proc.pid));
  const found = tops
    .filter((proc) => cwdWithin(cwds.get(proc.pid), expected))
    .sort((a, b) => a.pid - b.pid)[0];
  if (!found) return null;
  return {
    root: found.pid,
    command: found.command,
    cwd: cwds.get(found.pid) || null,
    pids: subtree(table, found.pid),
    targets: processTargets(table, found.pid),
  };
}

function groupRoot(table, pid) {
  let current = table.byPid.get(pid);
  while (current) {
    const parent = table.byPid.get(current.ppid);
    if (!parent || parent.pid <= 1 || parent.pid === process.pid) return current.pid;
    if (isShell(parent.command) || isMultiplexer(parent.command)) return current.pid;
    if (!isNodeCommand(parent.command) && !isLauncherProgram(parent.command)) return current.pid;
    current = parent;
  }
  return pid;
}

/**
 * Node process trees started from a terminal (or a runner such as concurrently) inside a git
 * repository that do not listen on any port. Editor helpers and agent tooling are left out.
 */
export function processGroups(table, { listenerPids = new Set(), exclude = new Set(), cwdOf = processCwds } = {}) {
  if (!table) return [];
  const own = new Set([process.pid, ...ancestors(table, process.pid)]);
  const roots = new Set();
  for (const proc of table.byPid.values()) {
    if (isNodeCommand(proc.command)) roots.add(groupRoot(table, proc.pid));
  }
  const kept = [];
  for (const rootPid of roots) {
    const proc = table.byPid.get(rootPid);
    const parent = table.byPid.get(proc?.ppid);
    if (!proc || !parent || own.has(rootPid)) continue;
    if (!isShell(parent.command) && !isMultiplexer(parent.command)) continue;
    if (isTooling(proc.command) || isMultiplexer(proc.command)) continue;
    const pids = subtree(table, rootPid);
    if (ancestors(table, rootPid).some((pid) => exclude.has(pid))) continue;
    if (pids.some((pid) => exclude.has(pid) || listenerPids.has(pid) || own.has(pid))) continue;
    const targets = processTargets(table, rootPid);
    if (targets.length) kept.push({ proc, pids, targets });
  }
  const cwds = cwdOf(kept.map((item) => item.proc.pid));
  const groups = [];
  for (const { proc, pids, targets } of kept) {
    const workingDirectory = cwds.get(proc.pid) || null;
    const repoPath = workingDirectory ? repositoryDirectory(workingDirectory) : null;
    if (!repoPath) continue;
    const command = friendlyCommand(proc.command);
    groups.push({
      kind: 'process',
      pid: proc.pid,
      command,
      match: matchTokens(command),
      workingDirectory,
      repo: path.basename(repoPath),
      repoPath,
      pids,
      targets,
      processes: targets.length,
      attachable: true,
    });
  }
  return groups.sort((a, b) => a.pid - b.pid);
}

/** Signal a process tree without touching Traceflow or the shell that started it. */
export function signalProcessTree(rootPid, signal, table = processTable()) {
  const protectedPids = new Set([process.pid, process.ppid, ...(table ? ancestors(table, process.pid) : [])]);
  if (protectedPids.has(rootPid)) return [];
  const pids = table ? subtree(table, rootPid) : [rootPid];
  const root = table?.byPid.get(rootPid);
  if (root && root.pgid === rootPid) {
    try { process.kill(-rootPid, signal); } catch { /* group already gone */ }
  }
  for (const pid of pids.length ? pids : [rootPid]) {
    if (protectedPids.has(pid)) continue;
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
  return pids;
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
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
  const holder = listenerOn(DEFAULT_INSPECTOR_PORT);
  if (holder && holder.pid !== pid) {
    throw new Error(`Could not open the Node inspector: port ${DEFAULT_INSPECTOR_PORT} is already used by pid ${holder.pid}. `
      + 'Start this service from Traceflow, or run it with NODE_OPTIONS=--inspect-port=0, then attach again.');
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
