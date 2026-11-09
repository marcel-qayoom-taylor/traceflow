/* global mermaid */
const SESSION_TOKEN = document.querySelector('meta[name="traceflow-token"]')?.content || '';
// v2 resets everyone to the Colour theme and drops the old hand-drawn look.
const SETTINGS_PREFIX = 'traceflow.diagrams.v2.';
const EDITOR_WIDTH_KEY = 'traceflow.diagrams.editor-width';
const SERVICE_ALIASES_KEY = 'traceflow.service-aliases';
const EDITOR_MIN_WIDTH = 240;
const PREVIEW_MIN_WIDTH = 320;
const MAX_CANVAS_SIDE = 16384;
const TEMPLATES = {
  sequence: `sequenceDiagram
  title Checkout
  participant browser as Browser
  participant api as Order API
  participant payments as Payment

  browser->>+api: POST /api/orders
  api->>+payments: POST /api/payments
  payments-->>-api: 201 · 120ms
  api-->>-browser: 201 · 180ms
`,
  flowchart: `flowchart LR
  request[Request] --> valid{Valid?}
  valid -->|yes| save[Save order]
  valid -->|no| reject[Reject]
`,
  blank: '',
};

const $ = (id) => document.getElementById(id);
const els = {
  list: $('diagram-list'),
  dir: $('diagram-dir'),
  name: $('diagram-name'),
  source: $('source'),
  saveState: $('save-state'),
  remove: $('delete-diagram'),
  error: $('render-error'),
  preview: $('preview'),
  toast: $('toast'),
  theme: $('theme'),
  look: $('look'),
  pngScale: $('png-scale'),
  transparent: $('transparent'),
  fontSize: $('font-size'),
  wrap: $('wrap'),
  settingsToggle: $('settings-toggle'),
  settingsPanel: $('settings-panel'),
  filter: $('diagram-filter'),
  traces: $('trace-list'),
  resizer: $('editor-resizer'),
  highlight: $('source-highlight'),
  completions: $('completions'),
  autocomplete: $('autocomplete'),
  collapseRepeats: $('collapse-repeats'),
  traceNotes: $('trace-notes'),
};

let diagrams = [];
let current = null; // { name, savedSource, updatedAt }
let saveTimer = null;
let renderTimer = null;
let saving = Promise.resolve();
let renderSeq = 0;
let toastTimer = null;
let paper = '#ffffff';
let links = []; // source line ↔ preview elements, rebuilt after every render
let errorLine = 0;
const view = { x: 0, y: 0, scale: 1, userMoved: false };

function readSetting(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function writeSetting(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

async function request(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-traceflow-token': SESSION_TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

const diagramUrl = (name) => `/api/diagrams/${encodeURIComponent(name)}`;

function relativeTime(ms) {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

function showToast(message, { error = false } = {}) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.toggle('error', error);
  els.toast.hidden = false;
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, error ? 4000 : 1600);
}

function setSaveState(text, error = false) {
  els.saveState.textContent = text;
  els.saveState.classList.toggle('error', error);
}

// ---------- list ----------

async function loadList() {
  const data = await request('/api/diagrams');
  diagrams = data.diagrams;
  els.dir.textContent = `Saved as .mmd files in ${data.dir}. Set diagramsDir in traceflow.config.json to change it.`;
  renderList();
  return diagrams;
}

function listItem(title, detail, onClick, className = 'diagram-item') {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = className;
  const name = document.createElement('strong');
  name.textContent = title;
  const meta = document.createElement('span');
  meta.textContent = detail;
  item.append(name, meta);
  item.addEventListener('click', onClick);
  return item;
}

function emptyNote(text) {
  const empty = document.createElement('div');
  empty.className = 'diagram-empty';
  empty.textContent = text;
  return empty;
}

function renderList() {
  const query = els.filter.value.trim().toLowerCase();
  const shown = diagrams.filter((diagram) => diagram.name.toLowerCase().includes(query));
  els.list.replaceChildren(...shown.map((diagram) => {
    const item = listItem(diagram.name, relativeTime(diagram.updatedAt), () => { void openDiagram(diagram.name); });
    item.setAttribute('aria-current', String(diagram.name === current?.name));
    return item;
  }));
  if (!shown.length) els.list.append(emptyNote(diagrams.length ? 'No diagrams match.' : 'No diagrams yet. Start one with New, or from a trace below.'));
}

async function loadTraces() {
  try {
    const { traces } = await request('/api/traces');
    els.traces.replaceChildren(...traces.slice(0, 12).map((trace) => {
      const status = trace.status ?? '…';
      const item = listItem(
        `${trace.method} ${trace.path}`,
        `${status} · ${trace.hops} hop${trace.hops === 1 ? '' : 's'} · ${new Date(trace.startedAt).toLocaleTimeString()}`,
        () => { void createFromTrace(trace.id); },
        'diagram-item trace',
      );
      item.title = trace.services.join(' → ');
      if (Number(trace.status) >= 400) item.querySelector('span').classList.add('bad');
      return item;
    }));
    if (!traces.length) els.traces.append(emptyNote('Captured traces show up here. Click one to turn it into a diagram.'));
  } catch { /* the list is optional */ }
}

// ---------- open / save ----------

function dirty() {
  return Boolean(current) && els.source.value !== current.savedSource;
}

async function openDiagram(name, { replaceHash = false } = {}) {
  if (current?.name === name) return;
  await flushSave();
  const data = await request(diagramUrl(name));
  current = { name: data.name, savedSource: data.source, updatedAt: data.updatedAt };
  setSource(data.source);
  els.name.value = data.name;
  setEditable(true);
  setSaveState('Saved');
  const hash = `#${encodeURIComponent(name)}`;
  if (location.hash !== hash) history[replaceHash ? 'replaceState' : 'pushState'](null, '', hash);
  document.title = `${name} · Traceflow Diagrams`;
  view.userMoved = false;
  renderList();
  void renderPreview();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  setSaveState(dirty() ? 'Unsaved' : 'Saved');
  saveTimer = setTimeout(() => { void flushSave(); }, 600);
}

function flushSave() {
  clearTimeout(saveTimer);
  saving = saving.then(async () => {
    if (!dirty()) return;
    const { name } = current;
    const source = els.source.value;
    setSaveState('Saving…');
    try {
      const result = await request(diagramUrl(name), { method: 'PUT', body: { source } });
      if (current?.name !== name) return;
      current.savedSource = source;
      current.updatedAt = result.updatedAt;
      const entry = diagrams.find((item) => item.name === name);
      if (entry) entry.updatedAt = result.updatedAt;
      diagrams.sort((a, b) => b.updatedAt - a.updatedAt);
      renderList();
      setSaveState(dirty() ? 'Unsaved' : 'Saved');
    } catch (err) {
      setSaveState(`Not saved: ${err.message}`, true);
    }
  });
  return saving;
}

async function createDiagram(template) {
  await flushSave();
  try {
    const created = await request('/api/diagrams', { method: 'POST', body: { name: 'untitled', source: TEMPLATES[template] ?? '' } });
    await loadList();
    await openDiagram(created.name);
    els.name.focus();
    els.name.select();
  } catch (err) {
    showToast(err.message, { error: true });
  }
}

function serviceAliases() {
  try { return JSON.parse(localStorage.getItem(SERVICE_ALIASES_KEY)) || {}; } catch { return {}; }
}

async function createFromTrace(id) {
  await flushSave();
  try {
    const created = await traceMermaid(id, { save: true });
    await loadList();
    await openDiagram(created.name);
  } catch (err) {
    showToast(err.message, { error: true });
  }
}

async function renameCurrent() {
  if (!current) return;
  const to = els.name.value.trim();
  if (!to || to === current.name) {
    els.name.value = current.name;
    return;
  }
  await flushSave();
  try {
    await request(`${diagramUrl(current.name)}/rename`, { method: 'POST', body: { to } });
    current.name = to;
    history.replaceState(null, '', `#${encodeURIComponent(to)}`);
    document.title = `${to} · Traceflow Diagrams`;
    await loadList();
  } catch (err) {
    els.name.value = current.name;
    showToast(err.message, { error: true });
  }
}

async function deleteCurrent() {
  if (!current || !confirm(`Delete “${current.name}”? This removes the .mmd file.`)) return;
  clearTimeout(saveTimer);
  const { name } = current;
  try {
    await request(diagramUrl(name), { method: 'DELETE' });
  } catch (err) {
    showToast(err.message, { error: true });
    return;
  }
  current = null;
  const remaining = await loadList();
  if (remaining.length) await openDiagram(remaining[0].name, { replaceHash: true });
  else showEmptyEditor();
}

function setEditable(editable) {
  for (const node of [els.source, els.name, els.remove]) node.disabled = !editable;
}

function showEmptyEditor() {
  current = null;
  setSource('');
  els.name.value = '';
  setEditable(false);
  setSaveState('');
  history.replaceState(null, '', location.pathname);
  els.preview.replaceChildren();
  els.error.hidden = true;
  renderList();
}

// Pick up edits made to the .mmd file elsewhere: another editor, an agent, or another tab.
async function syncFromDisk({ announce = false } = {}) {
  try {
    await loadList();
    if (!current || dirty()) return;
    const entry = diagrams.find((item) => item.name === current.name);
    if (!entry || entry.updatedAt <= current.updatedAt) return;
    const data = await request(diagramUrl(current.name));
    current.savedSource = data.source;
    current.updatedAt = data.updatedAt;
    // Keep the caret where it was rather than jumping to the end.
    const caret = els.source.selectionStart;
    setSource(data.source);
    els.source.setSelectionRange(caret, caret);
    void renderPreview();
    if (announce) showToast('Updated from disk');
  } catch { /* keep the current view */ }
}

// Draws a trace with the participant names and trace settings chosen in this browser.
function traceMermaid(id, { save = false } = {}) {
  return request(`/api/traces/${encodeURIComponent(id)}/mermaid`, {
    method: 'POST',
    body: { save, labels: serviceAliases(), collapseRepeats: els.collapseRepeats.checked, notes: els.traceNotes.checked },
  });
}

// ---------- render ----------

function initMermaid() {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: els.theme.value,
    look: els.look.value,
    // Plain SVG text keeps the canvas untainted so the PNG export works.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
  });
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => { void renderPreview(); }, 220);
}

