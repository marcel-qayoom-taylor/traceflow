const state = {
  demo: false,
  control: { mode: 'run', pauseOnResponse: true, captureBrowser: true, captureDebug: false, capture: 'all', include: [], ignore: [] },
  gates: [],
  services: [],
  discovered: [],
  traces: [],
  sampleUrl: null,
  logEntries: [],
};
let selectedTraceId = null;
let selectedSpanId = null;
let selectedSpanKind = null;
let follow = true;
let logService = null;
let logNote = '';
let traceFilter = '';
let traceFiltersOpen = false;
const traceListFilters = { status: '', slow: false, pinned: false };
let scanning = false;
let scanNote = '';
let scanQuery = '';
let scanModal = null;
let scanResults = null;
let settingsOpen = false;
let samplePending = false;
let sampleError = '';
let openServiceMenu = null;
const expandedTraceGroups = new Set();
const pendingServiceActions = new Map();
const pendingDiscoveredAttachments = new Set();

const $ = (id) => document.getElementById(id);
const SESSION_TOKEN = document.querySelector('meta[name="traceflow-token"]')?.content || '';

const LOG_HEIGHT_KEY = 'traceflow.log-height';
const LOG_MIN_HEIGHT = 96;
const MAIN_MIN_HEIGHT = 160;
const INSPECTOR_WIDTH_KEY = 'traceflow.inspector-width';
const SERVICE_ALIASES_KEY = 'traceflow.service-aliases';
const HIDDEN_SERVICES_KEY = 'traceflow.hidden-services';
const HIGHLIGHT_LOGS_KEY = 'traceflow.highlight-logs';
let highlightRelatedLogs = localStorage.getItem(HIGHLIGHT_LOGS_KEY) !== '0';
const INSPECTOR_MIN_WIDTH = 240;
const STAGE_MIN_WIDTH = 360;
const BURST_GAP_MS = 3000;
const SLOW_MS = 500;
const BUDGET_RATIO = 1.5;
const MIN_BUDGET_MS = 20;
const LOG_MATCH_PAD_MS = 1500;
const HOP_LOG_LIMIT = 30;
const serviceAliases = readStoredObject(SERVICE_ALIASES_KEY);
const hiddenServices = new Set(readStoredArray(HIDDEN_SERVICES_KEY));

