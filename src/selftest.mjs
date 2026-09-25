import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { workingDirectoryForCommand } from './attach.mjs';
import { loadConfig, nodeBinForProject, startServer } from './server.mjs';

const ignore = ['/health', '/healthcheck', '/ready', '/metrics', '/favicon.ico'];

test('configuration is optional when discovering local services', () => {
  const config = loadConfig({ cwd: '/traceflow/no-config-here', env: {} });
  assert.equal(config.port, 9477);
  assert.deepEqual(config.services, []);
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
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { stdio: 'ignore' });
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
  const child = spawn(process.execPath, args, { env, detached: true, stdio: 'ignore' });
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