async function renderPreview() {
  const seq = ++renderSeq;
  const source = els.source.value;
  if (!source.trim()) {
    els.preview.replaceChildren();
    els.error.hidden = true;
    return;
  }
  try {
    const { svg } = await mermaid.render(`traceflow-diagram-${seq}`, source);
    if (seq !== renderSeq) return;
    const canvas = document.createElement('div');
    canvas.className = 'preview-canvas';
    canvas.innerHTML = svg;
    const node = canvas.querySelector('svg');
    const { width, height } = svgSize(node);
    node.setAttribute('width', String(width));
    node.setAttribute('height', String(height));
    node.style.maxWidth = 'none';
    els.preview.replaceChildren(canvas);
    styleInlineCode(node);
    els.preview.classList.remove('stale');
    // The config now reflects the theme this render used, including one set by a %%{init}%% directive.
    paper = mermaid.mermaidAPI.getConfig().themeVariables?.background || '#ffffff';
    els.preview.style.setProperty('--paper', paper);
    els.error.hidden = true;
    setErrorLine(0);
    links = linkSource(node, source);
    showActiveLine();
    if (!view.userMoved) fit();
    else applyView();
  } catch (err) {
    if (seq !== renderSeq) return;
    els.preview.classList.add('stale');
    els.error.textContent = String(err?.message || err).trim();
    els.error.hidden = false;
    setErrorLine(Number(els.error.textContent.match(/line (\d+)/i)?.[1]) || 0);
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const CODE_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

// Mermaid labels have no inline code, so draw `backticked` text in a monospace pill ourselves.
// It edits the rendered SVG, which the PNG and SVG exports copy.
function styleInlineCode(svg) {
  for (const text of svg.querySelectorAll('text')) {
    // A label with an odd number of backticks is left as typed.
    const ticks = text.textContent.split('`').length - 1;
    if (ticks < 2 || ticks % 2) continue;
    // Flowcharts put each word in its own tspan, so a code span can cross several text nodes.
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let inCode = false;
    for (const node of nodes) {
      if (!inCode && !node.data.includes('`')) continue;
      const pieces = node.data.split('`').flatMap((part, index) => {
        if (index > 0) inCode = !inCode;
        if (!inCode || !part.trim()) return [part];
        // Keep spaces outside the pill so it hugs the code.
        const [, before, body, after] = part.match(/^(\s*)(.*?)(\s*)$/s);
        const code = document.createElementNS(SVG_NS, 'tspan');
        code.setAttribute('class', 'inline-code');
        code.setAttribute('style', `font-family: ${CODE_FONT}; font-size: 0.92em`);
        code.textContent = body;
        return [before, code, after];
      });
      node.replaceWith(...pieces.filter((piece) => piece !== ''));
    }
  }
  // Boxes need the final layout, so place them once every label is rewritten.
  for (const code of svg.querySelectorAll('tspan.inline-code')) {
    const text = code.closest('text');
    const box = code.getBBox();
    const pill = document.createElementNS(SVG_NS, 'rect');
    pill.setAttribute('class', 'inline-code-pill');
    for (const [name, value] of Object.entries({ x: box.x - 2, y: box.y - 1, width: box.width + 4, height: box.height + 2, rx: 4 })) {
      pill.setAttribute(name, String(value));
    }
    // Inline so diagram CSS such as `.node rect { stroke }` cannot restyle the pill.
    pill.setAttribute('style', `fill: ${getComputedStyle(text).fill}; fill-opacity: 0.1; stroke: none`);
    if (text.hasAttribute('transform')) pill.setAttribute('transform', text.getAttribute('transform'));
    text.before(pill);
  }
}

function svgSize(svg) {
  const box = svg.viewBox?.baseVal;
  if (box && box.width && box.height) return { width: Math.ceil(box.width), height: Math.ceil(box.height) };
  const rect = svg.getBBox();
  return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
}

// ---------- pan / zoom ----------

function previewSvg() {
  return els.preview.querySelector('.preview-canvas svg');
}

function applyView() {
  const canvas = els.preview.querySelector('.preview-canvas');
  if (!canvas) return;
  canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  // Keeps click targets about the same size on screen however far the preview is zoomed out.
  canvas.style.setProperty('--hit-reach', `${14 / view.scale}px`);
}

function fit() {
  const svg = previewSvg();
  if (!svg) return;
  const { width, height } = svgSize(svg);
  const box = els.preview.getBoundingClientRect();
  const pad = 32;
  view.scale = Math.min((box.width - pad * 2) / width, (box.height - pad * 2) / height, 1.5);
  if (!Number.isFinite(view.scale) || view.scale <= 0) view.scale = 1;
  view.x = (box.width - width * view.scale) / 2;
  view.y = Math.max(pad, (box.height - height * view.scale) / 2);
  view.userMoved = false;
  applyView();
}

function zoomAt(factor, clientX, clientY) {
  const box = els.preview.getBoundingClientRect();
  const px = clientX - box.left;
  const py = clientY - box.top;
  const next = Math.min(8, Math.max(0.1, view.scale * factor));
  view.x = px - ((px - view.x) * next) / view.scale;
  view.y = py - ((py - view.y) * next) / view.scale;
  view.scale = next;
  view.userMoved = true;
  applyView();
}

function zoomCentre(factor) {
  const box = els.preview.getBoundingClientRect();
  zoomAt(factor, box.left + box.width / 2, box.top + box.height / 2);
}

els.preview.addEventListener('wheel', (event) => {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey || Math.abs(event.deltaY) > Math.abs(event.deltaX) * 2) {
    zoomAt(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)), event.clientX, event.clientY);
  } else {
    view.x -= event.deltaX;
    view.y -= event.deltaY;
    view.userMoved = true;
    applyView();
  }
}, { passive: false });

