import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  commandMatches,
  friendlyCommand,
  locateProcess,
  matchTokens,
  parseProcessTable,
  pidAlive,
  processGroups,
  processTargets,
  workingDirectoryForCommand,
} from './attach.mjs';
import { loadConfig, nodeBinForProject, startServer } from './server.mjs';
import { traceToMermaid, validDiagramName } from './diagrams.mjs';
import readline from 'node:readline';

const ignore = ['/health', '/healthcheck', '/ready', '/metrics', '/favicon.ico'];

test('configuration is optional when discovering local services', () => {
  const config = loadConfig({ cwd: '/traceflow/no-config-here', env: {} });
  assert.equal(config.port, 9477);
  assert.deepEqual(config.services, []);
});

test('a remembered process service is not restored next to the same configured one', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-process-memory-'));
  fs.writeFileSync(path.join(directory, 'traceflow.services.json'), JSON.stringify({
    services: [
      { name: 'dev:queues', kind: 'process', command: 'yarn dev:queues', cwd: directory, match: ['dev:queues'], discovered: true, sticky: true },
      { name: 'dev:mailer', kind: 'process', command: 'yarn dev:mailer', cwd: directory, match: ['dev:mailer'], discovered: true, sticky: true },
    ],
  }));
  const app = await startServer({
    port: 0,
    config: { baseDir: directory, include: [], ignore, services: [{ name: 'queues', command: 'yarn dev:queues' }] },
  });
  try {
    const state = await api(app, '/api/state');
    assert.deepEqual(state.services.map((service) => service.name).sort(), ['dev:mailer', 'queues']);
    assert.equal(state.services.every((service) => service.kind === 'process' && service.port === null), true);
  } finally {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('attached services are restored from the local memory file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-services-'));
  const remembered = path.join(directory, 'traceflow.services.json');
  fs.writeFileSync(remembered, JSON.stringify({
    services: [
      { name: 'localhost-4101', port: 4101, command: 'node app.js', cwd: '/tmp/app', repo: 'app', discovered: true },
      { name: 'api', port: 4102, command: 'node api.js', repo: 'api', discovered: true },
    ],
  }));
  const app = await startServer({
    port: 0,
    config: {
      baseDir: directory,
      include: [],
      ignore,
      services: [{ name: 'api', port: 4102, command: 'node configured.js' }],
    },
  });
  try {
    const state = await api(app, '/api/state');
    const names = state.services.map((service) => service.name).sort();
    assert.deepEqual(names, ['api', 'localhost-4101']);
    assert.equal(state.services.find((service) => service.name === 'api').command, 'node configured.js');
    assert.equal(state.services.find((service) => service.name === 'localhost-4101').discovered, true);
    assert.equal(app.config.services.find((service) => service.name === 'localhost-4101').cwd, '/tmp/app');
  } finally {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the agent does not keep a short-lived process alive', async () => {
  const app = await startServer({ port: 0, config: { include: [], ignore, services: [] } });
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], {
    env: {
      ...process.env,
      TRACEFLOW_SERVICE: 'exit-check',
      TRACEFLOW_INGEST: app.url,
      TRACEFLOW_TOKEN: app.token,
      TRACEFLOW_CONTROL: '{}',
      NODE_OPTIONS: `--require=${path.resolve('src/agent/preload.cjs')}`,
    },
    stdio: 'ignore',
  });
  try {
    const code = await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(2000).then(() => 'timeout'),
    ]);
    assert.equal(code, 0);
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
    await app.close();
  }
});