function readStoredObject(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function readStoredArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

function storeServicePreferences() {
  localStorage.setItem(SERVICE_ALIASES_KEY, JSON.stringify(serviceAliases));
  localStorage.setItem(HIDDEN_SERVICES_KEY, JSON.stringify([...hiddenServices]));
}

function revealListeningServices(services) {
  let changed = false;
  for (const service of services) {
    if (service.status === 'running' && hiddenServices.delete(service.name)) changed = true;
  }
  if (changed) storeServicePreferences();
}

function defaultServiceName(service) {
  if (!service) return '';
  const sharedRepo = service.repo
    && state.services.some((other) => other !== service && other.repo === service.repo);
  return service.repo
    ? `${service.repo}${sharedRepo ? ` · ${service.name}` : ''}`
    : `localhost:${service.port}`;
}

function serviceDisplayName(service) {
  return serviceAliases[service.name] || defaultServiceName(service);
}

function actorLabel(name) {
  const service = state.services.find((item) => item.name === name);
  if (!service) return { title: name, hint: '' };
  const address = `localhost:${service.port}`;
  const title = serviceAliases[service.name] || service.repo || address;
  return { title, hint: title === address ? '' : address };
}

const ACTOR_FONT = '12px ui-monospace, "SF Mono", Menlo, monospace';
const HINT_FONT = '10px ui-monospace, "SF Mono", Menlo, monospace';
const ARROW_FONT = '11px ui-monospace, "SF Mono", Menlo, monospace';
const ACTOR_MAX_WIDTH = 168;
const ACTOR_MIN_PITCH = 112;
const ACTOR_LABEL_GAP = 22;
const ARROW_LABEL_PAD = 48;
const TITLE_LINE = 15;
const HINT_LINE = 13;

function textWidth(text, font) {
  const canvas = textWidth.canvas || (textWidth.canvas = document.createElement('canvas'));
  const context = canvas.getContext('2d');
  context.font = font;
  return context.measureText(text).width;
}

function wrapDiagramLabel(text, maxWidth, font) {
  if (textWidth(text, font) <= maxWidth) return [text];
  const tokens = text.split(/(?<=[./:_-])|\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  const pushHard = (token) => {
    let rest = token;
    while (textWidth(rest, font) > maxWidth) {
      let cut = rest.length - 1;
      while (cut > 1 && textWidth(rest.slice(0, cut), font) > maxWidth) cut -= 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    return rest;
  };
  for (const token of tokens) {
    const next = line ? `${line}${token}` : token;
    if (textWidth(next, font) <= maxWidth) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = textWidth(token, font) > maxWidth ? pushHard(token) : token;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [text];
}

function spanDuration(span) {
  return span?.endedAt ? span.endedAt - span.startedAt : null;
}

function spanIsBad(span) {
  return Boolean(span?.error) || (span?.status != null && Number(span.status) >= 400);
}

function budgetSpanId(spans) {
  const completed = (spans || [])
    .map((span) => ({ id: span.id, ms: spanDuration(span) }))
    .filter((span) => span.ms != null)
    .sort((a, b) => b.ms - a.ms);
  const [top, next] = completed;
  if (!top || top.ms === next?.ms) return null;
  if (top.ms >= SLOW_MS) return top.id;
  if (next && top.ms >= next.ms * BUDGET_RATIO && top.ms >= MIN_BUDGET_MS) return top.id;
  return null;
}

function spanMarks(span, budgetId) {
  return { bad: spanIsBad(span), budget: Boolean(budgetId) && span?.id === budgetId };
}

function traceProblems(trace) {
  const spans = trace?.spans || [];
  return {
    bad: spans.some(spanIsBad),
    slow: spans.some((span) => (spanDuration(span) ?? 0) >= SLOW_MS),
  };
}

function diagramArrowText(span, kind, marks = {}) {
  if (kind === 'request') return `${span.method} ${shortPath(span.path)}`;
  const duration = spanDuration(span);
  const note = marks.bad ? '  error' : marks.budget ? '  slowest' : '';
  return `${span.status ?? '…'}${duration == null ? '' : `  ${duration}ms`}${note}`;
}

function layoutDiagramActors(actors, spans = [], budgetId = null) {
  const laid = actors.map((actor) => {
    const titleLines = wrapDiagramLabel(actor.title, ACTOR_MAX_WIDTH, ACTOR_FONT);
    const hintLines = actor.hint ? wrapDiagramLabel(actor.hint, ACTOR_MAX_WIDTH, HINT_FONT) : [];
    const labelWidth = Math.max(
      0,
      ...titleLines.map((line) => textWidth(line, ACTOR_FONT)),
      ...hintLines.map((line) => textWidth(line, HINT_FONT)),
    );
    return { ...actor, titleLines, hintLines, labelWidth };
  });
  laid.forEach((actor, index) => {
    const service = state.services.some((item) => item.name === actor.name);
    const left = actor.labelWidth / 2 + (service ? 14 : 0);
    const right = actor.labelWidth / 2;
    if (!index) {
      actor.x = 16 + left;
    } else {
      const previous = laid[index - 1];
      const pitch = Math.max(ACTOR_MIN_PITCH, previous.right + ACTOR_LABEL_GAP + left);
      actor.x = previous.x + pitch;
    }
    actor.left = left;
    actor.right = right;
  });
  const indexOf = new Map(laid.map((actor, index) => [actor.name, index]));
  for (const span of spans) {
    const from = indexOf.get(span.from);
    const to = indexOf.get(span.to);
    if (from == null || to == null || from === to) continue;
    const left = Math.min(from, to);
    const right = Math.max(from, to);
    const marks = spanMarks(span, budgetId);
    const labelWidth = Math.max(
      textWidth(diagramArrowText(span, 'request', marks), ARROW_FONT),
      textWidth(diagramArrowText(span, 'response', marks), ARROW_FONT),
    ) + ARROW_LABEL_PAD;
    const distance = laid[right].x - laid[left].x;
    if (distance >= labelWidth) continue;
    const extra = labelWidth - distance;
    for (let index = right; index < laid.length; index += 1) laid[index].x += extra;
  }
  const titleY = 16;
  for (const actor of laid) {
    actor.hintY = titleY + actor.titleLines.length * TITLE_LINE + 1;
    const blockBottom = actor.hintLines.length
      ? actor.hintY + (actor.hintLines.length - 1) * HINT_LINE
      : titleY + (actor.titleLines.length - 1) * TITLE_LINE;
    actor.blockBottom = blockBottom;
  }
  const last = laid[laid.length - 1];
  return {
    laid,
    width: last ? last.x + last.right + 28 : 1,
    titleY,
    lineY: Math.max(titleY, ...laid.map((actor) => actor.blockBottom)) + 14,
  };
}

function rootSpan(trace) {
  return [...(trace?.spans || [])].sort((a, b) => a.startedAt - b.startedAt)[0] || null;
}

function normalizedPath(value) {
  return String(value || '/').split('?')[0] || '/';
}

function isDebuggerTrace(trace) {
  const pathname = normalizedPath(rootSpan(trace)?.path);
  return pathname === '/message' || pathname.startsWith('/inspector/');
}

function traceListMeta(trace) {
  const root = rootSpan(trace);
  const startedAt = trace?.startedAt || root?.startedAt || 0;
  return {
    method: root?.method || 'REQUEST',
    path: root?.path || '/',
    normalizedPath: normalizedPath(root?.path),
    from: displayedSource(root),
    to: root?.to || 'unknown',
    status: root?.status ?? null,
    startedAt,
  };
}

function displayedSource(span) {
  if (span?.from && span.from !== 'browser') return span.from;
  const headers = span?.requestHeaders || {};
  const userAgent = String(headers['user-agent'] || '').toLowerCase();
  if (headers.origin || headers['sec-fetch-site'] || /mozilla|chrome|safari|firefox|edg\//.test(userAgent)) return 'browser';
  if (/node|undici|node-fetch|axios|got\//.test(userAgent)) return 'node client';
  return span?.from || 'external';
}

function groupTraceBursts(traces) {
  const groups = [];
  for (const trace of traces) {
    const meta = traceListMeta(trace);
    const signature = [meta.from, meta.to, meta.method, meta.normalizedPath, meta.status ?? 'pending'].join('\u0000');
    const previous = groups.at(-1);
    const previousOldest = previous?.traces.at(-1);
    const gap = previousOldest ? traceListMeta(previousOldest).startedAt - meta.startedAt : Infinity;
    if (previous && previous.signature === signature && gap >= 0 && gap <= BURST_GAP_MS) {
      previous.traces.push(trace);
      continue;
    }
    groups.push({ signature, traces: [trace] });
  }
  return groups.map((group) => ({
    ...group,
    key: `${group.signature}\u0000${group.traces.at(-1).id}`,
  }));
}

function maximumLogHeight() {
  const top = document.querySelector('.top').getBoundingClientRect().height;
  return Math.max(LOG_MIN_HEIGHT, window.innerHeight - top - MAIN_MIN_HEIGHT - 10);
}

function setLogHeight(height, persist = false) {
  const value = Math.round(Math.min(Math.max(height, LOG_MIN_HEIGHT), maximumLogHeight()));
  document.documentElement.style.setProperty('--logs-height', `${value}px`);
  $('log-resizer').setAttribute('aria-valuenow', String(value));
  $('log-resizer').setAttribute('aria-valuemax', String(maximumLogHeight()));
  if (persist) localStorage.setItem(LOG_HEIGHT_KEY, String(value));
}

function initializeLogResizer() {
  const resizer = $('log-resizer');
  const savedHeight = Number.parseInt(localStorage.getItem(LOG_HEIGHT_KEY), 10);
  if (Number.isFinite(savedHeight)) setLogHeight(savedHeight);
  else setLogHeight(168);

  resizer.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    document.body.classList.add('logs-resizing');
    const resize = (moveEvent) => setLogHeight(window.innerHeight - moveEvent.clientY, false);
    const finish = () => {
      document.body.classList.remove('logs-resizing');
      setLogHeight(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--logs-height'), 10), true);
      resizer.removeEventListener('pointermove', resize);
      resizer.removeEventListener('pointerup', finish);
      resizer.removeEventListener('pointercancel', finish);
    };
    resizer.addEventListener('pointermove', resize);
    resizer.addEventListener('pointerup', finish);
    resizer.addEventListener('pointercancel', finish);
  });
  resizer.addEventListener('keydown', (event) => {
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--logs-height'), 10);
    const step = event.shiftKey ? 64 : 24;
    let next;
    if (event.key === 'ArrowUp') next = current + step;
    else if (event.key === 'ArrowDown') next = current - step;
    else if (event.key === 'Home') next = LOG_MIN_HEIGHT;
    else if (event.key === 'End') next = maximumLogHeight();
    else return;
    event.preventDefault();
    setLogHeight(next, true);
  });
  window.addEventListener('resize', () => setLogHeight(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--logs-height'), 10)));
}

function maximumInspectorWidth() {
  return Math.max(INSPECTOR_MIN_WIDTH, window.innerWidth - 280 - STAGE_MIN_WIDTH - 10);
}

function setInspectorWidth(width, persist = false) {
  const value = Math.round(Math.min(Math.max(width, INSPECTOR_MIN_WIDTH), maximumInspectorWidth()));
  document.documentElement.style.setProperty('--inspector-width', `${value}px`);
  $('inspector-resizer').setAttribute('aria-valuenow', String(value));
  $('inspector-resizer').setAttribute('aria-valuemax', String(maximumInspectorWidth()));
  if (persist) localStorage.setItem(INSPECTOR_WIDTH_KEY, String(value));
}

function initializeInspectorResizer() {
  const resizer = $('inspector-resizer');
  const savedWidth = Number.parseInt(localStorage.getItem(INSPECTOR_WIDTH_KEY), 10);
  if (Number.isFinite(savedWidth)) setInspectorWidth(savedWidth);
  else setInspectorWidth(340);

  resizer.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    document.body.classList.add('inspector-resizing');
    const resize = (moveEvent) => setInspectorWidth(window.innerWidth - moveEvent.clientX, false);
    const finish = () => {
      document.body.classList.remove('inspector-resizing');
      setInspectorWidth(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--inspector-width'), 10), true);
      resizer.removeEventListener('pointermove', resize);
      resizer.removeEventListener('pointerup', finish);
      resizer.removeEventListener('pointercancel', finish);
    };
    resizer.addEventListener('pointermove', resize);
    resizer.addEventListener('pointerup', finish);
    resizer.addEventListener('pointercancel', finish);
  });
  resizer.addEventListener('keydown', (event) => {
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--inspector-width'), 10);
    const step = event.shiftKey ? 64 : 24;
    let next;
    if (event.key === 'ArrowLeft') next = current + step;
    else if (event.key === 'ArrowRight') next = current - step;
    else if (event.key === 'Home') next = INSPECTOR_MIN_WIDTH;
    else if (event.key === 'End') next = maximumInspectorWidth();
    else return;
    event.preventDefault();
    setInspectorWidth(next, true);
  });
  window.addEventListener('resize', () => {
    setInspectorWidth(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--inspector-width'), 10));
    const svg = $('diagram')?.querySelector('svg');
    if (svg && !diagramView.userMoved) placeDiagram(svg);
  });
}

let renderScheduled = false;
const dirtyView = { chrome: false, traces: false, logs: false };

function connect() {
  const source = new EventSource(`/events?token=${encodeURIComponent(SESSION_TOKEN)}`);
  source.addEventListener('snapshot', (event) => {
    const data = JSON.parse(event.data);
    Object.assign(state, data, { control: { ...state.control, ...data.control } });
    revealListeningServices(state.services);
    settlePendingServiceActions();
    scheduleRender({ chrome: true, traces: true, logs: true });
  });
  source.addEventListener('delta', (event) => {
    applyDelta(JSON.parse(event.data));
  });
  source.addEventListener('log', (event) => {
    for (const entry of JSON.parse(event.data)) {
      state.logEntries.push(entry);
      if (state.logEntries.length > 900) state.logEntries.shift();
    }
    scheduleRender({ logs: true });
  });
  source.onerror = () => {
    source.close();
    setTimeout(connect, 1000);
  };
}

function applyDelta(data) {
  let chrome = false;
  let traces = false;
  let logs = false;
  if (data.control) {
    const captureDebugChanged = data.control.captureDebug !== undefined
      && data.control.captureDebug !== state.control.captureDebug;
    state.control = { ...state.control, ...data.control };
    chrome = true;
    if (captureDebugChanged) traces = true;
  }
  if (data.gates) {
    state.gates = data.gates;
    chrome = true;
  }
  if (data.services) {
    const previous = new Set(state.services.map((service) => service.name));
    state.services = data.services;
    revealListeningServices(state.services.filter((service) => !previous.has(service.name)));
    settlePendingServiceActions();
    chrome = true;
    traces = true;
    logs = true;
  }
  if (Array.isArray(data.discovered)) {
    state.discovered = data.discovered;
    if (scanModal) renderScanResults();
    chrome = true;
  }
  if (data.clear) {
    state.traces = [];
    selectedTraceId = null;
    selectedSpanId = null;
    selectedSpanKind = null;
    traces = true;
  }
  if (data.logsClear) {
    state.logEntries = [];
    logs = true;
  }
  if (Array.isArray(data.removed) && data.removed.length) {
    const drop = new Set(data.removed);
    state.traces = state.traces.filter((trace) => !drop.has(trace.id));
    if (drop.has(selectedTraceId)) {
      selectedTraceId = null;
      selectedSpanId = null;
      selectedSpanKind = null;
    }
    traces = true;
  }
  if (Array.isArray(data.spans)) {
    for (const update of data.spans) applySpanUpdate(update);
    state.traces.sort((a, b) => b.startedAt - a.startedAt);
    traces = true;
  }
  if (chrome || traces || logs) scheduleRender({ chrome, traces, logs });
}

function applySpanUpdate(update) {
  let trace = state.traces.find((item) => item.id === update.traceId);
  if (!trace) {
    trace = {
      id: update.traceId,
      startedAt: update.startedAt,
      spans: [],
      spansTruncated: !!update.spansTruncated,
      pinned: !!update.pinned,
    };
    state.traces.unshift(trace);
  }
  trace.startedAt = update.startedAt || trace.startedAt;
  if (update.spansTruncated) trace.spansTruncated = true;
  if (!update.span && 'pinned' in update) trace.pinned = !!update.pinned;
  if (!update.span) return;
  const index = trace.spans.findIndex((item) => item.id === update.span.id);
  if (index >= 0) {
    const kind = trace.spans[index]._kind;
    trace.spans[index] = update.span;
    if (kind) trace.spans[index]._kind = kind;
  } else trace.spans.push(update.span);
}

function scheduleRender(part) {
  if (part.chrome) dirtyView.chrome = true;
  if (part.traces) dirtyView.traces = true;
  if (part.logs) dirtyView.logs = true;
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(flushRender);
}

function flushRender() {
  renderScheduled = false;
  const chrome = dirtyView.chrome;
  const traces = dirtyView.traces;
  const logs = dirtyView.logs;
  dirtyView.chrome = false;
  dirtyView.traces = false;
  dirtyView.logs = false;
  if (traces && follow) {
    const newest = filteredTraces()[0];
    if (newest && newest.id !== selectedTraceId) {
      selectedTraceId = newest.id;
      selectedSpanId = null;
      selectedSpanKind = null;
    }
  }
  if (chrome) {
    renderTransport();
    renderSettings();
    renderServices();
    renderHeld();
  }
  if (traces) {
    renderTraces();
    renderDiagram();
    renderInspector();
  }
  if (logs) {
    renderLogs({ stickToEnd: true });
    if (selectedTraceId) renderInspector();
  }
}

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-traceflow-token': SESSION_TOKEN },
    body: body ? JSON.stringify(body) : '{}',
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Request failed');
  return response.json().catch(() => ({}));
}

async function runServiceAction(service, action) {
  if (pendingServiceActions.has(service.name)) return;
  const pending = { action, requestComplete: false };
  pendingServiceActions.set(service.name, pending);
  renderServices();
  try {
    await post(`/api/services/${encodeURIComponent(service.name)}/${action}`);
    pending.requestComplete = true;
    settlePendingServiceActions();
  } catch {
    pendingServiceActions.delete(service.name);
    renderServices();
  }
}

function settlePendingServiceActions() {
  let changed = false;
  for (const [name, pending] of pendingServiceActions) {
    const service = state.services.find((item) => item.name === name);
    const done = pending.action === 'start' ? service?.status === 'running'
      : pending.action === 'stop' ? service && service.status !== 'running' && service.status !== 'stopping'
        : service?.attached;
    if (pending.requestComplete && done) {
      pendingServiceActions.delete(name);
      changed = true;
    }
  }
  if (changed) renderServices();
}

async function attachDiscovered(port) {
  if (pendingDiscoveredAttachments.has(port)) return;
  pendingDiscoveredAttachments.add(port);
  renderScanResults();
  try {
    await post('/api/discovery/attach', { port });
  } catch {
    // The listener remains available to retry after the request finishes.
  } finally {
    pendingDiscoveredAttachments.delete(port);
    renderScanResults();
  }
}

function renderTransport() {
  const root = $('transport');
  root.replaceChildren();
  const paused = state.control.mode === 'step';
  const held = state.gates.length > 0;
  const step = button('Step', () => post('/api/step'), {
    className: paused && held ? 'primary' : '',
    disabled: !paused || !held,
  });
  if (!paused) step.title = 'Pause to step through requests';
  else if (!held) step.title = 'Nothing is held';
  root.append(
    paused ? button('Resume', () => post('/api/resume'), { className: held ? '' : 'primary' }) : button('Pause', () => post('/api/pause')),
    step,
  );
  if (state.demo && state.sampleUrl) {
    const sample = button(samplePending ? 'Sending sample…' : 'Send sample request', sendSample, {
      className: 'primary',
      disabled: samplePending,
    });
    if (sampleError) sample.title = sampleError;
    root.append(sample);
  }
}

function renderSettings() {
  const toggle = $('settings-toggle');
  const panel = $('settings-panel');
  toggle.setAttribute('aria-expanded', String(settingsOpen));
  panel.hidden = !settingsOpen;
  panel.replaceChildren();

  const captureHeading = document.createElement('div');
  captureHeading.className = 'settings-heading';
  captureHeading.textContent = 'Capture';
  const captureRow = document.createElement('label');
  captureRow.className = 'settings-row';
  const captureSelect = document.createElement('select');
  captureSelect.setAttribute('aria-label', 'Capture mode');
  for (const [value, text] of [['all', 'All requests'], ['matched', 'Matching paths'], ['armed', 'Next request'], ['off', 'Off']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    option.selected = state.control.capture === value;
    captureSelect.append(option);
  }
  captureSelect.addEventListener('change', () => { void post('/api/control', { capture: captureSelect.value }); });
  captureRow.append(document.createTextNode('Capture mode'), captureSelect);

  const debugRow = settingsCheckbox('Capture debugger traffic', Boolean(state.control.captureDebug), (checked) => {
    state.control.captureDebug = checked;
    scheduleRender({ chrome: true, traces: true });
    void post('/api/control', { captureDebug: checked });
  });
  const debugNote = document.createElement('div');
  debugNote.className = 'settings-note';
  debugNote.textContent = 'Includes /message and /inspector/* requests.';
  const browserRow = settingsCheckbox('Capture browser traffic', Boolean(state.control.captureBrowser), (checked) => {
    state.control.captureBrowser = checked;
    void post('/api/control', { captureBrowser: checked });
  });
  const browserNote = document.createElement('div');
  browserNote.className = 'settings-note';
  browserNote.textContent = 'Captures external fetch and XHR calls from attached local web apps. Reload the app after enabling.';

  const playbackHeading = document.createElement('div');
  playbackHeading.className = 'settings-heading';
  playbackHeading.textContent = 'Playback';
  const responseRow = settingsCheckbox('Pause on responses', Boolean(state.control.pauseOnResponse), (checked) => {
    void post('/api/control', { pauseOnResponse: checked });
  });
  const followRow = settingsCheckbox('Follow newest trace', follow, (checked) => {
    follow = checked;
    if (follow) scheduleRender({ traces: true });
  });
  const displayHeading = document.createElement('div');
  displayHeading.className = 'settings-heading';
  displayHeading.textContent = 'Display';
  const highlightRow = settingsCheckbox('Highlight related logs', highlightRelatedLogs, (checked) => {
    highlightRelatedLogs = checked;
    localStorage.setItem(HIGHLIGHT_LOGS_KEY, checked ? '1' : '0');
    renderLogs();
  });

  panel.append(captureHeading, captureRow, browserRow, browserNote, debugRow, debugNote, playbackHeading, responseRow, followRow, displayHeading, highlightRow);
  if (hiddenServices.size) {
    const servicesHeading = document.createElement('div');
    servicesHeading.className = 'settings-heading';
    servicesHeading.textContent = 'Services';
    const restore = button(`Restore removed services (${hiddenServices.size})`, () => {
      hiddenServices.clear();
      storeServicePreferences();
      renderServices();
      renderSettings();
    }, { className: 'settings-action' });
    panel.append(servicesHeading, restore);
  }
}

function settingsCheckbox(label, checked, onChange) {
  const row = document.createElement('label');
  row.className = 'settings-row';
  const text = document.createElement('span');
  text.textContent = label;
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  row.append(text, box);
  return row;
}

function serviceIndicator(service, pendingAction) {
  if (pendingAction || service.status === 'stopping') {
    const action = pendingAction || 'stop';
    return { tone: 'yellow', label: `${action[0].toUpperCase()}${action.slice(1)}ing…` };
  }
  if (service.status === 'running' && service.agent) {
    return { tone: 'green', label: 'Running and attached' };
  }
  if (service.status === 'running' && service.attached) {
    return { tone: 'yellow', label: 'Attached, waiting for agent' };
  }
  if (service.status === 'running') {
    return { tone: 'yellow', label: 'Running, not attached' };
  }
  if (service.problem || service.status === 'exited') {
    return { tone: 'red', label: service.problem || 'Process exited' };
  }
  return { tone: 'grey', label: 'Stopped, not attached' };
}

function renderServices() {
  const root = $('services');
  const hasAttachedService = state.services.some((service) => service.attached || service.agent);
  $('scan-hint').hidden = hasAttachedService;
  root.replaceChildren();
  if (state.demo) {
    const note = document.createElement('div');
    note.className = 'banner';
    note.textContent = 'Demo mode';
    root.append(note);
  }
  for (const service of state.services) {
    if (hiddenServices.has(service.name)) continue;
    const pendingAction = pendingServiceActions.get(service.name)?.action;
    const indicator = serviceIndicator(service, pendingAction);
    const defaultDisplayName = defaultServiceName(service);
    const displayName = serviceDisplayName(service);
    const card = document.createElement('div');
    card.className = logService === service.name ? 'service log-selected' : 'service';
    const menuToggle = button('⋯', (event) => {
      event.stopPropagation();
      openServiceMenu = openServiceMenu === service.name ? null : service.name;
      renderServices();
    }, { className: 'service-menu-toggle' });
    menuToggle.setAttribute('aria-label', `More actions for ${displayName}`);
    menuToggle.setAttribute('aria-haspopup', 'menu');
    menuToggle.setAttribute('aria-expanded', String(openServiceMenu === service.name));
    if (openServiceMenu === service.name) {
      const menu = document.createElement('div');
      menu.className = 'service-menu';
      menu.setAttribute('role', 'menu');
      const remove = button('Remove', (event) => {
        event.stopPropagation();
        hiddenServices.add(service.name);
        openServiceMenu = null;
        if (logService === service.name) logService = null;
        storeServicePreferences();
        renderServices();
        renderSettings();
        renderLogs();
      });
      remove.setAttribute('role', 'menuitem');
      remove.className = 'danger';
      const rename = button('Rename', (event) => {
        event.stopPropagation();
        const value = window.prompt('Local service alias', serviceAliases[service.name] || defaultDisplayName);
        if (value === null) return;
        const alias = value.trim();
        if (alias && alias !== defaultDisplayName) serviceAliases[service.name] = alias;
        else delete serviceAliases[service.name];
        openServiceMenu = null;
        storeServicePreferences();
        renderServices();
        renderLogs();
      });
      rename.setAttribute('role', 'menuitem');
      menu.append(remove, rename);
      card.append(menu);
    }
    const row = document.createElement('div');
    row.className = 'row';
    row.classList.add('service-log-filter');
    row.tabIndex = 0;
    row.title = `Show only ${displayName} logs`;
    const name = document.createElement('div');
    name.className = 'name';
    const dot = document.createElement('i');
    dot.className = `dot status-${indicator.tone}`;
    const statusText = `${indicator.label} · localhost:${service.port}`;
    const attachNote = service.status === 'running' && !service.agent ? (service.problem || service.message) : '';
    dot.title = attachNote ? `${statusText}. ${attachNote}` : statusText;
    dot.setAttribute('aria-label', statusText);
    name.append(dot, document.createTextNode(displayName));
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = String(service.port);
    row.append(name);
    row.addEventListener('click', () => selectServiceLogs(service.name));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectServiceLogs(service.name);
      }
    });
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      button(pendingAction === 'start' ? 'Starting…' : 'Start', () => { void runServiceAction(service, 'start'); }, { disabled: Boolean(pendingAction) || service.status === 'running' }),
      button(pendingAction === 'attach' ? 'Attaching…' : 'Attach', () => { void runServiceAction(service, 'attach'); }, { disabled: Boolean(pendingAction) || service.status !== 'running' || service.owner !== 'terminal' || service.agent }),
      button(pendingAction === 'stop' ? 'Stopping…' : 'Stop', () => { void runServiceAction(service, 'stop'); }, { disabled: Boolean(pendingAction) || service.status !== 'running' }),
    );
    const footer = document.createElement('div');
    footer.className = 'service-footer';
    footer.append(meta, actions);
    card.append(menuToggle, row, footer);
    root.append(card);
  }
}

function renderTraces() {
  const root = $('traces');
  root.replaceChildren();
  if (!state.traces.length) {
    const empty = document.createElement('div');
    empty.className = 'meta';
    empty.textContent = 'No captured requests yet.';
    root.append(empty);
    return;
  }
  const traces = filteredTraces();
  if (!traces.length) {
    const empty = document.createElement('div');
    empty.className = 'meta';
    empty.textContent = 'No matching traces.';
    root.append(empty);
    return;
  }
  const pinned = traces.filter((trace) => trace.pinned);
  const rest = traces.filter((trace) => !trace.pinned);
  if (pinned.length) appendTraceGroups(root, pinned);
  appendTraceGroups(root, rest);
}

function appendTraceGroups(root, traces) {
  for (const group of groupTraceBursts(traces)) {
    if (group.traces.length === 1) {
      root.append(traceButton(group.traces[0]));
      continue;
    }
    const expanded = expandedTraceGroups.has(group.key);
    const latest = traceListMeta(group.traces[0]);
    const groupButton = document.createElement('button');
    groupButton.type = 'button';
    groupButton.className = group.traces.some((trace) => trace.id === selectedTraceId) ? 'trace trace-group active' : 'trace trace-group';
    groupButton.setAttribute('aria-expanded', String(expanded));
    const title = document.createElement('div');
    title.className = 'trace-title';
    title.textContent = `${expanded ? '▾' : '▸'} ${latest.method} ${latest.normalizedPath} ×${group.traces.length}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${latest.status ?? 'live'} · ${formatTraceTime(latest.startedAt)}`;
    meta.title = meta.textContent;
    groupButton.append(title, meta);
    groupButton.addEventListener('click', () => {
      if (expanded) expandedTraceGroups.delete(group.key);
      else expandedTraceGroups.add(group.key);
      renderTraces();
    });
    root.append(groupButton);
    if (expanded) {
      for (const trace of group.traces) root.append(traceButton(trace, true));
    }
  }
}

function traceButton(trace, child = false) {
  const summary = traceListMeta(trace);
  const problems = traceProblems(trace);
  const card = document.createElement('div');
  card.className = trace.id === selectedTraceId ? 'trace active' : 'trace';
  if (child) card.classList.add('trace-child');
  if (trace.pinned) card.classList.add('pinned');
  if (problems.bad) card.classList.add('problem');
  else if (problems.slow) card.classList.add('slow');
  const pin = button('', (event) => {
    event.stopPropagation();
    togglePin(trace);
  }, { className: trace.pinned ? 'pin-toggle on' : 'pin-toggle' });
  pin.append(pinGlyph(trace.pinned));
  pin.setAttribute('aria-label', trace.pinned ? 'Unpin trace' : 'Pin trace');
  pin.title = trace.pinned ? 'Unpin this trace' : 'Keep this trace on screen';
  pin.setAttribute('aria-pressed', String(Boolean(trace.pinned)));
  const head = document.createElement('div');
  head.className = 'trace-head';
  const method = document.createElement('span');
  method.className = 'trace-method';
  method.textContent = summary.method;
  head.append(method);
  const title = document.createElement('div');
  title.className = 'trace-title';
  title.textContent = summary.path;
  title.title = summary.path;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const bits = [summary.status ?? 'live'];
  if (problems.slow) bits.push('slow');
  bits.push(formatTraceTime(summary.startedAt));
  meta.textContent = bits.join(' · ');
  meta.title = meta.textContent;
  card.append(pin, head, title, meta);
  card.addEventListener('click', (event) => {
    if (event.target.closest('.pin-toggle')) return;
    selectTrace(trace.id);
  });
  return card;
}

const PIN_PATH = 'M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z';
const PIN_OUTLINE_PATH = 'M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4zm3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z';

function pinGlyph(filled) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', filled ? PIN_PATH : PIN_OUTLINE_PATH);
  path.setAttribute('fill', 'currentColor');
  icon.append(path);
  return icon;
}

function togglePin(trace) {
  const pinned = !trace.pinned;
  trace.pinned = pinned;
  follow = false;
  selectedTraceId = trace.id;
  renderTraces();
  renderDiagram();
  renderInspector();
  void post(`/api/traces/${encodeURIComponent(trace.id)}/pin`, { pinned }).catch(() => {
    trace.pinned = !pinned;
    renderTraces();
  });
}

function selectTrace(traceId, spanId = null, kind = null) {
  follow = false;
  logNote = '';
  selectedTraceId = traceId;
  selectedSpanId = spanId;
  selectedSpanKind = kind;
  renderTraces();
  renderDiagram();
  renderInspector();
  renderLogs({ revealRelated: true });
}

function shownTrace(traceId = selectedTraceId) {
  const trace = state.traces.find((item) => item.id === traceId);
  if (!trace || !isListedTrace(trace)) return null;
  return trace;
}

function selectedSpan(trace = shownTrace()) {
  if (!trace) return null;
  return trace.spans.find((span) => span.id === selectedSpanId) || trace.spans[0] || null;
}

function isListedTrace(trace) {
  return state.control.captureDebug || !isDebuggerTrace(trace);
}

function formatTraceTime(value) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function statusClass(status) {
  const code = Number(status);
  if (!Number.isInteger(code) || code < 100 || code > 599) return '';
  return `${Math.floor(code / 100)}xx`;
}

function traceMatchesFilters(trace) {
  if (traceListFilters.status && !(trace.spans || []).some((span) => statusClass(span.status) === traceListFilters.status)) return false;
  if (traceListFilters.slow && !traceProblems(trace).slow) return false;
  if (traceListFilters.pinned && !trace.pinned) return false;
  return true;
}

function syncTraceFilters() {
  const toggle = $('trace-filters-toggle');
  const active = Boolean(traceListFilters.status || traceListFilters.slow || traceListFilters.pinned);
  toggle.textContent = '▾';
  toggle.setAttribute('aria-expanded', String(traceFiltersOpen));
  toggle.classList.toggle('has-filters', active);
  $('trace-filters').hidden = !traceFiltersOpen;
}

function filteredTraces() {
  const input = $('trace-search');
  let visible = state.traces.filter(isListedTrace).filter(traceMatchesFilters);
  if (!traceFilter) {
    input.removeAttribute('aria-invalid');
    return visible;
  }
  try {
    const expression = new RegExp(traceFilter, 'i');
    input.removeAttribute('aria-invalid');
    return visible.filter((trace) => trace.spans.some((span) => expression.test([
      span.method, span.path, span.from, span.to,
    ].join(' '))));
  } catch {
    input.setAttribute('aria-invalid', 'true');
    return [];
  }
}

function renderHeld() {
  const root = $('held');
  root.replaceChildren();
  if (!state.gates.length) {
    root.textContent = state.control.mode === 'step'
      ? 'Stepping — waiting for the next request.'
      : 'Running';
    return;
  }
  const label = document.createElement('strong');
  label.textContent = `Held ${state.gates.length}: ${state.gates[0].label}`;
  root.append(label);
}

const diagramView = { x: 0, y: 0, scale: 1, traceId: null, userMoved: false };
let diagramDrag = null;

function fitDiagram(svg) {
  const root = $('diagram');
  const viewWidth = root.clientWidth;
  const viewHeight = root.clientHeight;
  const contentWidth = svg.width.baseVal.value;
  const contentHeight = svg.height.baseVal.value;
  if (!viewWidth || !viewHeight || !contentWidth || !contentHeight) return;
  const fit = Math.min((viewWidth - 80) / contentWidth, (viewHeight - 80) / contentHeight);
  const scale = Math.min(Math.max(fit, 1), 2.2) * 0.8;
  diagramView.scale = scale;
  diagramView.x = (viewWidth - contentWidth * scale) / 2;
  diagramView.y = contentHeight * scale < viewHeight - 48
    ? (viewHeight - contentHeight * scale) / 2
    : 28;
}

function applyDiagramTransform(svg = $('diagram').querySelector('svg')) {
  if (!svg) return;
  svg.style.transform = `translate(${diagramView.x}px, ${diagramView.y}px) scale(${diagramView.scale})`;
}

function placeDiagram(svg) {
  if (!svg.isConnected) return;
  if (!$('diagram').clientWidth || !$('diagram').clientHeight) {
    requestAnimationFrame(() => placeDiagram(svg));
    return;
  }
  if (!diagramView.userMoved) fitDiagram(svg);
  applyDiagramTransform(svg);
}

function bindDiagramViewport() {
  const root = $('diagram');
  root.addEventListener('wheel', (event) => {
    const svg = root.querySelector('svg');
    if (!svg) return;
    event.preventDefault();
    const rect = root.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const next = Math.min(2.6, Math.max(0.4, diagramView.scale * Math.exp(-event.deltaY * 0.0015)));
    const ratio = next / diagramView.scale;
    diagramView.x = pointerX - (pointerX - diagramView.x) * ratio;
    diagramView.y = pointerY - (pointerY - diagramView.y) * ratio;
    diagramView.scale = next;
    diagramView.userMoved = true;
    applyDiagramTransform(svg);
  }, { passive: false });
  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !root.querySelector('svg')) return;
    if (event.target.closest('.hit')) return;
    diagramDrag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: diagramView.x,
      originY: diagramView.y,
      moved: false,
    };
  });
  root.addEventListener('pointermove', (event) => {
    if (!diagramDrag || diagramDrag.id !== event.pointerId) return;
    const dx = event.clientX - diagramDrag.x;
    const dy = event.clientY - diagramDrag.y;
    if (!diagramDrag.moved && Math.hypot(dx, dy) < 5) return;
    if (!diagramDrag.moved) {
      try { root.setPointerCapture(event.pointerId); } catch { /* drag still tracks if capture is unavailable */ }
    }
    diagramDrag.moved = true;
    diagramView.userMoved = true;
    diagramView.x = diagramDrag.originX + dx;
    diagramView.y = diagramDrag.originY + dy;
    root.classList.add('panning');
    applyDiagramTransform();
  });
  const endDrag = (event) => {
    if (!diagramDrag || diagramDrag.id !== event.pointerId) return;
    diagramDrag = null;
    root.classList.remove('panning');
  };
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);
}