els.preview.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !previewSvg()) return;
  // Stops the drag from selecting the diagram's text.
  event.preventDefault();
  const start = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, target: event.target };
  els.preview.setPointerCapture(event.pointerId);
  els.preview.classList.add('panning');
  const move = (next) => {
    view.x = start.vx + next.clientX - start.x;
    view.y = start.vy + next.clientY - start.y;
    view.userMoved = true;
    applyView();
  };
  const end = (last) => {
    els.preview.classList.remove('panning');
    // A press that barely moved is a click: jump to the source line of what was clicked.
    if (last.type === 'pointerup' && Math.hypot(last.clientX - start.x, last.clientY - start.y) < 4) {
      const link = linkFor(start.target);
      if (link) selectLine(link.line);
    }
    els.preview.removeEventListener('pointermove', move);
    els.preview.removeEventListener('pointerup', end);
    els.preview.removeEventListener('pointercancel', end);
  };
  els.preview.addEventListener('pointermove', move);
  els.preview.addEventListener('pointerup', end);
  els.preview.addEventListener('pointercancel', end);
});
els.preview.addEventListener('dblclick', fit);
$('zoom-in').addEventListener('click', () => zoomCentre(1.25));
$('zoom-out').addEventListener('click', () => zoomCentre(0.8));
$('zoom-fit').addEventListener('click', fit);
new ResizeObserver(() => { if (!view.userMoved) fit(); }).observe(els.preview);

// ---------- export ----------

function exportBackground() {
  return els.transparent.checked ? null : paper;
}

function exportSvgText() {
  const svg = previewSvg();
  if (!svg) throw new Error('Nothing to export yet. Fix the diagram errors first.');
  const { width, height } = svgSize(svg);
  const clone = svg.cloneNode(true);
  for (const hit of clone.querySelectorAll('.tf-hit')) hit.remove();
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.removeAttribute('style');
  const background = exportBackground();
  if (background) clone.setAttribute('style', `background-color: ${background}`);
  return { text: new XMLSerializer().serializeToString(clone), width, height };
}

async function pngBlob() {
  const { text, width, height } = exportSvgText();
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  await image.decode();
  const scale = Math.min(Number(els.pngScale.value) || 2, MAX_CANVAS_SIDE / width, MAX_CANVAS_SIDE / height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  const background = exportBackground();
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not create the PNG'))), 'image/png');
  });
}

async function copyPng() {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    showToast('This browser cannot copy images. Use the PNG download instead.', { error: true });
    return;
  }
  try {
    // Pass the promise straight to ClipboardItem so Safari keeps the click's user activation.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob() })]);
    showToast('PNG copied to clipboard');
  } catch (err) {
    showToast(err.message || 'Could not copy the PNG', { error: true });
  }
}

function download(blob, extension) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${current?.name || 'diagram'}.${extension}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text, message) {
  await navigator.clipboard.writeText(text);
  showToast(message);
}

async function exportAs(kind) {
  try {
    if (kind === 'copy-png') return await copyPng();
    if (kind === 'copy-svg') return await copyText(exportSvgText().text, 'SVG copied to clipboard');
    if (kind === 'copy-source') return await copyText(els.source.value, 'Mermaid source copied');
    if (kind === 'png') download(await pngBlob(), 'png');
    if (kind === 'svg') download(new Blob([exportSvgText().text], { type: 'image/svg+xml' }), 'svg');
    if (kind === 'mmd') download(new Blob([els.source.value], { type: 'text/plain' }), 'mmd');
  } catch (err) {
    showToast(err.message, { error: true });
  }
}

// ---------- menus ----------

// Popovers handle open, close, Escape and outside clicks; this only places them under their button.
for (const menu of document.querySelectorAll('.menu[popover]')) {
  const toggle = document.querySelector(`[popovertarget="${menu.id}"]`);
  menu.addEventListener('beforetoggle', (event) => {
    if (event.newState !== 'open') return;
    const box = toggle.getBoundingClientRect();
    menu.style.top = `${box.bottom + 8}px`;
    const left = Math.min(box.left, window.innerWidth - 236);
    menu.style.left = `${Math.max(8, left)}px`;
  });
}

$('export-menu').addEventListener('click', (event) => {
  const item = event.target.closest('[data-export]');
  if (!item) return;
  $('export-menu').hidePopover();
  void exportAs(item.dataset.export);
});
$('new-menu').addEventListener('click', (event) => {
  const item = event.target.closest('[data-template]');
  if (!item) return;
  $('new-menu').hidePopover();
  void createDiagram(item.dataset.template);
});

// ---------- editor width ----------

function setEditorWidth(width, persist = false) {
  const rail = document.querySelector('.diagram-rail').getBoundingClientRect().width;
  const max = Math.max(EDITOR_MIN_WIDTH, window.innerWidth - rail - PREVIEW_MIN_WIDTH - 10);
  const value = Math.round(Math.min(Math.max(width, EDITOR_MIN_WIDTH), max));
  document.documentElement.style.setProperty('--editor-width', `${value}px`);
  els.resizer.setAttribute('aria-valuenow', String(value));
  if (persist) writeSetting(EDITOR_WIDTH_KEY, String(value));
}

function editorWidth() {
  return document.querySelector('.editor-pane').getBoundingClientRect().width;
}