test('start prefers the Node version pinned by the project', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-fnm-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-node-project-'));
  const bin = path.join(home, '.local/share/fnm/node-versions/v24.16.0/installation/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'node'), '');
  fs.writeFileSync(path.join(project, '.nvmrc'), '24.16.0\n');
  try {
    assert.equal(nodeBinForProject(project, { homedir: home, fnmDir: '' }), bin);
    fs.writeFileSync(path.join(project, '.nvmrc'), '22\n');
    const older = path.join(home, '.local/share/fnm/node-versions/v22.13.0/installation/bin');
    const newer = path.join(home, '.local/share/fnm/node-versions/v22.22.2/installation/bin');
    fs.mkdirSync(older, { recursive: true });
    fs.mkdirSync(newer, { recursive: true });
    fs.writeFileSync(path.join(older, 'node'), '');
    fs.writeFileSync(path.join(newer, 'node'), '');
    assert.equal(nodeBinForProject(project, { homedir: home, fnmDir: '' }), newer);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a remembered command recovers the repository working directory', () => {
  assert.equal(workingDirectoryForCommand(`node ${path.resolve('src/server.mjs')}`), path.resolve('.'));
});

test('stop then start relaunches from the remembered working directory', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-restart-'));
  const marker = path.join(directory, 'started.txt');
  const port = 19997;
  const occupant = spawnBare(port);
  const app = await startServer({
    port: 0,
    config: {
      baseDir: directory,
      include: [],
      ignore,
      services: [{
        name: 'svc-restart',
        port,
        cwd: directory,
        command: `node -e "require('fs').writeFileSync('started.txt','ok'); require('http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1')"`,
      }],
    },
  });
  try {
    await waitFor(() => postJson(port, '/health', {}).then((result) => result.status === 200 ? result : null).catch(() => null));
    const blocked = await app.startService('svc-restart');
    assert.equal(blocked.ok, false);
    const stopped = await app.stopService('svc-restart');
    assert.equal(stopped.ok, true, stopped.error);
    const started = await app.startService('svc-restart');
    assert.equal(started.ok, true, started.error);
    await waitFor(() => (fs.existsSync(marker) ? true : null));
    assert.equal(fs.readFileSync(marker, 'utf8'), 'ok');
  } finally {
    try { occupant.kill('SIGKILL'); } catch { /* stopped by the API */ }
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('services without configured colours receive distinct readable colours', async () => {
  const app = await startServer({
    port: 0,
    config: {
      include: [],
      ignore: [],
      services: [
        { name: 'web', port: 19301, command: 'node web.js' },
        { name: 'api', port: 19302, command: 'node api.js' },
        { name: 'worker', port: 19303, command: 'node worker.js' },
      ],
    },
  });
  try {
    const state = await api(app, '/api/state');
    const colours = state.services.map((service) => service.color);
    assert.equal(new Set(colours).size, colours.length);
    assert.ok(colours.every((colour) => /^#[0-9a-f]{6}$/i.test(colour)));
  } finally {
    await app.close();
  }
});

test('npm-style symlink starts the CLI', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-cli-'));
  const executable = path.join(directory, 'traceflow');
  const config = path.join(directory, 'traceflow.config.json');
  fs.symlinkSync(path.resolve('src/server.mjs'), executable);
  fs.writeFileSync(config, JSON.stringify({ port: 19993, services: [] }));
  const child = spawn(executable, [], {
    cwd: directory,
    env: { ...process.env, TRACEFLOW_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await waitFor(() => output.includes('Traceflow at http://127.0.0.1:19993'));
    const response = await fetch('http://127.0.0.1:19993/api/state');
    assert.equal(response.status, 200);
  } finally {
    try { child.kill('SIGTERM'); } catch { /* already stopped */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('live request becomes one three-hop trace', async () => {
  const app = await boot(trioConfig(0));
  try {
    await waitHealth([9201, 9202, 9203]);
    const response = await postJson(9201, '/request', { message: 'hello', count: 2 }, { authorization: 'Bearer test-secret' });
    assert.equal(response.status, 200);
    assert.equal(response.body.result.value, 'value_hello');
    assert.equal(response.body.result.apiKey, 'demo-key');
    const trace = await waitFor(async () => {
      const state = await api(app, '/api/state');
      const found = state.traces.find((item) => item.spans.some((span) => span.path.startsWith('/request')));
      if (!found) return null;
      const paths = found.spans.map((span) => span.path.split('?')[0]).sort();
      if (paths.length < 3) return null;
      if (found.spans.some((span) => !span.endedAt)) return null;
      return found;
    });
    const byPath = Object.fromEntries(trace.spans.map((span) => [span.path, span]));
    assert.equal(byPath['/request'].from, 'browser');
    assert.equal(byPath['/request'].to, 'frontend');
    assert.equal(byPath['/process'].from, 'frontend');
    assert.equal(byPath['/process'].to, 'api');
    assert.equal(byPath['/lookup'].from, 'api');
    assert.equal(byPath['/lookup'].to, 'worker');
    assert.match(byPath['/request'].requestBody, /hello/);
    assert.equal(byPath['/request'].requestHeaders.authorization, '[redacted]');
    assert.match(JSON.stringify(byPath['/request'].responseHeaders), /application\/json/);
    assert.match(byPath['/lookup'].requestBody, /hello/);
    assert.match(byPath['/request'].responseBody, /\[redacted\]/);
    assert.doesNotMatch(byPath['/request'].responseBody, /demo-key/);
    assert.equal(byPath['/process'].status, 201);
    const state = await api(app, '/api/state');
    assert.equal(state.traces.some((item) => item.spans.some((span) => span.path.startsWith('/health'))), false);

    await postJson(9203, '/node-origin', {}, { 'user-agent': 'node' });
    const nodeTrace = await waitFor(async () => {
      const next = await api(app, '/api/state');
      return next.traces.find((item) => item.spans.some((span) => span.path === '/node-origin')) || null;
    });
    assert.equal(nodeTrace.spans[0].from, 'node client');

    await postJson(9203, '/inspector/device', {});
    await sleep(150);
    const filtered = await api(app, '/api/state');
    assert.equal(filtered.traces.some((item) => item.spans.some((span) => span.path.startsWith('/inspector/'))), false);

    await api(app, '/api/control', { method: 'POST', body: { captureDebug: true } });
    await sleep(150);
    await postJson(9203, '/inspector/device', {});
    const debugTrace = await waitFor(async () => {
      const next = await api(app, '/api/state');
      return next.traces.find((item) => item.spans.some((span) => span.path.startsWith('/inspector/device'))) || null;
    });
    assert.ok(debugTrace);
  } finally {
    await app.close();
  }
});

test('demo sample request uses the same-origin API and captures the flow', async () => {
  const config = trioConfig(0);
  const app = await startServer({ port: 0, config, demo: true });
  for (const service of config.services) app.startService(service.name);
  try {
    await waitHealth([9201, 9202, 9203]);
    const state = await api(app, '/api/state');
    assert.equal(state.sampleUrl, '/api/sample');
    const sample = await api(app, state.sampleUrl, { method: 'POST', body: {} });
    assert.equal(sample.ok, true);
    assert.equal(sample.status, 200);
    const trace = await waitFor(async () => {
      const next = await api(app, '/api/state');
      const found = next.traces.find((item) => item.spans.some((span) => span.path === '/request'));
      return found?.spans.length === 3 ? found : null;
    });
    assert.deepEqual(trace.spans.map((span) => span.path).sort(), ['/lookup', '/process', '/request']);
  } finally {
    await app.close();
  }
});

test('local control rejects untrusted origins and unauthenticated mutations', async () => {
  const app = await startServer({
    port: 0,
    config: { include: [], ignore, services: [] },
  });
  try {
    const page = await fetch(app.url);
    const html = await page.text();
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.doesNotMatch(html, /__TRACEFLOW_TOKEN__/);

    const noToken = await fetch(`${app.url}/api/clear`, { method: 'POST' });
    assert.equal(noToken.status, 403);

    const foreignOrigin = await fetch(`${app.url}/api/state`, { headers: { origin: 'https://attacker.example' } });
    assert.equal(foreignOrigin.status, 403);

    const allowed = await fetch(`${app.url}/api/clear`, {
      method: 'POST',
      headers: { 'x-traceflow-token': app.token },
    });
    assert.equal(allowed.status, 200);
  } finally {
    await app.close();
  }
});

test('step mode holds each hop until Step', async () => {
  const app = await boot(trioConfig(0));
  try {
    await waitHealth([9201, 9202, 9203]);
    await api(app, '/api/control', { method: 'POST', body: { mode: 'step', pauseOnResponse: true } });
    await sleep(400);
    let settled = false;
    const pending = postJson(9201, '/request', { message: 'hello' }).then((result) => {
      settled = true;
      return result;
    });
    const firstGate = await waitFor(async () => {
      const state = await api(app, '/api/state');
      return state.gates[0] || null;
    });
    assert.match(firstGate.label, /request/);
    await sleep(150);
    assert.equal(settled, false);

    for (let i = 0; i < 16 && !settled; i += 1) {
      const state = await api(app, '/api/state');
      if (!state.gates.length) {
        await sleep(40);
        continue;
      }
      await api(app, '/api/step', { method: 'POST', body: {} });
      await sleep(40);
    }
    const result = await pending;
    assert.equal(result.body.result.id, 'job_demo');
    assert.equal(settled, true);
  } finally {
    await app.close();
  }
});

test('existing node processes are only connected after an explicit attach', async () => {
  const app = await startServer({
    port: 0,
    config: {
      include: [],
      ignore,
      services: [
        { name: 'service-a', cwd: '.', port: 9311, command: 'echo service-a' },
        { name: 'service-b', cwd: '.', port: 9312, command: 'echo service-b' },
      ],
    },
  });
  const children = [spawnBare(9311, { esm: true }), spawnBare(9312)];
  try {
    await waitFor(async () => {
      try {
        await postJson(9311, '/alpha', { message: 'hello' });
        await postJson(9312, '/beta', { key: 'demo' });
        return true;
      } catch {
        return false;
      }
    });
    const unconnected = await waitFor(async () => {
      const state = await api(app, '/api/state');
      return state.services.every((service) => service.status === 'running' && !service.agent) ? state : null;
    });
    assert.equal(unconnected.services.every((service) => !service.agent), true);
    assert.equal(unconnected.services.every((service) => !service.attached && !service.problem), true);
    assert.equal(unconnected.services.every((service) => service.repo === 'traceflow'), true);
    const blocked = await api(app, '/api/services/service-a/start', { method: 'POST', body: {} });
    assert.equal(blocked.ok, false);
    const attachedA = await api(app, '/api/services/service-a/attach', { method: 'POST', body: {} });
    const attachedB = await api(app, '/api/services/service-b/attach', { method: 'POST', body: {} });
    assert.equal(attachedA.ok, true, attachedA.error);
    assert.equal(attachedB.ok, true, attachedB.error);
    const connected = await waitFor(async () => {
      const state = await api(app, '/api/state');
      return state.services.every((service) => service.agent) ? state : null;
    }, 15000);
    assert.equal(connected.services.every((service) => service.attached && !service.problem), true);
    const page = await fetch('http://127.0.0.1:9311/page', {
      headers: { accept: 'text/html', 'accept-encoding': 'br' },
    }).then((response) => response.text());
    assert.match(page, /<script src="\/__traceflow\/browser\.js"><\/script>/);
    assert.match(page, /encoding: identity/);
    const browserScript = await fetch('http://127.0.0.1:9311/__traceflow/browser.js');
    assert.equal(browserScript.status, 200);
    assert.match(await browserScript.text(), /__traceflowBrowserInstalled/);
    const browserTraceId = 'browser-external-test';
    const browserSpanId = 'browser-external-span';
    for (const event of [
      { phase: 'start', at: Date.now(), requestBody: '{"booking":true}' },
      { phase: 'end', at: Date.now() + 12, status: 202, responseBody: '{"accepted":true}' },
    ]) {
      const response = await fetch('http://127.0.0.1:9311/__traceflow/browser-event', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:9311' },
        body: JSON.stringify({
          type: 'span',
          traceId: browserTraceId,
          spanId: browserSpanId,
          parentId: null,
          from: 'spoofed',
          to: 'cdn.example.test',
          method: 'POST',
          path: '/api/orders/guest-checkout',
          ...event,
        }),
      });
      assert.equal(response.status, 204);
    }
    const browserTrace = await waitFor(async () => {
      const snapshot = await api(app, '/api/state');
      return snapshot.traces.find((item) => item.id === browserTraceId) || null;
    });
    assert.equal(browserTrace.spans[0].from, 'browser');
    assert.equal(browserTrace.spans[0].to, 'cdn.example.test');
    assert.equal(browserTrace.spans[0].status, 202);
    await postJson(9311, '/alpha', { message: 'hello' });
    const trace = await waitFor(async () => {
      const snapshot = await api(app, '/api/state');
      return snapshot.traces.find((item) => item.spans.some((span) => span.path === '/alpha' && span.to === 'service-a' && span.requestBody.includes('hello'))) || null;
    });
    assert.equal(trace.spans[0].from, 'browser');
    const log = await waitFor(async () => {
      const snapshot = await api(app, '/api/state');
      return snapshot.logEntries.find((entry) => entry.service === 'service-a' && entry.line.includes('handled /alpha')) || null;
    });
    assert.match(log.line, /handled \/alpha/);
  } finally {
    await api(app, '/api/services/service-a/stop', { method: 'POST', body: {} }).catch(() => {});
    await api(app, '/api/services/service-b/stop', { method: 'POST', body: {} }).catch(() => {});
    for (const child of children) {
      try { process.kill(child.pid, 'SIGTERM'); } catch { /* stopped via the API */ }
    }
    await app.close();
  }
});

test('manual port scan adds an opted-in Node listener', async () => {
  const app = await startServer({
    port: 0,
    config: { include: [], ignore, services: [] },
  });
  const child = spawnBare(9314);
  try {
    await waitFor(() => postJson(9314, '/health', {}).then((result) => result.status === 200 ? result : null).catch(() => null));
    const scan = await api(app, '/api/discovery/scan', { method: 'POST', body: {} });
    assert.equal(scan.listeners.every((item) => item.node && item.attachable), true);
    const listener = scan.listeners.find((item) => item.port === 9314);
    assert.equal(listener?.attachable, true);
    assert.equal(listener?.repo, 'traceflow');
    assert.equal(listener?.repoPath, path.resolve('.'));

    const attached = await api(app, '/api/discovery/attach', { method: 'POST', body: { port: 9314 } });
    assert.equal(attached.ok, true, attached.error);
    const state = await waitFor(async () => {
      const snapshot = await api(app, '/api/state');
      return snapshot.services.find((service) => service.port === 9314 && service.agent) || null;
    }, 8000);
    assert.equal(state.name, 'localhost-9314');
  } finally {
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* already stopped */ }
    await app.close();
  }
});

test('a live service card keeps its running light when attach cannot connect', async () => {
  const port = 9316;
  const child = spawnNonNode(port);
  const app = await startServer({
    port: 0,
    config: {
      include: [],
      ignore,
      services: [{ name: 'svc-order', cwd: '.', port, command: 'echo svc-order' }],
    },
  });
  try {
    await waitFor(() => fetch(`http://127.0.0.1:${port}/`).then((response) => response.ok).catch(() => false));
    const running = await waitFor(async () => {
      const state = await api(app, '/api/state');
      return state.services[0]?.status === 'running' ? state.services[0] : null;
    });
    assert.equal(running.problem, '');
    assert.equal(running.agent, false);
    const attached = await api(app, '/api/services/svc-order/attach', { method: 'POST', body: {} });
    assert.equal(attached.ok, false);
    const state = await api(app, '/api/state');
    assert.equal(state.services[0].status, 'running');
    assert.equal(state.services[0].problem, '');
    assert.match(state.services[0].message, /not Node/);
    assert.equal(state.services[0].agent, false);
  } finally {
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* already stopped */ }
    await app.close();
  }
});

test('an attached agent reconnects after the Traceflow collector restarts', async () => {
  const config = {
    include: [],
    ignore,
    services: [{ name: 'reconnect-service', cwd: '.', port: 9315, command: 'echo reconnect-service' }],
  };
  const child = spawnBare(9315);
  let first;
  let second;
  try {
    await waitFor(() => postJson(9315, '/health', {}).then(() => true).catch(() => false));
    first = await startServer({ port: 0, config });
    await waitFor(async () => (await api(first, '/api/state')).services[0]?.status === 'running');
    const initialAttach = await api(first, '/api/services/reconnect-service/attach', { method: 'POST', body: {} });
    assert.equal(initialAttach.ok, true, initialAttach.error);
    await waitFor(async () => (await api(first, '/api/state')).services[0]?.agent, 15000);
    await first.close();
    first = null;

    second = await startServer({ port: 0, config });
    await waitFor(async () => (await api(second, '/api/state')).services[0]?.status === 'running');
    const reattach = await api(second, '/api/services/reconnect-service/attach', { method: 'POST', body: {} });
    assert.equal(reattach.ok, true, reattach.error);
    await waitFor(async () => (await api(second, '/api/state')).services[0]?.agent, 15000);
  } finally {
    if (first) await first.close();
    if (second) await second.close();
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
});

test('an attached service is reattached when the same project restarts', async () => {
  const port = 9331;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-sticky-'));
  const app = await startServer({
    port: 0,
    config: {
      baseDir: directory,
      include: [],
      ignore,
      services: [{ name: 'sticky-service', cwd: directory, port, command: 'echo sticky' }],
    },
  });
  const children = [];
  const start = () => {
    const child = spawnBare(port, { cwd: directory });
    children.push(child);
    return child;
  };
  try {
    start();
    await waitFor(() => postJson(port, '/health', {}).then(() => true).catch(() => false));
    await waitFor(async () => (await api(app, '/api/state')).services[0]?.status === 'running');
    const attached = await api(app, '/api/services/sticky-service/attach', { method: 'POST', body: {} });
    assert.equal(attached.ok, true, attached.error);
    const first = await waitFor(async () => {
      const service = (await api(app, '/api/state')).services[0];
      return service?.agent ? service : null;
    }, 15000);
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'traceflow.services.json'), 'utf8'));
    assert.equal(saved.autoReattach, true);
    assert.equal(saved.sticky.some((item) => item.name === 'sticky-service'), true);

    process.kill(children.at(-1).pid, 'SIGKILL');
    await waitDown(port);
    start();
    await waitFor(() => postJson(port, '/health', {}).then(() => true).catch(() => false));
    const restarted = await waitFor(async () => {
      await postJson(port, '/restarted', {}).catch(() => {});
      const snapshot = await api(app, '/api/state');
      const service = snapshot.services[0];
      const log = snapshot.logEntries.some((entry) => entry.service === 'sticky-service' && entry.line.includes('handled /restarted'));
      return service?.pid && service.pid !== first.pid && service.agent && log ? service : null;
    }, 15000);
    const disabled = await api(app, '/api/control', { method: 'POST', body: { autoReattach: false } });
    assert.equal(disabled.autoReattach, false);
    const releasedPid = restarted.pid;
    process.kill(children.at(-1).pid, 'SIGKILL');
    await waitDown(port);
    start();
    await waitFor(() => postJson(port, '/left-alone', {}).then(() => true).catch(() => false));
    const leftAlone = await waitFor(async () => {
      const service = (await api(app, '/api/state')).services[0];
      return service?.pid && service.pid !== releasedPid && service.status === 'running' && !service.agent ? service : null;
    }, 15000);
    assert.equal(leftAlone.attached, false);
    await sleep(300);
    const quiet = await api(app, '/api/state');
    assert.equal(quiet.logEntries.some((entry) => entry.line.includes('handled /left-alone')), false);
  } finally {
    for (const child of children) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already stopped */ }
    }
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a different project on the same port is not reattached', async () => {
  const port = 9332;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-home-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-other-'));
  const app = await startServer({
    port: 0,
    config: {
      baseDir: home,
      include: [],
      ignore,
      services: [{ name: 'sticky-home', cwd: home, port, command: 'echo home' }],
    },
  });
  const children = [];
  const start = (cwd) => {
    const child = spawnBare(port, { cwd });
    children.push(child);
    return child;
  };
  try {
    start(home);
    await waitFor(() => postJson(port, '/health', {}).then(() => true).catch(() => false));
    await waitFor(async () => (await api(app, '/api/state')).services[0]?.status === 'running');
    const attached = await api(app, '/api/services/sticky-home/attach', { method: 'POST', body: {} });
    assert.equal(attached.ok, true, attached.error);
    const first = await waitFor(async () => {
      const service = (await api(app, '/api/state')).services[0];
      return service?.agent ? service : null;
    }, 15000);

    process.kill(children.at(-1).pid, 'SIGKILL');
    await waitDown(port);
    start(other);
    await waitFor(() => postJson(port, '/other', {}).then(() => true).catch(() => false));
    const blocked = await waitFor(async () => {
      const service = (await api(app, '/api/state')).services[0];
      return service?.pid && service.pid !== first.pid && service.status === 'running' && !service.agent && /different project/.test(service.message) ? service : null;
    }, 15000);
    assert.equal(blocked.attached, false);
    await sleep(300);
    const quiet = await api(app, '/api/state');
    assert.equal(quiet.logEntries.some((entry) => entry.line.includes('handled /other')), false);
  } finally {
    for (const child of children) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already stopped */ }
    }
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('stop does not complete until the listener has left the port', async () => {
  const child = spawnBare(9315);
  await waitFor(() => postJson(9315, '/health', {}).then((result) => result.status === 200 ? result : null).catch(() => null));
  const app = await startServer({
    port: 0,
    config: {
      include: [],
      ignore,
      services: [{ name: 'svc-stop', cwd: '.', port: 9315, command: 'echo stop' }],
    },
  });
  try {
    const stopped = await api(app, '/api/services/svc-stop/stop', { method: 'POST', body: {} });
    assert.equal(stopped.ok, true, stopped.error);
    await assert.rejects(postJson(9315, '/health', {}));
    const state = await api(app, '/api/state');
    assert.equal(state.services[0].status, 'stopped');
    assert.equal(state.services[0].attached, false);
    assert.equal(state.services[0].problem, '');
  } finally {
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* already stopped */ }
    await app.close();
  }
});

test('service state reports process failures', async () => {
  const app = await startServer({
    port: 0,
    config: {
      include: [],
      ignore,
      services: [{ name: 'broken-service', cwd: '.', port: 19993, args: ['-e', 'process.exit(2)'] }],
    },
  });
  try {
    app.startService('broken-service');
    const service = await waitFor(async () => {
      const state = await api(app, '/api/state');
      return state.services[0]?.status === 'exited' ? state.services[0] : null;
    });
    assert.match(service.problem, /code 2/);
    assert.equal(service.repo, 'traceflow');
    assert.equal(service.attached, false);
  } finally {
    await app.close();
  }
});

test('traces keep a bounded span list and drop stale ones', async () => {
  const app = await startServer({
    port: 0,
    limits: { maxSpans: 5, incompleteTtlMs: 200, traceTtlMs: 200 },
    config: {
      include: [],
      ignore,
      services: [{ name: 'svc', cwd: '.', port: 19991, command: 'echo svc' }],
    },
  });
  try {
    const traceId = 'cap-trace';
    for (let i = 0; i < 8; i += 1) {
      await api(app, '/ingest', {
        method: 'POST',
        body: {
          type: 'span',
          phase: 'start',
          traceId,
          spanId: `s${i}`,
          from: 'a',
          to: 'b',
          method: 'GET',
          path: '/x',
          at: Date.now(),
        },
      });
    }
    const capped = await api(app, '/api/state');
    const trace = capped.traces.find((item) => item.id === traceId);
    assert.equal(trace.spans.length, 5);
    assert.equal(trace.spansTruncated, true);

    await api(app, '/ingest', {
      method: 'POST',
      body: {
        type: 'batch',
        events: Array.from({ length: 201 }, (_, i) => ({
          type: 'span',
          phase: 'start',
          traceId: `retained-${i}`,
          spanId: `retained-span-${i}`,
          from: 'a',
          to: 'b',
          method: 'GET',
          path: `/retained/${i}`,
          at: Date.now() + i,
        })),
      },
    });
    const retained = await api(app, '/api/state');
    assert.equal(retained.traces.length, 200);
    assert.equal(retained.traces.some((item) => item.id === 'retained-0'), false);
    assert.equal(retained.traces.some((item) => item.id === 'retained-200'), true);

    await api(app, '/ingest', {
      method: 'POST',
      body: { type: 'batch', events: [{ type: 'log', service: 'svc', line: 'batched-one' }, { type: 'log', service: 'svc', line: 'batched-two' }] },
    });
    const logged = await api(app, '/api/state');
    assert.ok(logged.logEntries.some((entry) => entry.line === 'batched-one'));
    assert.ok(logged.logEntries.some((entry) => entry.line === 'batched-two'));

    await api(app, '/api/clear-logs', { method: 'POST', body: {} });
    const clearedLogs = await api(app, '/api/state');
    assert.equal(clearedLogs.logEntries.length, 0);

    await sleep(250);
    await api(app, '/ingest', { method: 'POST', body: { type: 'hello', service: 'svc' } });
    const expired = await api(app, '/api/state');
    assert.equal(expired.traces.some((item) => item.id === traceId), false);

    const response = await fetch(`${app.url}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-traceflow-token': app.token },
      body: `{"pad":"${'x'.repeat(MAX_JSON_PROBE)}"}`,
    });
    assert.equal(response.status, 413);
  } finally {
    await app.close();
  }
});

test('pinned traces survive expiry and logs keep their trace', async () => {
  const app = await startServer({
    port: 0,
    limits: { maxTraces: 3, incompleteTtlMs: 200, traceTtlMs: 200 },
    config: {
      include: [],
      ignore,
      services: [{ name: 'svc', cwd: '.', port: 19994, command: 'echo svc' }],
    },
  });
  try {
    const span = (traceId, at) => ({
      type: 'span',
      phase: 'end',
      traceId,
      spanId: `${traceId}-span`,
      from: 'a',
      to: 'svc',
      method: 'GET',
      path: `/${traceId}`,
      status: 200,
      at,
    });
    const started = Date.now();
    await api(app, '/ingest', { method: 'POST', body: span('pin-me', started) });
    const pinned = await api(app, '/api/traces/pin-me/pin', { method: 'POST', body: { pinned: true } });
    assert.equal(pinned.pinned, true);
    for (let i = 0; i < 4; i += 1) {
      await api(app, '/ingest', { method: 'POST', body: span(`extra-${i}`, started + i + 1) });
    }
    const kept = await api(app, '/api/state');
    assert.equal(kept.traces.length, 3);
    assert.equal(kept.traces.find((trace) => trace.id === 'pin-me')?.pinned, true);

    await sleep(250);
    await api(app, '/ingest', { method: 'POST', body: { type: 'hello', service: 'svc' } });
    const still = await api(app, '/api/state');
    assert.equal(still.traces.some((trace) => trace.id === 'pin-me'), true);

    await api(app, '/api/traces/pin-me/pin', { method: 'POST', body: { pinned: false } });
    await sleep(250);
    await api(app, '/ingest', { method: 'POST', body: { type: 'hello', service: 'svc' } });
    const expired = await api(app, '/api/state');
    assert.equal(expired.traces.some((trace) => trace.id === 'pin-me'), false);

    const missing = await fetch(`${app.url}/api/traces/missing/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-traceflow-token': app.token },
      body: '{"pinned":true}',
    });
    assert.equal(missing.status, 404);

    await api(app, '/ingest', {
      method: 'POST',
      body: {
        type: 'log',
        service: 'svc',
        line: 'handled /alpha',
        at: started,
        traceId: 'pin-me',
        spanId: 'pin-me-span',
      },
    });
    const logged = await api(app, '/api/state');
    const entry = logged.logEntries.find((item) => item.line === 'handled /alpha');
    assert.equal(entry.traceId, 'pin-me');
    assert.equal(entry.spanId, 'pin-me-span');
    assert.equal(entry.at, started);
  } finally {
    await app.close();
  }
});

test('sse sends a snapshot then span deltas', async () => {
  const app = await startServer({
    port: 0,
    config: {
      include: [],
      ignore,
      services: [{ name: 'svc', cwd: '.', port: 19992, command: 'echo svc' }],
    },
  });
  const ac = new AbortController();
  try {
    const response = await fetch(`${app.url}/events`, {
      signal: ac.signal,
      headers: { 'x-traceflow-token': app.token },
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const nextEvent = async () => {
      const start = Date.now();
      while (!buf.includes('\n\n')) {
        if (Date.now() - start > 2000) throw new Error('sse timed out');
        const { value, done } = await reader.read();
        if (done) throw new Error('sse closed');
        buf += decoder.decode(value, { stream: true });
      }
      const split = buf.indexOf('\n\n');
      const raw = buf.slice(0, split);
      buf = buf.slice(split + 2);
      const event = (raw.split('\n').find((line) => line.startsWith('event:')) || '').slice(6).trim();
      const data = raw.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      return { event, data: data ? JSON.parse(data) : null };
    };
    const snapshot = await nextEvent();
    assert.equal(snapshot.event, 'snapshot');
    assert.ok(Array.isArray(snapshot.data.traces));
    const pending = nextEvent();
    await api(app, '/ingest', {
      method: 'POST',
      body: {
        type: 'span',
        phase: 'start',
        traceId: 'sse-trace',
        spanId: 'sse-span',
        from: 'browser',
        to: 'svc',
        method: 'GET',
        path: '/sse',
        at: Date.now(),
      },
    });
    let delta = await pending;
    while (delta.event === 'delta' && !delta.data.spans) delta = await nextEvent();
    assert.equal(delta.event, 'delta');
    assert.equal(delta.data.traces, undefined);
    assert.equal(delta.data.logEntries, undefined);
    assert.equal(delta.data.spans[0].span.path, '/sse');
  } finally {
    ac.abort();
    await app.close();
  }
});

test('large bodies stay intact while traces keep 48KB', async () => {
  const app = await boot({
    include: [],
    ignore,
    services: [{
      name: 'svc-echo',
      cwd: '.',
      args: ['-e', echoSource(9231)],
      port: 9231,
    }],
  });
  try {
    const payload = `{"message":"demo","pad":"${'a'.repeat(70_000)}"}`;
    const response = await waitFor(() => postRaw(9231, '/echo', payload).then((result) => (result.status === 200 ? result : null)).catch(() => null), 8000);
    assert.equal(response.status, 200);
    assert.ok(response.text.length > 80_000);
    const parsed = JSON.parse(response.text.slice(0, response.text.indexOf('}') + 1));
    assert.equal(parsed.received, Buffer.byteLength(payload));
    assert.equal(parsed.blob, 80_000);
    const trace = await waitFor(async () => {
      const state = await api(app, '/api/state');
      return state.traces.find((item) => item.spans.some((span) => span.path === '/echo' && span.requestTruncated && span.responseTruncated)) || null;
    });
    const span = trace.spans.find((item) => item.path === '/echo');
    assert.match(span.requestBody, /demo/);
    assert.match(span.requestBody, /truncated/);
    assert.ok(span.requestBody.length < payload.length);
    assert.match(span.responseBody, /truncated/);
    assert.ok(span.responseBody.length < response.text.length);
    const logs = await waitFor(async () => {
      const state = await api(app, '/api/state');
      const text = state.logEntries.filter((entry) => entry.service === 'svc-echo').map((entry) => entry.line).join('');
      return text.includes('Z'.repeat(20_000)) ? state.logEntries : null;
    });
    assert.ok(logs.filter((entry) => entry.service === 'svc-echo').every((entry) => entry.line.length <= 16_384));
  } finally {
    await app.close();
  }
});

test('process commands reduce to the tokens a running process must contain', () => {
  assert.deepEqual(matchTokens('yarn dev:queues'), ['dev:queues']);
  assert.deepEqual(matchTokens('npm run dev:queues -- --verbose'), ['dev:queues']);
  assert.deepEqual(matchTokens('NODE_ENV=dev node --inspect dist/worker.js'), ['dist/worker.js']);
  assert.deepEqual(matchTokens('yarn workspace @app/services dev:queues'), ['workspace', '@app/services', 'dev:queues']);
  assert.deepEqual(matchTokens('node -e "setInterval(() => {}, 1000)"'), ['setInterval(() => {}, 1000)']);
  assert.deepEqual(matchTokens('nodemon'), ['nodemon']);

  assert.equal(commandMatches('node /opt/homebrew/bin/yarn dev:queues', ['dev:queues']), true);
  assert.equal(commandMatches('npm run dev:queues', ['dev:queues']), true);
  assert.equal(commandMatches('node /repo/dist/worker.js', ['dist/worker.js']), true);
  assert.equal(commandMatches('node ./dist/worker.js', ['./dist/worker.js']), true);
  assert.equal(commandMatches('node -e setInterval(() => {}, 1000)', ['setInterval(() => {}, 1000)']), true);
  assert.equal(commandMatches('node /opt/homebrew/bin/yarn dev', ['dev:queues']), false);
  assert.equal(commandMatches('node /repo/dist/other-worker.js', ['worker.js']), false);
  assert.equal(commandMatches('anything', []), false);

  assert.equal(friendlyCommand('node /opt/homebrew/bin/yarn dev:queues'), 'yarn dev:queues');
  assert.equal(friendlyCommand('/x/bin/node /x/lib/node_modules/npm/bin/npm-cli.js run dev'), 'npm run dev');
  assert.equal(friendlyCommand('/x/bin/node --inspect-port=0 worker.js'), 'node --inspect-port=0 worker.js');
  assert.equal(friendlyCommand('npm run dev:queues'), 'npm run dev:queues');
});

test('a process service resolves to its topmost tree and the Node processes running user code', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-locate-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-locate-other-'));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'packages', 'queues'), { recursive: true });
  const real = fs.realpathSync(repo);
  try {
    const table = parseProcessTable([
      '900100     1 900100 -zsh',
      '900101 900100 900101 node /opt/homebrew/bin/yarn dev:queues',
      '900102 900101 900101 /bin/sh -c tsx watch src/queues.ts',
      '900103 900102 900101 node /repo/node_modules/.bin/tsx watch src/queues.ts',
      '900104 900103 900101 /usr/local/bin/node --require /repo/node_modules/tsx/preflight.cjs src/queues.ts',
      '900105 900104 900101 /usr/local/bin/node /repo/node_modules/bull/lib/process/master.js',
      '900200 900100 900200 node /opt/homebrew/bin/yarn dev:queues',
      '900050 900100 900050 vim dev:queues',
      '900060 900100 900060 tail -f dev:queues',
      '900300 900100 900300 node /repo/node_modules/concurrently/dist/bin/concurrently.js yarn dev:queues yarn dev:api',
      '900301 900300 900300 node /opt/homebrew/bin/yarn dev:queues',
      '900302 900301 900300 /usr/local/bin/node dist/queues.js',
    ].join('\n'));
    const cwds = new Map([[900050, real], [900060, real], [900101, real], [900200, other], [900300, other], [900301, other]]);
    const cwdOf = (pids) => new Map(pids.map((pid) => [pid, cwds.get(pid)]));

    assert.deepEqual(processTargets(table, 900101), [900104, 900105]);
    assert.deepEqual(processTargets(table, 900200), [], 'a launcher without a worker is not a running worker');
    const found = locateProcess(table, { tokens: ['dev:queues'], cwd: repo }, { cwdOf });
    assert.equal(found.root, 900101);
    assert.deepEqual(found.pids.sort(), [900101, 900102, 900103, 900104, 900105]);
    assert.deepEqual(found.targets, [900104, 900105]);

    const fromPackage = locateProcess(table, { tokens: ['dev:queues'], cwd: path.join(repo, 'packages', 'queues') }, { cwdOf });
    assert.equal(fromPackage?.root, 900101, 'a workspace script started from the repository root still matches');
    const underRunner = locateProcess(table, { tokens: ['dev:queues'], cwd: other }, { cwdOf });
    assert.equal(underRunner?.root, 900200, 'the lowest matching pid wins, never the concurrently runner');
    assert.equal(locateProcess(table, { tokens: ['dev:queues'], cwd: other }, { cwdOf, exclude: new Set([900200]) })?.root, 900301);
    assert.equal(locateProcess(table, { tokens: ['dev:queues'], cwd: repo }, { cwdOf, exclude: new Set([900101]) }), null);
    assert.equal(locateProcess(table, { tokens: ['dev:api'] }, { cwdOf }), null);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('process discovery lists terminal-started Node trees without a port inside a repository', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-groups-'));
  const loose = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-groups-loose-'));
  fs.mkdirSync(path.join(repo, '.git'));
  try {
    const table = parseProcessTable([
      '910000     1 910000 -zsh',
      '910001 910000 910001 node /opt/homebrew/bin/yarn dev:queues',
      '910002 910001 910001 /usr/local/bin/node dist/queues.js',
      '910010 910000 910010 node /opt/homebrew/bin/yarn dev:api',
      '910011 910010 910010 /usr/local/bin/node dist/api.js',
      '910020 910000 910020 claude',
      '910021 910020 910020 node /usr/lib/traceflow/src/mcp/server.mjs',
      '910030 910000 910030 node /repo/node_modules/typescript/bin/tsc -w',
      '910040 910000 910040 node scratch.js',
      '910050     1 910050 /Applications/Code Helper (Plugin) --type=utility',
      '910051 910050 910050 /usr/local/bin/node /ext/tsserver.js',
      '910060 910000 910060 node /repo/node_modules/concurrently/dist/bin/concurrently.js yarn:one yarn:two',
      '910061 910060 910060 node /opt/homebrew/bin/yarn one',
      '910062 910061 910060 /usr/local/bin/node one.js',
    ].join('\n'));
    const cwdOf = (pids) => new Map(pids.map((pid) => [pid, pid === 910040 ? loose : repo]));
    const groups = processGroups(table, { listenerPids: new Set([910011]), cwdOf });
    assert.deepEqual(groups.map((group) => group.pid), [910001, 910061]);
    const queues = groups[0];
    assert.equal(queues.command, 'yarn dev:queues');
    assert.deepEqual(queues.match, ['dev:queues']);
    assert.deepEqual(queues.targets, [910002]);
    assert.equal(queues.repo, path.basename(repo));
    assert.deepEqual(processGroups(table, { exclude: new Set([910002]), cwdOf }).map((group) => group.pid), [910010, 910061]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(loose, { recursive: true, force: true });
  }
});

test('a process service started by Traceflow streams logs and traces outbound calls without a port', async () => {
  const directory = processProject();
  const target = await jobTarget();
  const app = await startServer({
    port: 0,
    config: {
      baseDir: directory,
      include: [],
      ignore,
      services: [{ name: 'owned-queue', cwd: directory, command: 'node worker.js', env: { TARGET_PORT: String(target.port) } }],
    },
  });
  try {
    const initial = (await api(app, '/api/state')).services[0];
    assert.equal(initial.kind, 'process');
    assert.equal(initial.port, null);
    assert.deepEqual(initial.match, ['worker.js']);
    assert.equal(initial.status, 'stopped');

    const started = await app.startService('owned-queue');
    assert.equal(started.ok, true, started.error);
    const running = await waitFor(async () => {
      const service = (await api(app, '/api/state')).services[0];
      return service.status === 'running' && service.agent ? service : null;
    }, 8000);
    assert.equal(running.owner, 'traceflow');
    const log = await waitFor(async () => (await api(app, '/api/state')).logEntries.find((entry) => entry.service === 'owned-queue' && entry.line.includes('worker started')) || null);
    assert.match(log.line, /port=unset/);
    await waitFor(async () => (await api(app, '/api/state')).logEntries.filter((entry) => entry.line.startsWith('job done')).length >= 3, 8000);
    await sleep(500);
    const lines = (await api(app, '/api/state')).logEntries.filter((entry) => entry.service === 'owned-queue').map((entry) => entry.line);
    assert.equal(lines.filter((line) => line.includes('worker started')).length, 1, 'piped and agent copies of a line are shown once');
    const jobs = lines.filter((line) => line.startsWith('job done'));
    assert.equal(new Set(jobs).size, jobs.length, 'each numbered job line appears once');
    const trace = await waitFor(async () => (await api(app, '/api/state')).traces.find((item) => item.spans.some((span) => span.from === 'owned-queue' && span.path === '/job' && span.status === 200)) || null, 8000);
    assert.equal(trace.spans[0].to, `127.0.0.1:${target.port}`);

    const stopped = await app.stopService('owned-queue');
    assert.equal(stopped.ok, true, stopped.error);
    assert.equal(pidAlive(running.pid), false);
    const after = (await api(app, '/api/state')).services[0];
    assert.equal(after.status, 'stopped');
    assert.equal(after.problem, '');
  } finally {
    await app.close();
    target.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a terminal process service is attached, reattached after a watcher restart, and stopped', async () => {
  const directory = processProject();
  const target = await jobTarget();
  const app = await startServer({
    port: 0,
    config: {
      baseDir: directory,
      include: [],
      ignore,
      services: [{ name: 'queues', cwd: directory, command: 'node nodemon.js worker.js' }],
    },
  });
  const shell = spawnTerminal('node --inspect-port=0 nodemon.js worker.js', directory, { TARGET_PORT: String(target.port) });
  try {
    const running = await waitFor(async () => {
      const service = (await api(app, '/api/state')).services[0];
      return service.status === 'running' && service.processes === 1 ? service : null;
    }, 8000);
    assert.equal(running.owner, 'terminal');
    assert.equal(running.agent, false);
    assert.equal(running.attached, false);

    const blocked = await app.startService('queues');
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /Already running/);

    const attached = await api(app, '/api/services/queues/attach', { method: 'POST', body: {} });
    assert.equal(attached.ok, true, attached.error);
    assert.equal(attached.pids.length, 1, 'only the worker is attached, not the watcher');
    await waitFor(async () => (await api(app, '/api/state')).traces.find((item) => item.spans.some((span) => span.from === 'queues' && span.path === '/job')) || null, 8000);
    await waitFor(async () => (await api(app, '/api/state')).logEntries.find((entry) => entry.service === 'queues' && entry.line.includes('job done 200')) || null, 8000);
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'traceflow.services.json'), 'utf8'));
    assert.equal(saved.sticky.some((item) => item.name === 'queues'), true);

    const firstWorker = attached.pids[0];
    const killedAt = Date.now();
    process.kill(firstWorker, 'SIGKILL');
    const restarted = await waitFor(async () => {
      const snapshot = await api(app, '/api/state');
      const service = snapshot.services[0];
      const fresh = snapshot.logEntries.some((entry) => entry.service === 'queues' && entry.line.includes('job done') && entry.at > killedAt + 200);
      return service.pid === running.pid && service.attached && fresh ? service : null;
    }, 15000);
    assert.equal(restarted.status, 'running');
    assert.equal(restarted.processes, 1);

    const stopped = await api(app, '/api/services/queues/stop', { method: 'POST', body: {} });
    assert.equal(stopped.ok, true, stopped.error);
    assert.equal(pidAlive(running.pid), false);
    const after = (await api(app, '/api/state')).services[0];
    assert.equal(after.status, 'stopped');
    assert.equal(after.processes, 0);
  } finally {
    try { process.kill(-shell.pid, 'SIGKILL'); } catch { /* already stopped */ }
    await app.close();
    target.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('scan lists a Node process without a port and remembers it once attached', async () => {
  const directory = processProject({ git: true });
  const target = await jobTarget();
  const config = () => ({ baseDir: directory, include: [], ignore, services: [] });
  let app = await startServer({ port: 0, config: config() });
  const shell = spawnTerminal('node --inspect-port=0 worker.js', directory, { TARGET_PORT: String(target.port) });
  try {
    const realDirectory = fs.realpathSync(directory);
    const group = await waitFor(async () => {
      const scan = await api(app, '/api/discovery/scan', { method: 'POST', body: {} });
      return scan.processes.find((item) => item.workingDirectory === realDirectory) || null;
    }, 8000);
    assert.equal(group.command, 'node --inspect-port=0 worker.js');
    assert.deepEqual(group.match, ['worker.js']);
    assert.equal(group.repo, path.basename(directory));

    const attached = await api(app, '/api/discovery/attach', { method: 'POST', body: { pid: group.pid } });
    assert.equal(attached.ok, true, attached.error);
    const service = await waitFor(async () => (await api(app, '/api/state')).services.find((item) => item.kind === 'process' && item.agent) || null, 8000);
    assert.equal(service.name, 'worker.js');
    assert.equal(service.discovered, true);
    const rescan = await api(app, '/api/discovery/scan', { method: 'POST', body: {} });
    assert.equal(rescan.processes.some((item) => item.pid === group.pid), false, 'an attached process leaves the scan list');
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'traceflow.services.json'), 'utf8'));
    const remembered = saved.services.find((item) => item.name === 'worker.js');
    assert.equal(remembered.kind, 'process');
    assert.equal(remembered.port, undefined);
    assert.deepEqual(remembered.match, ['worker.js']);
    assert.equal(remembered.sticky, true);

    await app.close();
    app = await startServer({ port: 0, config: config() });
    const restored = await waitFor(async () => {
      const item = (await api(app, '/api/state')).services.find((entry) => entry.name === 'worker.js');
      return item?.status === 'running' && item.attached && item.agent ? item : null;
    }, 15000);
    assert.equal(restored.kind, 'process');
  } finally {
    try { process.kill(-shell.pid, 'SIGKILL'); } catch { /* already stopped */ }
    await app.close();
    target.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a configured process service only matches its own working directory', async () => {
  const project = processProject();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-elsewhere-'));
  const target = await jobTarget();
  const shell = spawnTerminal('node --inspect-port=0 worker.js', project, { TARGET_PORT: String(target.port) });
  try {
    await waitFor(() => fs.existsSync(project), 1000);
    await sleep(500);
    const app = await startServer({
      port: 0,
      config: {
        baseDir: elsewhere,
        include: [],
        ignore,
        services: [
          { name: 'no-cwd', command: 'node worker.js' },
          { name: 'with-cwd', cwd: project, command: 'node worker.js' },
        ],
      },
    });
    try {
      const state = await waitFor(async () => {
        const snapshot = await api(app, '/api/state');
        return snapshot.services.find((service) => service.name === 'with-cwd')?.status === 'running' ? snapshot : null;
      }, 8000);
      assert.equal(state.services.find((service) => service.name === 'no-cwd').status, 'stopped');
    } finally {
      await app.close();
    }
  } finally {
    try { process.kill(-shell.pid, 'SIGKILL'); } catch { /* already stopped */ }
    target.close();
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

// A queue-worker-like project: worker.js calls TARGET_PORT on a timer and never listens; nodemon.js
// restarts it when it exits, like the real watcher.
function processProject({ git = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-process-'));
  if (git) fs.mkdirSync(path.join(directory, '.git'));
  fs.writeFileSync(path.join(directory, 'worker.js'), `
    const http = require('http');
    console.log('worker started port=' + (process.env.PORT || 'unset'));
    let jobs = 0;
    setInterval(() => {
      const job = ++jobs;
      const req = http.get({ host: '127.0.0.1', port: Number(process.env.TARGET_PORT), path: '/job' }, (res) => {
        res.resume();
        res.on('end', () => console.log('job done ' + res.statusCode + ' #' + job));
      });
      req.on('error', () => {});
    }, 200);
  `);
  fs.writeFileSync(path.join(directory, 'nodemon.js'), `
    const { spawn } = require('child_process');
    let stopping = false;
    process.on('SIGTERM', () => { stopping = true; process.exit(0); });
    const run = () => {
      const child = spawn(process.execPath, ['--inspect-port=0', process.argv[2]], { stdio: 'inherit' });
      child.on('exit', () => { if (!stopping) setTimeout(run, 100); });
    };
    run();
  `);
  return directory;
}

function jobTarget() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => res.end('ok'));
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => { server.closeAllConnections?.(); server.close(); },
    }));
  });
}

// Run a command the way a terminal does: a shell that stays the parent of the dev process.
function spawnTerminal(command, cwd, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_OPTIONS;
  delete env.PORT;
  for (const key of Object.keys(env)) if (key.startsWith('TRACEFLOW_')) delete env[key];
  const child = spawn('/bin/sh', ['-c', `${command}; :`], { cwd, env, detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

const MAX_JSON_PROBE = 4_000_001;

function echoSource(port) {
  return `
    const http = require('http');
    http.createServer((req, res) => {
      if ((req.url || '').startsWith('/health')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if ((req.url || '').startsWith('/blob')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('B'.repeat(80000));
        return;
      }
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        let blob = 0;
        try {
          const text = await fetch('http://127.0.0.1:${port}/blob').then((response) => response.text());
          blob = text.length;
        } catch {
          blob = -1;
        }
        process.stdout.write('Z'.repeat(20000) + '\\n');
        const head = JSON.stringify({ received: body.length, blob });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(head + 'Y'.repeat(80000));
      });
    }).listen(${port}, '127.0.0.1');
  `;
}

function postRaw(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error(`timeout ${pathname}`)));
    req.end(body);
  });
}

function spawnNonNode(port) {
  const script = `
use IO::Socket::INET;
my $server = IO::Socket::INET->new(
  LocalHost => '127.0.0.1',
  LocalPort => ${port},
  Proto => 'tcp',
  Listen => 8,
  Reuse => 1,
) or die $!;
while (my $client = $server->accept()) {
  my $buf = '';
  $client->recv($buf, 1024);
  $client->send("HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nOK");
  $client->close();
}
`;
  return spawn('perl', ['-e', script], { stdio: 'ignore' });
}

function spawnBare(port, options = {}) {
  const env = { ...process.env, PORT: String(port) };
  delete env.NODE_OPTIONS;
  delete env.TRACEFLOW_SERVICE;
  delete env.TRACEFLOW_INGEST;
  delete env.TRACEFLOW_PEERS;
  delete env.TRACEFLOW_CONTROL;
  const source = options.esm ? `
    import http from 'node:http';
    http.createServer((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><head><title>Local app</title></head><body>encoding: ' + req.headers['accept-encoding'] + '</body></html>');
        return;
      }
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        console.log('handled ' + req.url);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    }).listen(Number(process.env.PORT), '127.0.0.1');
  ` : `
    const http = require('http');
    http.createServer((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><head><title>Local app</title></head><body>encoding: ' + req.headers['accept-encoding'] + '</body></html>');
        return;
      }
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        console.log('handled ' + req.url);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    }).listen(Number(process.env.PORT), '127.0.0.1');
  `;
  const args = options.esm
    ? ['--inspect-port=0', '--input-type=module', '-e', source]
    : ['--inspect-port=0', '-e', source];
  const child = spawn(process.execPath, args, { env, cwd: options.cwd, detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

function trioConfig(delay) {
  const env = {
    DEMO_DELAY: String(delay),
    DEMO_FRONTEND_PORT: '9201',
    DEMO_API_PORT: '9202',
    DEMO_WORKER_PORT: '9203',
  };
  return {
    include: [],
    ignore,
    services: [
      { name: 'frontend', cwd: '.', args: ['src/demo/trio.cjs'], port: 9201, env: { ...env, DEMO_ROLE: 'frontend' } },
      { name: 'api', cwd: '.', args: ['src/demo/trio.cjs'], port: 9202, env: { ...env, DEMO_ROLE: 'api' } },
      { name: 'worker', cwd: '.', args: ['src/demo/trio.cjs'], port: 9203, env: { ...env, DEMO_ROLE: 'worker' } },
    ],
  };
}

async function boot(config) {
  const app = await startServer({ port: 0, config, demo: false });
  for (const service of config.services) app.startService(service.name);
  return app;
}

async function api(app, pathname, options = {}) {
  const response = await fetch(`${app.url}${pathname}`, {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json', 'x-traceflow-token': app.token },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return response.json();
}

function postJson(port, pathname, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'Mozilla/5.0 Traceflow Test Browser',
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = text;
          try { parsed = JSON.parse(text); } catch { /* keep text */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error(`timeout ${pathname}`));
    });
    req.end(body);
  });
}

async function waitDown(port) {
  await waitFor(async () => {
    try {
      await postJson(port, '/health', {});
      return false;
    } catch {
      return true;
    }
  }, 8000);
}

async function waitHealth(ports) {
  await waitFor(async () => {
    try {
      await Promise.all(ports.map((port) => postJson(port, '/health', {})));
      return true;
    } catch {
      return false;
    }
  });
}

async function waitFor(fn, ms = 4000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = await fn();
    if (value) return value;
    await sleep(30);
  }
  throw new Error('timed out');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('preflight reports missing keys without exposing values and blocks missing directories', async () => {
  const { preflight } = await import('./preflight.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-preflight-'));
  try {
    fs.writeFileSync(path.join(directory, '.env.example'), 'TF_TEST_PRESENT=example-secret\nTF_TEST_MISSING=hidden-default\n');
    fs.writeFileSync(path.join(directory, '.env'), 'TF_TEST_PRESENT=private-secret\n');
    const report = await preflight({ name: 'api' }, { baseDir: directory });
    assert.equal(report.ok, true);
    fs.writeFileSync(path.join(directory, '.tool-versions'), 'python 3.12.0\n');
    assert.equal((await preflight({ name: 'api' }, { baseDir: directory })).checks.find(check => check.check === 'node').status, 'ok');
    assert.equal((await preflight({ name: 'api', command: 'pnpm dev', env: { PATH: '/missing-tool-path' } }, { baseDir: directory })).ok, false);
    assert.match(JSON.stringify(report), /TF_TEST_MISSING/);
    assert.doesNotMatch(JSON.stringify(report), /private-secret|hidden-default|example-secret/);
    assert.equal(fs.readFileSync(path.join(directory, '.env'), 'utf8'), 'TF_TEST_PRESENT=private-secret\n');
    assert.equal((await preflight({ name: 'missing', cwd: 'missing' }, { baseDir: directory })).ok, false);
    fs.symlinkSync('.env.example', path.join(directory, '.node-version'));
    assert.equal((await preflight({ name: 'api' }, { baseDir: directory })).ok, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('health status distinguishes warnings from errors', async () => {
  const { healthStatus } = await import('./preflight.mjs');
  assert.equal(healthStatus([{ status: 'ok' }]), 'healthy');
  assert.equal(healthStatus([{ status: 'ok' }, { status: 'warn' }]), 'degraded');
  assert.equal(healthStatus([{ status: 'warn' }, { status: 'error' }]), 'unhealthy');
  assert.equal(healthStatus([]), 'degraded');
});

test('preflight checks readiness and rejects remote redirects', async () => {
  const { preflight } = await import('./preflight.mjs');
  const server = http.createServer((req, res) => {
    if (req.url === '/ready') res.writeHead(204).end();
    else res.writeHead(302, { location: 'https://example.com' }).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const options = { baseDir: os.tmpdir(), running: true, listener: {} };
    const spec = { name: 'api', port: server.address().port, healthPath: '/ready' };
    assert.equal((await preflight(spec, options)).ok, true);
    assert.equal((await preflight({ ...spec, healthPath: '/redirect' }, options)).ok, false);
    assert.equal((await preflight({ ...spec, healthPath: '//example.com' }, options)).ok, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('stack cleanup leaves independently started services alive and requires API authentication', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-stack-'));
  const app = await startServer({ port: 0, config: {
    baseDir: directory,
    services: ['independent', 'owned'].map(name => ({ name, cwd: directory, args: ['-e', 'setInterval(() => {}, 1000)'] })),
    stacks: { task: ['independent', 'owned'] },
  } });
  try {
    assert.equal((await app.stackAction('task', 'invalid')).ok, false);
    const independent = await app.startService('independent');
    assert.equal(independent.ok, true);
    const response = await fetch(`${app.url}/api/stacks/task/start`, { method: 'POST' });
    assert.equal(response.status, 403);
    const started = await app.stackAction('task', 'start');
    assert.equal(started.ok, true);
    assert.equal(started.results[0].reused, true);
    const owned = started.results[1].pid;
    assert.ok(owned);
    assert.equal((await app.stackAction('task', 'stop')).ok, true);
    assert.equal(pidAlive(independent.pid), true);
    assert.equal(pidAlive(owned), false);
    assert.equal((await app.stackAction('missing', 'start')).ok, false);
  } finally { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('diagrams are saved, listed, renamed and deleted as .mmd files', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-diagrams-'));
  const app = await startServer({ port: 0, config: { include: [], ignore, services: [], diagramsDir: directory } });
  try {
    const page = await fetch(`${app.url}/diagrams`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /style-src 'self' 'unsafe-inline'/);
    assert.doesNotMatch(await page.text(), /__TRACEFLOW_TOKEN__/);
    assert.equal((await fetch(`${app.url}/vendor/mermaid.min.js`)).status, 200);

    const created = await api(app, '/api/diagrams', { method: 'POST', body: { name: 'Checkout flow', source: 'sequenceDiagram\n  a->>b: hi\n' } });
    assert.equal(created.name, 'checkout-flow');
    const second = await api(app, '/api/diagrams', { method: 'POST', body: { name: 'Checkout flow' } });
    assert.equal(second.name, 'checkout-flow-2');
    assert.equal(fs.readFileSync(path.join(directory, 'checkout-flow.mmd'), 'utf8'), 'sequenceDiagram\n  a->>b: hi\n');

    await api(app, '/api/diagrams/checkout-flow', { method: 'PUT', body: { source: 'sequenceDiagram\n  a->>b: bye\n' } });
    assert.equal((await api(app, '/api/diagrams/checkout-flow')).source, 'sequenceDiagram\n  a->>b: bye\n');

    const clash = await fetch(`${app.url}/api/diagrams/checkout-flow/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-traceflow-token': app.token },
      body: JSON.stringify({ to: 'checkout-flow-2' }),
    });
    assert.equal(clash.status, 409);
    await api(app, '/api/diagrams/checkout-flow/rename', { method: 'POST', body: { to: 'Guest checkout' } });
    await api(app, '/api/diagrams/checkout-flow-2', { method: 'DELETE' });
    const listed = await api(app, '/api/diagrams');
    assert.equal(listed.dir, directory);
    assert.deepEqual(listed.diagrams.map((item) => item.name), ['Guest checkout']);

    const escape = await fetch(`${app.url}/api/diagrams/${encodeURIComponent('../secrets')}`);
    assert.equal(escape.status, 400);
    const unauthenticated = await fetch(`${app.url}/api/diagrams/Guest%20checkout`, { method: 'DELETE' });
    assert.equal(unauthenticated.status, 403);
    assert.equal(fs.existsSync(path.join(directory, 'Guest checkout.mmd')), true);
  } finally {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('diagram names cannot leave the diagrams folder', () => {
  for (const name of ['../x', 'a/b', '.hidden', 'trailing.', '', 'a\\b']) assert.equal(validDiagramName(name), false, name);
  for (const name of ['checkout', 'Guest checkout v2', 'order_api.flow']) assert.equal(validDiagramName(name), true, name);
});

test('a captured trace becomes a nested Mermaid sequence diagram', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-trace-diagram-'));
  const app = await startServer({ port: 0, config: { include: [], ignore, services: [], diagramsDir: directory } });
  try {
    const base = Date.now() - 1000;
    const span = (spanId, from, to, method, pathname, phase, at, extra = {}) => ({ type: 'span', traceId: 't1', spanId, from, to, method, path: pathname, phase, at: base + at, ...extra });
    for (const event of [
      span('s1', 'browser', 'order-api', 'POST', '/api/orders?token=abc', 'start', 1000),
      span('s2', 'order-api', 'payment', 'POST', '/api/payments', 'start', 1010),
      span('s2', 'order-api', 'payment', 'POST', '/api/payments', 'end', 1130, { status: 502 }),
      span('s1', 'browser', 'order-api', 'POST', '/api/orders?token=abc', 'end', 1180, { status: 201 }),
    ]) await api(app, '/ingest', { method: 'POST', body: event });

    const { source } = await api(app, '/api/traces/t1/mermaid', { method: 'POST', body: { labels: { 'order-api': 'Order API; #2' } } });
    assert.equal(source.split('\n').slice(1).join('\n'), [
      'sequenceDiagram',
      '  title POST /api/orders',
      '  participant browser',
      '  participant order_api as Order API#59; #35;2',
      '  participant payment',
      '  browser->>+order_api: `POST` `/api/orders`',
      '  order_api->>+payment: `POST` `/api/payments`',
      '  rect rgba(255, 93, 115, 0.16)',
      '    payment--x-order_api: 502 · 120ms',
      '  end',
      '  order_api-->>-browser: 201 · 180ms',
      '',
    ].join('\n'));

    const { traces } = await api(app, '/api/traces');
    assert.deepEqual(traces.map(({ method, path: pathname, status, hops, services }) => ({ method, pathname, status, hops, services })), [
      { method: 'POST', pathname: '/api/orders', status: 201, hops: 2, services: ['browser', 'order-api', 'payment'] },
    ]);

    const saved = await api(app, '/api/traces/t1/mermaid', { method: 'POST', body: { save: true } });
    assert.match(saved.name, /^post-api-orders-\d{6}$/);
    assert.equal(fs.readFileSync(path.join(directory, `${saved.name}.mmd`), 'utf8'), saved.source);
  } finally {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an unanswered request has no activation to close', () => {
  const { source } = traceToMermaid({ spans: [{ from: 'end', to: '9api', method: 'GET', path: '/x', startedAt: 5 }] });
  assert.match(source, /participant end_ as end\n {2}participant s_9api as 9api\n {2}end_->>s_9api: `GET` `\/x`\n$/);
});

test('repeated calls collapse into a loop and bodies can become notes', () => {
  const span = (id, method, pathname, startedAt, endedAt, status, extra = {}) => ({ id, from: 'order', to: 'auth', method, path: pathname, startedAt, endedAt, status, ...extra });
  const trace = { spans: [
    { id: 'root', from: 'browser', to: 'order', method: 'POST', path: '/orders', startedAt: 0, endedAt: 500, status: 201, requestBody: '{\n  "cart": "abc"\n}' },
    span('a', 'GET', '/status', 10, 20, 202),
    span('b', 'GET', '/status', 30, 60, 202),
    span('c', 'GET', '/status', 70, 90, 200),
    span('d', 'POST', '/token', 100, 110, 401),
  ] };
  const lines = traceToMermaid(trace, { notes: true }).source.split('\n').slice(6);
  assert.deepEqual(lines, [
    '  browser->>+order: `POST` `/orders`',
    '  Note over browser,order: { "cart": "abc" }',
    '  loop 3 times',
    '    order->>+auth: `GET` `/status`',
    '    auth-->>-order: 202, 200 · 10–30ms',
    '  end',
    '  order->>+auth: `POST` `/token`',
    '  rect rgba(255, 93, 115, 0.16)',
    '    auth--x-order: 401 · 10ms',
    '  end',
    '  order-->>-browser: 201 · 500ms',
    '',
  ]);
  assert.equal(traceToMermaid(trace, { collapseRepeats: false }).source.match(/`GET` `\/status`/g).length, 3);
});

test('the diagram editor hears about files changed outside it', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-diagram-watch-'));
  const app = await startServer({ port: 0, config: { include: [], ignore, services: [], diagramsDir: directory } });
  const controller = new AbortController();
  try {
    const response = await fetch(`${app.url}/api/diagrams/events`, { signal: controller.signal });
    const reader = response.body.getReader();
    fs.writeFileSync(path.join(directory, 'outside.mmd'), 'sequenceDiagram\n  a->>b: hi\n');
    let received = '';
    const deadline = Date.now() + 3000;
    while (!received.includes('data: changed') && Date.now() < deadline) {
      const { value, done } = await Promise.race([reader.read(), sleep(deadline - Date.now()).then(() => ({ done: true }))]);
      if (done) break;
      received += new TextDecoder().decode(value);
    }
    assert.match(received, /data: changed/);
  } finally {
    controller.abort();
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('agents can write diagrams and draw traces through MCP', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'traceflow-mcp-diagrams-'));
  const app = await startServer({ port: 0, config: { include: [], ignore, services: [], diagramsDir: directory } });
  const mcp = spawn(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), 'mcp', 'server.mjs')], {
    env: { ...process.env, TRACEFLOW_URL: app.url },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const replies = readline.createInterface({ input: mcp.stdout })[Symbol.asyncIterator]();
  let id = 0;
  const call = async (name, args) => {
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })}\n`);
    const reply = JSON.parse((await replies.next()).value);
    assert.equal(reply.result.isError, undefined, reply.result.content?.[0]?.text);
    return JSON.parse(reply.result.content[0].text);
  };
  try {
    const written = await call('traceflow_diagram_write', { name: 'Checkout', source: 'sequenceDiagram\n  a->>b: hi\n' });
    assert.equal(written.name, 'checkout');
    assert.equal(written.url, `${app.url}/diagrams#checkout`);
    assert.equal((await call('traceflow_diagram_write', { name: 'checkout', source: 'x', mode: 'create' })).name, 'checkout-2');
    await call('traceflow_diagram_write', { name: 'checkout', source: 'sequenceDiagram\n  a->>b: bye\n', mode: 'replace' });
    assert.equal((await call('traceflow_diagram_read', { name: 'checkout' })).source, 'sequenceDiagram\n  a->>b: bye\n');
    assert.deepEqual((await call('traceflow_diagrams', {})).diagrams.map((item) => item.name).sort(), ['checkout', 'checkout-2']);

    const at = Date.now() - 500;
    for (const event of [
      { type: 'span', traceId: 'mcp', spanId: 's', from: 'browser', to: 'api', method: 'GET', path: '/x', phase: 'start', at },
      { type: 'span', traceId: 'mcp', spanId: 's', from: 'browser', to: 'api', method: 'GET', path: '/x', phase: 'end', at: at + 40, status: 200 },
    ]) await api(app, '/ingest', { method: 'POST', body: event });
    const drawn = await call('traceflow_trace_diagram', { traceId: 'mcp', save: true });
    assert.match(drawn.source, /browser->>\+api: `GET` `\/x`/);
    assert.equal(fs.readFileSync(path.join(directory, `${drawn.name}.mmd`), 'utf8'), drawn.source);
  } finally {
    mcp.kill();
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