function renderDiagram() {
  const root = $('diagram');
  const trace = shownTrace();
  root.replaceChildren();
  if (!trace) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = sampleError
      ? `Could not send the sample request: ${sampleError}`
      : state.demo
        ? 'Send the sample request to see the flow.'
        : 'Start a configured service, or scan and attach to a running Node.js service.';
    if (sampleError) empty.classList.add('error');
    root.append(empty);
    return;
  }
  const spans = [...trace.spans].sort((a, b) => a.startedAt - b.startedAt);
  const names = [];
  const add = (name) => { if (name && !names.includes(name)) names.push(name); };
  for (const span of spans) { add(span.from); add(span.to); }
  const rows = [];
  for (const span of spans) {
    rows.push({ kind: 'request', span });
    if (span.endedAt || span.status || span.responseBody || span.hold === 'response') {
      rows.push({ kind: 'response', span });
    }
  }
  const budgetId = budgetSpanId(spans);
  const actors = names.map((name) => ({ name, ...actorLabel(name) }));
  const layout = layoutDiagramActors(actors, spans, budgetId);
  const rowStart = layout.lineY + 46;
  const height = rowStart + 6 + rows.length * 48;
  const { width } = layout;
  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}` });
  const xOf = (name) => layout.laid.find((actor) => actor.name === name)?.x ?? 0;
  layout.laid.forEach((actor) => {
    const x = actor.x;
    const service = state.services.find((item) => item.name === actor.name);
    svg.append(diagramText('actor', x, layout.titleY, actor.titleLines, TITLE_LINE));
    if (actor.hintLines.length) svg.append(diagramText('actor-hint', x, actor.hintY, actor.hintLines, HINT_LINE));
    svg.append(svgEl('line', { class: 'lifeline', x1: x, x2: x, y1: layout.lineY, y2: height - 10 }));
    if (service) {
      const firstLine = textWidth(actor.titleLines[0], ACTOR_FONT);
      svg.append(svgEl('circle', { cx: x - firstLine / 2 - 10, cy: layout.titleY - 4, r: 4, fill: service.color }));
    }
  });
  rows.forEach((row, index) => {
    const y = rowStart + index * 48;
    const from = row.kind === 'request' ? row.span.from : row.span.to;
    const to = row.kind === 'request' ? row.span.to : row.span.from;
    const x1 = xOf(from);
    const x2 = xOf(to);
    const paused = (row.kind === 'request' && row.span.hold === 'request') || (row.kind === 'response' && row.span.hold === 'response');
    const marks = spanMarks(row.span, budgetId);
    const selected = selectedSpanId === row.span.id && selectedSpanKind === row.kind;
    const hit = svgEl('rect', {
      class: selected ? 'hit selected' : 'hit',
      x: Math.min(x1, x2) - 12,
      y: y - 28,
      width: Math.max(Math.abs(x2 - x1) + 24, 32),
      height: 42,
      rx: 6,
      'data-span-id': row.span.id,
      'data-kind': row.kind,
    });
    hit.addEventListener('click', () => {
      follow = false;
      selectedSpanId = row.span.id;
      selectedSpanKind = row.kind;
      updateDiagramSelection();
      renderInspector();
      renderLogs({ revealRelated: true });
    });
    const dir = x2 >= x1 ? 1 : -1;
    const arrowClass = ['arrow', row.kind];
    if (paused) arrowClass.push('paused');
    if (marks.bad) arrowClass.push('bad');
    if (marks.budget) arrowClass.push('budget');
    const arrow = svgEl('line', {
      class: arrowClass.join(' '),
      x1,
      x2: x2 - dir * 8,
      y1: y,
      y2: y,
      'marker-end': 'url(#head)',
    });
    const text = diagramArrowText(row.span, row.kind, marks);
    const labelClass = ['label'];
    if (marks.bad) labelClass.push('bad');
    if (marks.budget) labelClass.push('budget');
    const label = svgEl('text', {
      class: labelClass.join(' '),
      x: (x1 + x2) / 2,
      y: y - 8,
      'text-anchor': 'middle',
    }, text);
    svg.append(hit, arrow, label);
  });
  const defs = svgEl('defs');
  defs.innerHTML = '<marker id="head" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#efe7d2"/></marker>';
  svg.prepend(defs);
  root.append(svg);
  if (diagramView.traceId !== trace.id) {
    diagramView.traceId = trace.id;
    diagramView.userMoved = false;
  }
  placeDiagram(svg);
}

function updateDiagramSelection() {
  for (const hit of $('diagram').querySelectorAll('.hit')) {
    hit.classList.toggle('selected', hit.dataset.spanId === selectedSpanId && hit.dataset.kind === selectedSpanKind);
  }
}

function renderInspector() {
  const root = $('inspector');
  const trace = shownTrace();
  const span = selectedSpan(trace);
  root.replaceChildren();
  if (!span) {
    const empty = document.createElement('div');
    empty.className = 'meta';
    empty.textContent = 'Select a request to inspect it.';
    root.append(empty);
    return;
  }
  const title = document.createElement('h2');
  title.textContent = `${span.method} ${span.path}`;
  const badge = document.createElement('span');
  badge.className = spanIsBad(span) ? 'badge bad' : 'badge ok';
  badge.textContent = span.error ? span.error : (span.status ? String(span.status) : 'waiting');
  const duration = spanDuration(span);
  const budgetId = budgetSpanId(trace.spans);
  const timing = document.createElement('span');
  timing.className = 'hop-duration';
  timing.textContent = duration == null
    ? 'In flight'
    : `${duration}ms${span.id === budgetId ? ' · slowest hop' : ''}`;
  const statusRow = document.createElement('div');
  statusRow.className = 'status-row';
  statusRow.append(badge, timing);
  const request = requestDetails(span, trace);
  const titleRow = document.createElement('div');
  titleRow.className = 'inspector-title';
  const titleGroup = document.createElement('div');
  titleGroup.append(title, statusRow);
  titleRow.append(titleGroup, copyButton('Copy all request details as JSON', () => JSON.stringify(request, null, 2), 'copy-all'));
  root.append(titleRow);
  root.append(detailSection('Route', `${span.from} → ${span.to}`, request.route));
  root.append(detailSection('Request headers', headerText(span.requestHeaders), request.request.headers));
  root.append(detailSection('Request body', pretty(span.requestBody), request.request.body));
  root.append(detailSection('Response headers', headerText(span.responseHeaders), request.response.headers));
  root.append(detailSection('Response body', pretty(span.responseBody), request.response.body));
  root.append(hopLogs(trace, span));
}

function renderLogs({ stickToEnd = false, revealRelated = false } = {}) {
  const title = $('log-title');
  const selectedService = state.services.find((service) => service.name === logService);
  title.textContent = selectedService ? `${serviceDisplayName(selectedService)} logs` : 'All logs';
  const note = $('log-note');
  if (note) note.textContent = logNote;
  const entries = state.logEntries.filter((entry) => !logService || entry.service === logService);
  const view = $('log-view');
  const previous = view.scrollTop;
  const atEnd = view.scrollHeight - view.scrollTop - view.clientHeight < 24;
  view.replaceChildren();
  const trace = shownTrace();
  const span = selectedSpan(trace);
  for (const entry of entries) {
    const located = locateLog(entry);
    const related = trace && span && logMatchesSpan(entry, trace, span);
    const line = document.createElement('button');
    line.type = 'button';
    line.className = 'log-line';
    if (related && highlightRelatedLogs) line.classList.add('log-related');
    if (related) line.dataset.related = 'true';
    if (located) line.classList.add('log-linked');
    line.title = located ? 'Open the request for this log' : 'No request matched this log';
    const prefix = document.createElement('span');
    prefix.className = 'log-prefix';
    const service = state.services.find((item) => item.name === entry.service);
    prefix.textContent = `[${service ? serviceDisplayName(service) : entry.service}]`;
    if (service?.color) prefix.style.color = service.color;
    line.append(prefix, document.createTextNode(` ${entry.line}`));
    line.addEventListener('click', () => openLog(entry));
    view.append(line);
  }
  if (revealRelated) view.querySelector('[data-related="true"]')?.scrollIntoView({ block: 'nearest' });
  else if (stickToEnd && atEnd) view.scrollTop = view.scrollHeight;
  else view.scrollTop = previous;
}

function hopLogs(trace, span) {
  const section = document.createElement('section');
  section.className = 'detail-section';
  section.append(heading('Hop logs'));
  const matches = state.logEntries.filter((entry) => logMatchesSpan(entry, trace, span));
  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'meta';
    empty.textContent = 'Click a log line to open its request.';
    section.append(empty);
    return section;
  }
  const list = document.createElement('div');
  list.className = 'hop-logs';
  for (const entry of matches.slice(-HOP_LOG_LIMIT)) {
    const line = document.createElement('button');
    line.type = 'button';
    line.textContent = `[${entry.service}] ${entry.line}`;
    line.addEventListener('click', () => openLog(entry));
    list.append(line);
  }
  section.append(list);
  return section;
}

function spanInvolves(span, service) {
  return service === span.from || service === span.to;
}

function logOverlaps(entry, span) {
  if (!entry.at || !spanInvolves(span, entry.service)) return false;
  const end = span.endedAt || Date.now();
  return entry.at >= span.startedAt - LOG_MATCH_PAD_MS && entry.at <= end + LOG_MATCH_PAD_MS;
}

function logMatchesSpan(entry, trace, span) {
  if (entry.traceId && entry.traceId !== trace.id) return false;
  if (entry.traceId && entry.spanId) return entry.spanId === span.id;
  if (entry.traceId) return spanInvolves(span, entry.service);
  return logOverlaps(entry, span);
}

function openLog(entry) {
  const located = locateLog(entry);
  if (!located) {
    logNote = entry.traceId
      ? 'That request is no longer in the list.'
      : 'No request matched this log line.';
    renderLogs();
    return;
  }
  logNote = '';
  if (!traceMatchesFilters(located.trace)) {
    traceListFilters.status = '';
    traceListFilters.slow = false;
    traceListFilters.pinned = false;
    $('trace-status-filter').value = '';
    $('trace-slow-filter').checked = false;
    $('trace-pinned-filter').checked = false;
    syncTraceFilters();
  }
  const span = located.span;
  const kind = span && (span.endedAt || span.status || span.responseBody) ? 'response' : 'request';
  selectTrace(located.trace.id, span?.id || null, span ? kind : null);
}

function locateLog(entry) {
  if (entry.traceId) {
    const trace = state.traces.find((item) => item.id === entry.traceId);
    if (!trace) return null;
    const span = (entry.spanId && trace.spans.find((item) => item.id === entry.spanId))
      || trace.spans.find((item) => spanInvolves(item, entry.service))
      || trace.spans[0]
      || null;
    return { trace, span };
  }
  let best = null;
  let bestDistance = Infinity;
  for (const trace of state.traces) {
    for (const span of trace.spans) {
      if (!logOverlaps(entry, span)) continue;
      const end = span.endedAt || Date.now();
      const distance = entry.at < span.startedAt ? span.startedAt - entry.at : Math.max(0, entry.at - end);
      if (distance >= bestDistance) continue;
      best = { trace, span };
      bestDistance = distance;
    }
  }
  return best;
}
function selectServiceLogs(name) {
  logService = logService === name ? null : name;
  renderServices();
  renderLogs();
}

function heading(text) {
  const node = document.createElement('h3');
  node.textContent = text;
  return node;
}
function detailSection(label, text, value) {
  const section = document.createElement('section');
  section.className = 'detail-section';
  const header = document.createElement('div');
  header.className = 'detail-heading';
  header.append(heading(label), copyButton(`Copy ${label.toLowerCase()}`, () => formatCopyValue(value)));
  section.append(header, pre(text));
  return section;
}
function requestDetails(span, trace) {
  return {
    traceId: trace?.id || null,
    spanId: span.id || null,
    parentSpanId: span.parentId || null,
    method: span.method,
    path: span.path,
    route: { from: span.from, to: span.to },
    request: {
      headers: span.requestHeaders || {},
      body: parseBody(span.requestBody),
    },
    response: {
      status: span.status ?? null,
      headers: span.responseHeaders || {},
      body: parseBody(span.responseBody),
    },
    timing: {
      startedAt: span.startedAt ?? null,
      endedAt: span.endedAt ?? null,
      durationMs: span.endedAt ? span.endedAt - span.startedAt : null,
    },
    error: span.error || null,
    state: span.hold || null,
  };
}
function parseBody(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}
function formatCopyValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
function copyButton(label, getText, className = '') {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = `copy-button ${className}`.trim();
  node.setAttribute('aria-label', label);
  node.title = label;
  node.append(copyIcon());
  node.addEventListener('click', async () => {
    const copied = await copyText(getText());
    if (!copied) return;
    node.classList.add('copied');
    node.setAttribute('aria-label', 'Copied');
    node.title = 'Copied';
    setTimeout(() => {
      node.classList.remove('copied');
      node.setAttribute('aria-label', label);
      node.title = label;
    }, 1400);
  });
  return node;
}
function copyIcon() {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<rect x="8" y="8" width="11" height="12" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2"></path>';
  return icon;
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  }
}
function pre(text) {
  const node = document.createElement('pre');
  node.textContent = text || '—';
  return node;
}
function headerText(headers) {
  const entries = Object.entries(headers || {});
  if (!entries.length) return '—';
  return entries.map(([key, value]) => `${key}: ${value}`).join('\n');
}
function pretty(text) {
  if (!text) return '—';
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}
function shortPath(value) {
  const path = value || '/';
  return path.length > 42 ? `${path.slice(0, 20)}…${path.slice(-18)}` : path;
}
function button(label, onClick, options = {}) {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  if (options.className) node.className = options.className;
  if (options.on) node.dataset.on = options.on;
  if (options.disabled) node.disabled = true;
  node.addEventListener('click', onClick);
  return node;
}
function svgEl(name, attrs, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
  if (text) node.textContent = text;
  return node;
}

function diagramText(className, x, y, lines, lineHeight) {
  const text = svgEl('text', { class: className, x, y, 'text-anchor': 'middle' });
  lines.forEach((line, index) => {
    text.append(svgEl('tspan', { x, dy: index ? lineHeight : 0 }, line));
  });
  return text;
}

function visibleListeners() {
  const query = scanQuery.trim().toLowerCase();
  return state.discovered
    .filter((listener) => {
      if (!query) return true;
      return String(listener.port).includes(query)
        || String(listener.pid).includes(query)
        || (listener.repoPath || '').toLowerCase().includes(query)
        || (listener.workingDirectory || '').toLowerCase().includes(query)
        || (listener.command || '').toLowerCase().includes(query);
    })
    .sort((a, b) => a.port - b.port || a.pid - b.pid);
}

function closeScanModal() {
  scanResults = null;
  scanModal?.remove();
  scanModal = null;
}

function syncScanButton() {
  const scan = $('scan');
  scan.disabled = scanning;
  scan.textContent = scanning ? 'Scanning' : 'Scan';
}

function renderScanResults() {
  if (!scanResults) return;
  scanResults.replaceChildren();
  if (scanning) {
    const status = document.createElement('div');
    status.className = 'meta discovery-status';
    status.textContent = 'Scanning ports…';
    scanResults.append(status);
    return;
  }
  if (scanNote && !state.discovered.length) {
    const status = document.createElement('div');
    status.className = 'meta discovery-status';
    status.textContent = scanNote;
    scanResults.append(status);
    return;
  }
  const listeners = visibleListeners();
  if (!listeners.length) {
    const status = document.createElement('div');
    status.className = 'meta discovery-status';
    status.textContent = state.discovered.length ? 'No matching listeners.' : 'No other Node.js listeners.';
    scanResults.append(status);
    return;
  }
  for (const listener of listeners) {
    const row = document.createElement('div');
    row.className = 'discovered-listener';
    const details = document.createElement('div');
    details.className = 'listener-details';
    const label = document.createElement('div');
    label.className = 'name';
    label.textContent = `:${listener.port}`;
    const repoName = listener.repo || null;
    if (repoName) {
      const repo = document.createElement('span');
      repo.className = 'repo-badge';
      repo.textContent = repoName;
      label.append(repo);
    }
    const command = document.createElement('div');
    command.className = 'meta command';
    const location = listener.repoPath || listener.workingDirectory || `pid ${listener.pid}`;
    command.textContent = location;
    command.title = location;
    details.append(label, command);
    const attaching = pendingDiscoveredAttachments.has(listener.port);
    row.append(details, button(attaching ? 'Attaching…' : listener.attachable ? 'Attach' : 'Not Node', () => { void attachDiscovered(listener.port); }, { disabled: attaching || !listener.attachable }));
    scanResults.append(row);
  }
}

function openScanModal() {
  syncScanButton();
  if (scanModal) return;
  scanModal = document.createElement('div');
  scanModal.id = 'scan-modal';
  scanModal.className = 'modal-backdrop';
  scanModal.addEventListener('pointerdown', (event) => {
    if (event.target === scanModal) closeScanModal();
  });
  const dialog = document.createElement('div');
  dialog.className = 'scan-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'scan-title');
  const head = document.createElement('div');
  head.className = 'scan-dialog-head';
  const title = document.createElement('strong');
  title.id = 'scan-title';
  title.textContent = 'Ports';
  head.append(title, button('Close', closeScanModal, { className: 'text' }));
  const search = document.createElement('div');
  search.className = 'scan-search';
  const input = document.createElement('input');
  input.id = 'scan-search';
  input.type = 'search';
  input.placeholder = 'Filter Node.js port or repository';
  input.value = scanQuery;
  input.addEventListener('input', () => {
    scanQuery = input.value;
    renderScanResults();
  });
  search.append(input);
  scanResults = document.createElement('div');
  scanResults.id = 'scan-results';
  scanResults.className = 'scan-results';
  dialog.append(head, search, scanResults);
  scanModal.append(dialog);
  document.body.append(scanModal);
  input.focus();
  renderScanResults();
}

async function scanPorts() {
  if (scanning) return;
  scanning = true;
  scanNote = '';
  scanQuery = '';
  const existing = $('scan-search');
  if (existing) existing.value = '';
  openScanModal();
  try {
    const response = await fetch('/api/discovery/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-traceflow-token': SESSION_TOKEN },
      body: '{}',
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) scanNote = body.error || 'Could not scan ports';
    else if (Array.isArray(body.listeners)) {
      state.discovered = body.listeners;
      scanNote = body.listeners.length ? '' : 'No other Node.js listeners.';
    }
  } catch {
    scanNote = 'Could not scan ports';
  } finally {
    scanning = false;
    syncScanButton();
    renderScanResults();
  }
}

async function sendSample() {
  if (samplePending) return;
  samplePending = true;
  sampleError = '';
  renderTransport();
  renderDiagram();
  try {
    await post(state.sampleUrl);
  } catch (error) {
    sampleError = error.message || 'Request failed';
  } finally {
    samplePending = false;
    renderTransport();
    if (sampleError) renderDiagram();
  }
}

bindDiagramViewport();
$('clear').addEventListener('click', () => post('/api/clear'));
$('scan').addEventListener('click', () => { void scanPorts(); });
$('settings-toggle').addEventListener('click', () => {
  settingsOpen = !settingsOpen;
  renderSettings();
  if (settingsOpen) $('settings-panel').querySelector('select, input')?.focus();
});
document.addEventListener('pointerdown', (event) => {
  const insideMenu = event.target.closest('.service-menu, .service-menu-toggle');
  if (openServiceMenu && !insideMenu) {
    openServiceMenu = null;
    renderServices();
  }
  if (!settingsOpen || event.target.closest('.settings')) return;
  settingsOpen = false;
  renderSettings();
});
$('clear-logs').addEventListener('click', () => {
  state.logEntries = [];
  renderLogs();
  void post('/api/clear-logs').catch(() => {});
});
$('trace-search').addEventListener('input', (event) => {
  traceFilter = event.target.value.trim();
  renderTraces();
});
$('trace-filters-toggle').addEventListener('click', () => {
  traceFiltersOpen = !traceFiltersOpen;
  syncTraceFilters();
});
$('trace-status-filter').addEventListener('change', (event) => {
  traceListFilters.status = event.target.value;
  syncTraceFilters();
  renderTraces();
});
$('trace-slow-filter').addEventListener('change', (event) => {
  traceListFilters.slow = event.target.checked;
  syncTraceFilters();
  renderTraces();
});
$('trace-pinned-filter').addEventListener('change', (event) => {
  traceListFilters.pinned = event.target.checked;
  syncTraceFilters();
  renderTraces();
});
$('log-title').addEventListener('click', () => {
  logService = null;
  renderServices();
  renderLogs();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && settingsOpen) {
    event.preventDefault();
    settingsOpen = false;
    renderSettings();
    $('settings-toggle').focus();
    return;
  }
  if (event.key === 'Escape' && traceFiltersOpen) {
    event.preventDefault();
    traceFiltersOpen = false;
    syncTraceFilters();
    $('trace-filters-toggle').focus();
    return;
  }
  if (event.key === 'Escape' && scanModal) {
    event.preventDefault();
    closeScanModal();
    return;
  }
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (event.code === 'Space') { event.preventDefault(); post('/api/step'); }
  if (event.key === 'p') post('/api/pause');
  if (event.key === 'r') post('/api/resume');
});

initializeLogResizer();
initializeInspectorResizer();
connect();