els.resizer.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  els.resizer.setPointerCapture(event.pointerId);
  document.body.classList.add('editor-resizing');
  const offset = event.clientX - editorWidth();
  const resize = (move) => setEditorWidth(move.clientX - offset);
  const finish = () => {
    document.body.classList.remove('editor-resizing');
    setEditorWidth(editorWidth(), true);
    els.resizer.removeEventListener('pointermove', resize);
    els.resizer.removeEventListener('pointerup', finish);
    els.resizer.removeEventListener('pointercancel', finish);
  };
  els.resizer.addEventListener('pointermove', resize);
  els.resizer.addEventListener('pointerup', finish);
  els.resizer.addEventListener('pointercancel', finish);
});
els.resizer.addEventListener('keydown', (event) => {
  const step = event.shiftKey ? 64 : 24;
  if (event.key === 'ArrowLeft') setEditorWidth(editorWidth() - step, true);
  else if (event.key === 'ArrowRight') setEditorWidth(editorWidth() + step, true);
  else return;
  event.preventDefault();
});
els.resizer.addEventListener('dblclick', () => setEditorWidth(420, true));

// ---------- source highlighting ----------

const KEYWORDS = new Set(('sequenceDiagram flowchart graph participant actor as title autonumber activate deactivate note over left right of '
  + 'loop alt else opt par and critical break rect end box create destroy subgraph direction classDef class style linkStyle click '
  + 'TD TB BT RL LR stateDiagram stateDiagram-v2 classDiagram erDiagram gantt pie journey gitGraph mindmap timeline').split(' ').map((word) => word.toLowerCase()));
const ARROW_PATTERN = '<<-->>|<<->>|-->>|->>|--x|-x|--\\)|-\\)|-\\.->|==>|-->|---|->|--o';
const MESSAGE_LINE = new RegExp(`^\\s*[^\\s%][^:]*?(?:${ARROW_PATTERN})[+-]?[^:]*:`);
// A name may contain dashes, but not one that starts an arrow (a->>b).
const HEAD_TOKENS = new RegExp(`(\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\}|"[^"]*"|\\|[^|]*\\|)|(${ARROW_PATTERN})([+-]?)|([A-Za-z_]\\w*(?:-(?![->.)]|[xo](?:\\s|$))\\w+)*)`, 'g');

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const token = (kind, text) => `<span class="tok-${kind}">${escapeHtml(text)}</span>`;

function labelHtml(text, kind) {
  return text.split(/(`[^`]+`)/).map((part) => (part.startsWith('`') && part.length > 1 ? token('code', part) : part && token(kind, part))).join('');
}

function headHtml(text) {
  let html = '';
  let last = 0;
  for (const match of text.matchAll(HEAD_TOKENS)) {
    html += escapeHtml(text.slice(last, match.index));
    if (match[1]) html += labelHtml(match[1], 'string');
    else if (match[2]) html += token('arrow', match[2] + match[3]);
    else html += token(KEYWORDS.has(match[4].toLowerCase()) ? 'keyword' : 'name', match[4]);
    last = match.index + match[0].length;
  }
  return html + escapeHtml(text.slice(last));
}

function lineHtml(line) {
  if (/^\s*%%/.test(line)) return token('comment', line);
  const title = line.match(/^(\s*)(title|accTitle|accDescr)(\b.*)$/);
  if (title) return escapeHtml(title[1]) + token('keyword', title[2]) + labelHtml(title[3], 'label');
  const colon = line.indexOf(':');
  const labelled = colon !== -1 && (MESSAGE_LINE.test(line) || /^\s*(note|title)\b/i.test(line));
  if (!labelled) return headHtml(line);
  return headHtml(line.slice(0, colon)) + token('punct', ':') + labelHtml(line.slice(colon + 1), 'label');
}

function updateHighlight() {
  const lines = els.source.value.split('\n').map((line, index) => {
    const html = lineHtml(line);
    return index + 1 === errorLine ? `<span class="tok-error">${html || ' '}</span>` : html;
  });
  // The trailing newline keeps the last line's height when the text ends in one.
  els.highlight.innerHTML = `${lines.join('\n')}\n`;
  els.highlight.scrollTop = els.source.scrollTop;
}

function setSource(text) {
  els.source.value = text;
  closeCompletions();
  updateHighlight();
}

function setErrorLine(line) {
  if (line === errorLine) return;
  errorLine = line;
  updateHighlight();
}

// ---------- autocomplete ----------

const SEQUENCE_WORDS = ['participant', 'actor', 'activate', 'deactivate', 'autonumber', 'title', 'Note over', 'Note left of', 'Note right of',
  'loop', 'alt', 'else', 'opt', 'par', 'and', 'critical', 'break', 'rect', 'end', 'box'];
const FLOWCHART_WORDS = ['subgraph', 'end', 'direction', 'classDef', 'class', 'style', 'linkStyle', 'click'];
const completion = { items: [], index: 0, start: 0, suffix: '' };
let caretMirror = null;

function diagramKind(text) {
  return text.split('\n').find((line) => line.trim() && !line.trim().startsWith('%%'))?.trim().split(/\s/)[0] || '';
}

function namesIn(text) {
  const names = new Set();
  for (const match of text.matchAll(/^\s*(?:participant|actor)\s+([^\s:]+)/gim)) names.add(match[1]);
  for (const match of text.matchAll(new RegExp(`^\\s*([\\w-]+?)\\s*(?:${ARROW_PATTERN})[+-]?\\s*([\\w-]+)`, 'gm'))) {
    names.add(match[1]);
    names.add(match[2]);
  }
  for (const match of text.matchAll(/(?:^|[\s>|&])([A-Za-z_]\w*)\s*[[({]/gm)) names.add(match[1]);
  return [...names];
}

function updateCompletions() {
  const { value, selectionStart: caret, selectionEnd } = els.source;
  if (!els.autocomplete.checked || caret !== selectionEnd) return closeCompletions();
  const before = value.slice(value.lastIndexOf('\n', caret - 1) + 1, caret);
  const sequence = diagramKind(value) === 'sequenceDiagram';
  // Right after an arrow, offer the participants it could point at.
  const target = sequence && before.match(new RegExp(`(?:${ARROW_PATTERN})[+-]?\\s*([\\w-]*)$`));
  const word = before.match(/[A-Za-z_][\w-]*$/)?.[0];
  if (!target && !word) return closeCompletions();
  const prefix = target ? target[1] : word;
  const names = namesIn(value.slice(0, caret - prefix.length) + value.slice(caret));
  const atLineStart = !target && /^\s*[A-Za-z_][\w-]*$/.test(before);
  const words = atLineStart ? [...(sequence ? SEQUENCE_WORDS : FLOWCHART_WORDS), ...names] : names;
  const items = [...new Set(words)]
    .filter((item) => item.toLowerCase().startsWith(prefix.toLowerCase()) && item !== prefix)
    .slice(0, 8)
    .map((text) => ({ text, kind: names.includes(text) ? 'name' : 'keyword' }));
  if (!items.length) return closeCompletions();
  Object.assign(completion, { items, index: 0, start: caret - prefix.length, suffix: target ? ': ' : '' });
  renderCompletions();
}

function caretPosition() {
  caretMirror ||= document.body.appendChild(document.createElement('div'));
  const style = getComputedStyle(els.source);
  for (const name of ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'whiteSpace', 'overflowWrap', 'tabSize', 'boxSizing']) {
    caretMirror.style[name] = style[name];
  }
  Object.assign(caretMirror.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', width: `${els.source.clientWidth}px` });
  caretMirror.textContent = els.source.value.slice(0, els.source.selectionStart);
  const marker = caretMirror.appendChild(document.createElement('span'));
  marker.textContent = '​';
  return {
    x: marker.offsetLeft - els.source.scrollLeft,
    y: marker.offsetTop - els.source.scrollTop + parseFloat(style.lineHeight),
  };
}

function renderCompletions() {
  const { x, y } = caretPosition();
  els.completions.replaceChildren(...completion.items.map((item, index) => {
    const option = document.createElement('div');
    option.className = 'completion';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(index === completion.index));
    const label = document.createElement('span');
    label.textContent = item.text;
    const kind = document.createElement('small');
    kind.textContent = item.kind === 'name' ? 'participant' : 'keyword';
    option.append(label, kind);
    option.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      acceptCompletion(index);
    });
    return option;
  }));
  els.completions.style.left = `${Math.min(x, els.source.clientWidth - 180)}px`;
  els.completions.style.top = `${y + 2}px`;
  els.completions.hidden = false;
}

function closeCompletions() {
  els.completions.hidden = true;
  completion.items = [];
}

function acceptCompletion(index = completion.index) {
  const item = completion.items[index];
  if (!item) return;
  els.source.setRangeText(item.text + completion.suffix, completion.start, els.source.selectionStart, 'end');
  closeCompletions();
  updateHighlight();
  scheduleSave();
  scheduleRender();
}

// Returns true when the key was used by the open suggestion list.
function completionKey(event) {
  if (els.completions.hidden) return false;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const step = event.key === 'ArrowDown' ? 1 : -1;
    completion.index = (completion.index + step + completion.items.length) % completion.items.length;
    renderCompletions();
  } else if (event.key === 'Enter' || event.key === 'Tab') {
    acceptCompletion();
  } else if (event.key === 'Escape') {
    closeCompletions();
  } else {
    return false;
  }
  event.preventDefault();
  return true;
}

// ---------- source ↔ preview ----------

// Each message's text, its inline-code pills and the arrow drawn right after it.
function sequenceMessages(svg) {
  return [...svg.querySelectorAll('.messageText')].map((text) => {
    const elements = [text];
    let node = text.previousElementSibling;
    while (node?.classList.contains('inline-code-pill')) {
      elements.push(node);
      node = node.previousElementSibling;
    }
    node = text.nextElementSibling;
    while (node?.classList.contains('inline-code-pill')) node = node.nextElementSibling;
    if (node?.matches('.messageLine0, .messageLine1')) elements.push(node);
    return elements;
  });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Mermaid draws messages, notes and participants in source order, so the nth one maps to the nth matching line.
function linkSource(svg, source) {
  const lines = source.split('\n');
  const matching = (pattern) => lines.flatMap((text, index) => (pattern.test(text) ? [index + 1] : []));
  const firstMention = (id) => {
    const declared = new RegExp(`^\\s*(?:participant|actor)\\s+${escapeRegExp(id)}(?:\\s|$)`, 'i');
    const used = new RegExp(`(^|[^\\w-])${escapeRegExp(id)}([^\\w-]|$)`);
    const index = lines.findIndex((text) => declared.test(text));
    return (index !== -1 ? index : lines.findIndex((text, at) => at > 0 && !/^\s*%%/.test(text) && used.test(text))) + 1;
  };
  const found = [];
  if (svg.querySelector('.messageText')) {
    const messageLines = matching(MESSAGE_LINE);
    sequenceMessages(svg).forEach((elements, index) => { if (messageLines[index]) found.push({ line: messageLines[index], elements }); });
    const noteLines = matching(/^\s*note\s/i);
    [...svg.querySelectorAll('rect.note')].forEach((rect, index) => { if (noteLines[index]) found.push({ line: noteLines[index], elements: [rect.parentNode] }); });
    for (const rect of svg.querySelectorAll('rect.actor[name]')) {
      const line = firstMention(rect.getAttribute('name'));
      if (line) found.push({ line, elements: [rect.parentNode] });
    }
  } else {
    for (const node of svg.querySelectorAll('g.node[id]')) {
      const id = node.id.match(/flowchart-(.+)-\d+$/)?.[1];
      const line = id && firstMention(id);
      if (line) found.push({ line, elements: [node] });
    }
  }
  for (const link of found) addHitArea(link);
  return found;
}

const HIT_PAD_X = 6;
const HIT_PAD_Y = 4;

// Thin arrows and small text are hard to click, so put one padded, invisible target under each linked group.
// Its transparent border (see --hit-reach) adds a fixed on-screen margin at any zoom.
function addHitArea(link) {
  const first = link.elements.reduce((earliest, element) => (earliest.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING ? element : earliest));
  const box = unionBox(link.elements.map(plainBox));
  const hit = document.createElementNS(SVG_NS, 'rect');
  for (const [name, value] of Object.entries({
    x: box.x - HIT_PAD_X, y: box.y - HIT_PAD_Y, width: box.width + HIT_PAD_X * 2, height: box.height + HIT_PAD_Y * 2, rx: 6,
  })) hit.setAttribute(name, String(value));
  hit.setAttribute('class', 'tf-hit tf-link');
  first.parentNode.insertBefore(hit, first);
  link.elements.push(hit);
  for (const element of link.elements) element.classList.add('tf-link');
}

function linkFor(target) {
  for (let node = target; node && node !== els.preview; node = node.parentNode) {
    const link = links.find((item) => item.elements.includes(node));
    if (link) return link;
  }
  return null;
}

function currentLine() {
  return els.source.value.slice(0, els.source.selectionStart).split('\n').length;
}

function showActiveLine() {
  const line = currentLine();
  for (const element of els.preview.querySelectorAll('.tf-active')) element.classList.remove('tf-active');
  if (document.activeElement !== els.source) return;
  for (const link of links) {
    if (link.line === line) for (const element of link.elements) element.classList.add('tf-active');
  }
}

function selectLine(line) {
  const lines = els.source.value.split('\n');
  const start = lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0);
  els.source.focus();
  els.source.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
  const lineHeight = parseFloat(getComputedStyle(els.source).lineHeight);
  els.source.scrollTop = Math.max(0, (line - 1) * lineHeight - els.source.clientHeight / 3);
  showActiveLine();
}

// ---------- presentation ----------

// Loops, activations and bands are taller than this; single messages and notes are not.
const TALL_HEIGHT = 40;

// Gives every message, note, loop and activation the step that reveals it, keyed by vertical position.
function presentationSteps(svg) {
  if (!svg.querySelector('.messageText')) return null;
  const centre = (element) => {
    const box = element.getBBox();
    return box.y + box.height / 2;
  };
  const stops = [...svg.querySelectorAll('.messageLine0, .messageLine1, rect.note')]
    .map(centre)
    .sort((a, b) => a - b)
    .filter((y, index, all) => !index || y - all[index - 1] > 2);
  const elements = [...svg.querySelectorAll('.messageText, .messageLine0, .messageLine1, rect.inline-code-pill, rect.note, .noteText, '
    + '[class^="activation"], rect.rect, .loopLine, .labelBox, .labelText, .loopText, .sequenceNumber')];
  for (const element of elements) {
    const box = element.getBBox();
    // Tall shapes (loops, activations, bands) appear with their first message, not their middle one.
    const key = box.height > TALL_HEIGHT ? box.y : box.y + box.height / 2;
    const step = stops.findIndex((y) => y >= key - 3);
    element.dataset.step = String(step === -1 ? stops.length - 1 : step);
  }
  return { count: stops.length, elements };
}

const CAMERA_MS = 450;
const MAX_ZOOM = 3;

// getBBox() returns an SVGRect, whose fields are getters that object spread does not copy.
function plainBox(element) {
  const { x, y, width, height } = element.getBBox();
  return { x, y, width, height };
}

function unionBox(boxes) {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function startPresentation() {
  const source = previewSvg();
  if (!source) return showToast('Nothing to present yet. Fix the diagram errors first.', { error: true });
  const svg = source.cloneNode(true);
  for (const hit of svg.querySelectorAll('.tf-hit')) hit.remove();
  for (const element of svg.querySelectorAll('.tf-active, .tf-link')) element.classList.remove('tf-active', 'tf-link');
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const overlay = document.createElement('div');
  overlay.className = 'presentation';
  overlay.style.background = paper;
  const stage = document.createElement('div');
  stage.className = 'presentation-stage';
  const heads = document.createElement('div');
  heads.className = 'presentation-heads';
  stage.append(svg, heads);
  const bar = document.createElement('div');
  bar.className = 'presentation-bar';
  const button = (text, title, onClick) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = text;
    node.title = title;
    node.addEventListener('click', onClick);
    return node;
  };
  const counter = document.createElement('span');
  overlay.append(stage, bar);
  document.body.append(overlay);

  const steps = presentationSteps(svg);
  const full = svg.viewBox.baseVal;
  const diagram = { x: full.x, y: full.y, width: full.width, height: full.height };
  // Participant boxes along the top, used for the sticky name chips and to frame the lifelines in focus.
  // Mermaid draws the bottom boxes first, so keep the topmost box of each participant.
  const tops = new Map();
  for (const rect of svg.querySelectorAll('rect.actor[name]')) {
    const box = plainBox(rect);
    const seen = tops.get(rect.getAttribute('name'));
    if (!seen || box.y < seen.box.y) tops.set(rect.getAttribute('name'), { rect, box });
  }
  const actors = [...tops.entries()].map(([name, { rect, box }]) => ({
    box,
    name: rect.parentNode.querySelector('text')?.textContent || name,
    colour: getComputedStyle(rect).stroke,
  }));
  let shown = 0;
  let follow = true;
  let camera = { ...diagram };
  let animation = 0;

  // The camera always matches the stage's shape, so screen and diagram coordinates map linearly.
  const fitAspect = (box) => {
    const { width: stageWidth, height: stageHeight } = svg.getBoundingClientRect();
    const aspect = stageWidth / stageHeight || 1;
    let { x, y, width, height } = box;
    if (width / height < aspect) {
      const grown = height * aspect;
      x -= (grown - width) / 2;
      width = grown;
    } else {
      const grown = width / aspect;
      y -= (grown - height) / 2;
      height = grown;
    }
    return { x, y, width, height };
  };
  const overview = () => {
    const margin = Math.max(diagram.width, diagram.height) * 0.03;
    return fitAspect({ x: diagram.x - margin, y: diagram.y - margin, width: diagram.width + margin * 2, height: diagram.height + margin * 2 });
  };

  const renderHeads = () => {
    const topActor = Math.max(0, ...actors.map((actor) => actor.box.y + actor.box.height));
    // Only once the real participant boxes have scrolled out of view.
    if (!actors.length || camera.y < topActor - 4) {
      heads.replaceChildren();
      return;
    }
    const { width: stageWidth } = svg.getBoundingClientRect();
    heads.replaceChildren(...actors.flatMap((actor) => {
      const centre = actor.box.x + actor.box.width / 2;
      if (centre < camera.x || centre > camera.x + camera.width) return [];
      const chip = document.createElement('span');
      chip.textContent = actor.name;
      chip.style.left = `${((centre - camera.x) / camera.width) * stageWidth}px`;
      chip.style.borderColor = actor.colour;
      return [chip];
    }));
  };
  const apply = (box) => {
    camera = box;
    svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
    renderHeads();
  };
  const animateTo = (target) => {
    cancelAnimationFrame(animation);
    const from = { ...camera };
    const started = performance.now();
    const frame = (now) => {
      const t = Math.min(1, (now - started) / CAMERA_MS);
      const ease = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      apply(Object.fromEntries(Object.keys(from).map((key) => [key, from[key] + (target[key] - from[key]) * ease])));
      if (t < 1) animation = requestAnimationFrame(frame);
    };
    animation = requestAnimationFrame(frame);
  };

  // Frames the newest step with the one before it, widened to the whole boxes of the participants involved.
  const focusFor = (count) => {
    if (!steps || count === 0) return overview();
    const inFocus = steps.elements.filter((element) => {
      const step = Number(element.dataset.step);
      return (step === count - 1 || step === count - 2) && element.getBBox().height <= TALL_HEIGHT;
    });
    if (!inFocus.length) return overview();
    const box = unionBox(inFocus.map((element) => element.getBBox()));
    const columns = actors.filter((actor) => {
      const centre = actor.box.x + actor.box.width / 2;
      return centre >= box.x - 2 && centre <= box.x + box.width + 2;
    });
    const wide = unionBox([box, ...columns.map((actor) => ({ ...actor.box, y: box.y, height: box.height }))]);
    const pad = 48;
    const padded = { x: wide.x - pad, y: wide.y - pad * 1.5, width: wide.width + pad * 2, height: wide.height + pad * 3 };
    const all = overview();
    const fitted = fitAspect(padded);
    // Never zoom in so far that a short message fills the screen.
    const scale = Math.max(1, (all.width / MAX_ZOOM) / fitted.width);
    const cx = fitted.x + fitted.width / 2;
    const cy = fitted.y + fitted.height / 2;
    const width = fitted.width * scale;
    const height = fitted.height * scale;
    // Prefer to stay within the diagram rather than show empty paper.
    const x = Math.min(Math.max(cx - width / 2, all.x), Math.max(all.x, all.x + all.width - width));
    const y = Math.min(Math.max(cy - height / 2, all.y), Math.max(all.y, all.y + all.height - height));
    return { x, y, width, height };
  };

  const followButton = button('Follow: on', 'Zoom to each step as it appears (F)', () => setFollow(!follow));
  const setFollow = (on) => {
    follow = on;
    followButton.textContent = `Follow: ${on ? 'on' : 'off'}`;
    followButton.classList.toggle('on', on);
    animateTo(on ? focusFor(shown) : overview());
  };
  const show = (count) => {
    if (!steps) return;
    shown = Math.max(0, Math.min(steps.count, count));
    for (const element of steps.elements) {
      const step = Number(element.dataset.step);
      element.style.opacity = step < shown ? '1' : '0';
      element.classList.toggle('tf-current', step === shown - 1 && /messageText|noteText/.test(element.getAttribute('class')));
    }
    counter.textContent = `${shown} / ${steps.count}`;
    if (follow) animateTo(focusFor(shown));
  };
  const zoomAround = (factor, clientX, clientY) => {
    const rect = svg.getBoundingClientRect();
    const px = (clientX - rect.left) / rect.width;
    const py = (clientY - rect.top) / rect.height;
    const width = Math.min(Math.max(camera.width / factor, overview().width / 12), overview().width * 2);
    const height = width * (camera.height / camera.width);
    cancelAnimationFrame(animation);
    apply({ x: camera.x + (camera.width - width) * px, y: camera.y + (camera.height - height) * py, width, height });
  };
  const zoomCentre = (factor) => {
    const rect = svg.getBoundingClientRect();
    zoomAround(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey || Math.abs(event.deltaY) > Math.abs(event.deltaX) * 2) {
      zoomAround(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)), event.clientX, event.clientY);
    } else {
      const rect = svg.getBoundingClientRect();
      apply({ ...camera, x: camera.x + (event.deltaX / rect.width) * camera.width });
    }
  }, { passive: false });
  // Drag to pan; a press that barely moves is a click and shows the next step.
  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, camera: { ...camera } };
    stage.setPointerCapture(event.pointerId);
    const move = (next) => {
      const rect = svg.getBoundingClientRect();
      if (Math.hypot(next.clientX - start.x, next.clientY - start.y) < 4) return;
      stage.classList.add('panning');
      cancelAnimationFrame(animation);
      apply({
        ...start.camera,
        x: start.camera.x - ((next.clientX - start.x) / rect.width) * start.camera.width,
        y: start.camera.y - ((next.clientY - start.y) / rect.height) * start.camera.height,
      });
    };
    const end = (last) => {
      stage.classList.remove('panning');
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', end);
      stage.removeEventListener('pointercancel', end);
      if (last.type === 'pointerup' && Math.hypot(last.clientX - start.x, last.clientY - start.y) < 4) show(shown + 1);
    };
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
  });

  const close = () => {
    cancelAnimationFrame(animation);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('fullscreenchange', onFullscreen);
    resize.disconnect();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    overlay.remove();
  };
  const onKey = (event) => {
    const forward = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(event.key);
    const backward = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(event.key);
    if (forward) show(shown + 1);
    else if (backward) show(shown - 1);
    else if (event.key === 'Home') show(0);
    else if (event.key === 'End') show(Infinity);
    else if (event.key === '+' || event.key === '=') zoomCentre(1.25);
    else if (event.key === '-' || event.key === '_') zoomCentre(0.8);
    else if (event.key === '0') animateTo(overview());
    else if (event.key.toLowerCase() === 'f' && steps) setFollow(!follow);
    else if (event.key === 'Escape') close();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const onFullscreen = () => { if (!document.fullscreenElement) close(); };
  // Going full screen resizes the stage, so re-frame to the new shape.
  const resize = new ResizeObserver(() => apply(follow ? focusFor(shown) : overview()));
  resize.observe(stage);

  bar.append(
    ...(steps ? [button('←', 'Previous step (←)', () => show(shown - 1)), counter, button('→', 'Next step (→ or click)', () => show(shown + 1)), followButton] : []),
    button('−', 'Zoom out (-)', () => zoomCentre(0.8)),
    button('Fit', 'Show the whole diagram (0)', () => animateTo(overview())),
    button('+', 'Zoom in (+)', () => zoomCentre(1.25)),
    button('Exit (Esc)', 'Leave presentation', close),
  );
  followButton.classList.add('on');
  document.addEventListener('keydown', onKey, true);
  apply(overview());
  show(0);
  overlay.requestFullscreen?.().then(() => document.addEventListener('fullscreenchange', onFullscreen)).catch(() => {});
}

// ---------- compare traces ----------

const TIMING = /\s*·\s*(\d+)(?:–(\d+))?ms/;

function messageKeys(source) {
  return source.split('\n').filter((line) => MESSAGE_LINE.test(line)).map((line) => {
    const match = line.match(TIMING);
    return { key: line.replace(TIMING, '').trim(), ms: match ? Number(match[2] || match[1]) : null };
  });
}

// Longest common subsequence of message keys; whatever is left over only exists on one side.
function alignMessages(left, right) {
  const table = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i].key === right[j].key ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i].key === right[j].key) pairs.push([i++, j++]);
    else if (table[i + 1][j] >= table[i][j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

function traceLabel(trace) {
  return `${trace.method} ${trace.path} · ${trace.status ?? '…'} · ${new Date(trace.startedAt).toLocaleTimeString()}`;
}

async function openCompare() {
  let traces;
  try {
    ({ traces } = await request('/api/traces'));
  } catch (err) {
    return showToast(err.message, { error: true });
  }
  if (traces.length < 2) return showToast('Capture at least two traces to compare them.', { error: true });
  // Default to the latest trace and an earlier run of the same request.
  const latest = traces[0];
  const earlier = traces.slice(1).find((trace) => trace.method === latest.method && trace.path === latest.path) || traces[1];

  const overlay = document.createElement('div');
  overlay.className = 'compare';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Compare traces');
  const head = document.createElement('div');
  head.className = 'compare-head';
  const title = document.createElement('strong');
  title.textContent = 'Compare traces';
  const picker = (label, selected) => {
    const wrap = document.createElement('label');
    const select = document.createElement('select');
    for (const trace of traces) select.append(new Option(traceLabel(trace), trace.id, false, trace.id === selected.id));
    wrap.append(label, select);
    return { wrap, select };
  };
  const before = picker('A', earlier);
  const after = picker('B', latest);
  const summary = document.createElement('span');
  summary.className = 'compare-summary';
  const legend = document.createElement('span');
  legend.className = 'compare-legend';
  legend.innerHTML = '<span class="legend-removed">only in A</span><span class="legend-added">only in B</span><span class="legend-slower">B slower</span>';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'compare-close';
  close.textContent = 'Close (Esc)';
  head.append(title, before.wrap, after.wrap, summary, legend, close);
  const body = document.createElement('div');
  body.className = 'compare-body';
  const panes = ['A', 'B'].map(() => {
    const pane = document.createElement('section');
    pane.className = 'compare-pane';
    const heading = document.createElement('h3');
    const diagram = document.createElement('div');
    diagram.className = 'compare-diagram';
    diagram.style.background = paper;
    pane.append(heading, diagram);
    body.append(pane);
    return { heading, diagram };
  });
  overlay.append(head, body);
  document.body.append(overlay);

  let seq = 0;
  const render = async () => {
    const run = ++seq;
    summary.textContent = 'Rendering…';
    try {
      const ids = [before.select.value, after.select.value];
      const sources = await Promise.all(ids.map((id) => traceMermaid(id)));
      const svgs = [];
      for (const [index, { source }] of sources.entries()) {
        const { svg } = await mermaid.render(`traceflow-compare-${run}-${index}`, source);
        if (run !== seq) return;
        panes[index].diagram.innerHTML = svg;
        const node = panes[index].diagram.querySelector('svg');
        styleInlineCode(node);
        svgs.push(node);
        panes[index].heading.textContent = `${index ? 'B' : 'A'} · ${traceLabel(traces.find((trace) => trace.id === ids[index]))}`;
      }
      const [left, right] = sources.map(({ source }) => messageKeys(source));
      const pairs = alignMessages(left, right);
      const [leftMessages, rightMessages] = svgs.map(sequenceMessages);
      const mark = (elements, kind) => { for (const element of elements || []) element.classList.add(`tf-diff-${kind}`); };
      const matchedLeft = new Set(pairs.map(([i]) => i));
      const matchedRight = new Set(pairs.map(([, j]) => j));
      left.forEach((_, i) => { if (!matchedLeft.has(i)) mark(leftMessages[i], 'removed'); });
      right.forEach((_, j) => { if (!matchedRight.has(j)) mark(rightMessages[j], 'added'); });
      let slower = 0;
      for (const [i, j] of pairs) {
        const a = left[i].ms;
        const b = right[j].ms;
        if (a != null && b != null && b - a >= 20 && b > a * 1.25) {
          mark(rightMessages[j], 'slower');
          slower += 1;
        }
      }
      const removed = left.length - pairs.length;
      const added = right.length - pairs.length;
      summary.textContent = removed || added || slower
        ? `${removed} only in A · ${added} only in B · ${slower} slower in B`
        : 'Same calls, no notable timing change';
    } catch (err) {
      if (run === seq) summary.textContent = `Could not compare: ${err.message}`;
    }
  };
  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    dismiss();
  };
  const dismiss = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  before.select.addEventListener('change', render);
  after.select.addEventListener('change', render);
  close.addEventListener('click', dismiss);
  document.addEventListener('keydown', onKey);
  await render();
}

// ---------- events ----------

els.source.addEventListener('input', () => {
  updateHighlight();
  scheduleSave();
  scheduleRender();
  updateCompletions();
  showActiveLine();
});
els.source.addEventListener('scroll', () => {
  els.highlight.scrollTop = els.source.scrollTop;
  els.highlight.scrollLeft = els.source.scrollLeft;
  closeCompletions();
});
for (const type of ['click', 'keyup', 'select']) els.source.addEventListener(type, showActiveLine);
els.source.addEventListener('blur', () => setTimeout(closeCompletions, 120));
els.source.addEventListener('keydown', (event) => {
  if (completionKey(event)) return;
  if (event.key !== 'Tab' || event.metaKey || event.ctrlKey || event.altKey) return;
  event.preventDefault();
  const { selectionStart: start, selectionEnd: end, value } = els.source;
  if (event.shiftKey) {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const removable = value.slice(lineStart, lineStart + 2).match(/^ {1,2}/)?.[0].length || 0;
    if (!removable) return;
    els.source.setRangeText('', lineStart, lineStart + removable, 'preserve');
    els.source.setSelectionRange(Math.max(lineStart, start - removable), Math.max(lineStart, end - removable));
  } else {
    els.source.setRangeText('  ', start, end, 'end');
  }
  els.source.dispatchEvent(new Event('input'));
});
els.name.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') els.name.blur();
  if (event.key === 'Escape') {
    els.name.value = current?.name || '';
    els.name.blur();
  }
});
els.name.addEventListener('blur', () => { void renameCurrent(); });
els.remove.addEventListener('click', () => { void deleteCurrent(); });
$('present').addEventListener('click', startPresentation);
$('compare-traces').addEventListener('click', () => { void openCompare(); });
els.filter.addEventListener('input', renderList);
els.error.addEventListener('click', () => {
  if (errorLine) selectLine(errorLine);
});
// ---------- settings ----------

function applyEditorSettings() {
  for (const layer of [els.source, els.highlight]) {
    layer.style.fontSize = `${els.fontSize.value}px`;
    layer.classList.toggle('wrap', els.wrap.checked);
  }
}

function rerender() {
  initMermaid();
  void renderPreview();
}

const SETTINGS = [
  { el: els.theme, key: 'theme', fallback: 'redux-color', apply: rerender },
  { el: els.look, key: 'look', fallback: 'neo', apply: rerender },
  { el: els.pngScale, key: 'png-scale', fallback: '2' },
  { el: els.transparent, key: 'transparent', fallback: false },
  { el: els.fontSize, key: 'font-size', fallback: '13', apply: applyEditorSettings },
  { el: els.wrap, key: 'wrap', fallback: false, apply: applyEditorSettings },
  { el: els.autocomplete, key: 'autocomplete', fallback: true },
  { el: els.collapseRepeats, key: 'collapse-repeats', fallback: true },
  { el: els.traceNotes, key: 'trace-notes', fallback: false },
];

function loadSettings() {
  for (const { el, key, fallback } of SETTINGS) {
    const stored = readSetting(SETTINGS_PREFIX + key, null);
    if (el.type === 'checkbox') {
      el.checked = stored === null ? fallback : stored === '1';
      continue;
    }
    el.value = stored ?? fallback;
    // A value from an older version that no longer exists leaves the select empty.
    if (!el.value) el.value = fallback;
  }
  applyEditorSettings();
}

for (const { el, key, apply } of SETTINGS) {
  el.addEventListener('change', () => {
    writeSetting(SETTINGS_PREFIX + key, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
    apply?.();
  });
}

function setSettingsOpen(open) {
  els.settingsPanel.hidden = !open;
  els.settingsToggle.setAttribute('aria-expanded', String(open));
  if (open) els.settingsPanel.querySelector('select')?.focus();
}

els.settingsToggle.addEventListener('click', () => setSettingsOpen(els.settingsPanel.hidden));
document.addEventListener('pointerdown', (event) => {
  if (!els.settingsPanel.hidden && !event.target.closest('.settings')) setSettingsOpen(false);
});

document.addEventListener('keydown', (event) => {
  if (document.querySelector('.presentation, .compare')) return;
  if (event.key === 'Escape' && !els.settingsPanel.hidden) {
    setSettingsOpen(false);
    els.settingsToggle.focus();
  }
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void flushSave();
  }
  if (mod && event.shiftKey && event.key.toLowerCase() === 'c') {
    event.preventDefault();
    void copyPng();
  }
});
window.addEventListener('focus', () => {
  void syncFromDisk();
  void loadTraces();
});
window.addEventListener('resize', () => setEditorWidth(editorWidth()));
window.addEventListener('popstate', () => {
  const name = decodeURIComponent(location.hash.slice(1));
  if (name && name !== current?.name) void openDiagram(name, { replaceHash: true });
});
window.addEventListener('beforeunload', (event) => {
  if (!dirty()) return;
  void flushSave();
  event.preventDefault();
});

async function boot() {
  loadSettings();
  const savedWidth = Number.parseInt(readSetting(EDITOR_WIDTH_KEY, ''), 10);
  if (Number.isFinite(savedWidth)) setEditorWidth(savedWidth);
  initMermaid();
  void loadTraces();
  // The server pushes a message whenever a .mmd file changes on disk.
  new EventSource('/api/diagrams/events').onmessage = () => { void syncFromDisk({ announce: true }); };
  setInterval(() => { if (!document.hidden) void loadTraces(); }, 5000);
  try {
    const list = await loadList();
    const wanted = decodeURIComponent(location.hash.slice(1));
    const name = list.find((item) => item.name === wanted)?.name || list[0]?.name;
    if (name) await openDiagram(name, { replaceHash: true });
    else showEmptyEditor();
  } catch (err) {
    showToast(err.message, { error: true });
  }
}

void boot();
