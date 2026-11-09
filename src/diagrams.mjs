import { watch as fsWatch } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const EXTENSION = '.mmd';
const NAME = /^[\w][\w .-]{0,79}$/;
const MAX_SOURCE_BYTES = 1_000_000;

export function diagramsDirFor(config = {}, env = process.env) {
  if (env.TRACEFLOW_DIAGRAMS_DIR) return path.resolve(env.TRACEFLOW_DIAGRAMS_DIR);
  if (config.diagramsDir) return path.resolve(config.baseDir || process.cwd(), config.diagramsDir);
  return path.join(os.homedir(), '.traceflow', 'diagrams');
}

export function validDiagramName(name) {
  return typeof name === 'string' && NAME.test(name) && !name.includes('..') && !/[ .]$/.test(name);
}

function invalid(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

export function diagramStore(dir) {
  const fileOf = (name) => {
    if (!validDiagramName(name)) throw invalid('Diagram names may use letters, numbers, spaces, dots, dashes and underscores');
    return path.join(dir, `${name}${EXTENSION}`);
  };
  const missing = (err) => {
    if (err.code === 'ENOENT') throw invalid('Diagram not found', 404);
    throw err;
  };

  async function list() {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const diagrams = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(EXTENSION))
      .map((entry) => entry.name.slice(0, -EXTENSION.length))
      .filter(validDiagramName)
      .map(async (name) => {
        const stat = await fs.stat(fileOf(name));
        return { name, updatedAt: stat.mtimeMs, size: stat.size };
      }));
    return diagrams.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function read(name) {
    const file = fileOf(name);
    const [source, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]).catch(missing);
    return { name, source, updatedAt: stat.mtimeMs };
  }

  async function write(name, source) {
    if (typeof source !== 'string') throw invalid('Diagram source must be text');
    if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) throw invalid('Diagram is too large', 413);
    const file = fileOf(name);
    await fs.mkdir(dir, { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, source);
    await fs.rename(temp, file);
    const stat = await fs.stat(file);
    return { name, updatedAt: stat.mtimeMs };
  }

  async function remove(name) {
    await fs.unlink(fileOf(name)).catch(missing);
    return { name };
  }

  async function rename(from, to) {
    const fromFile = fileOf(from);
    const toFile = fileOf(to);
    if (from === to) return { name: to };
    if (await exists(toFile)) throw invalid('A diagram with that name already exists', 409);
    await fs.rename(fromFile, toFile).catch(missing);
    return { name: to };
  }

  async function uniqueName(base) {
    const stem = slug(base) || 'diagram';
    for (let index = 1; index < 1000; index += 1) {
      const name = index === 1 ? stem : `${stem}-${index}`;
      if (!(await exists(fileOf(name)))) return name;
    }
    throw invalid('Could not choose a free diagram name', 409);
  }

  return { dir, list, read, write, remove, rename, uniqueName };
}

// Calls onChange (debounced) whenever a diagram file is added, edited or removed, from any editor.
export async function watchDiagrams(dir, onChange) {
  await fs.mkdir(dir, { recursive: true });
  let timer = null;
  const watcher = fsWatch(dir, (_event, file) => {
    if (file && !String(file).endsWith(EXTENSION)) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, 120);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

const RESERVED = new Set([
  'actor', 'activate', 'alt', 'and', 'autonumber', 'box', 'break', 'create', 'critical', 'deactivate',
  'destroy', 'else', 'end', 'left', 'link', 'links', 'loop', 'note', 'opt', 'over', 'par', 'participant',
  'properties', 'details', 'rect', 'right', 'title',
]);

// Mermaid treats ';' as a statement separator and '#…;' as an entity, so escape both.
function mermaidText(value) {
  const entities = { '#': '#35;', ';': '#59;', '%%': '%#37;' };
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/%%|[#;]/g, (match) => entities[match]).trim();
}

function requestPath(value) {
  return String(value || '/').split('?')[0];
}

const FAILURE_FILL = 'rgba(255, 93, 115, 0.16)';
const NOTE_CHARS = 80;

const isBad = (span) => Boolean(span.error) || Number(span.status) >= 400;
const durationOf = (span) => (span.endedAt ? Math.max(0, Math.round(span.endedAt - span.startedAt)) : null);

// Backticks render as inline code in Traceflow's editor; other Mermaid renderers show them as typed.
function requestLabel(span) {
  return [span.method, requestPath(span.path)].filter(Boolean).map((part) => `\`${part.replace(/`/g, "'")}\``).join(' ');
}

function responseLabel(spans) {
  const outcomes = [...new Set(spans.map((span) => span.error || span.status).filter((value) => value != null && value !== ''))];
  const durations = spans.map(durationOf).filter((ms) => ms != null);
  const low = Math.min(...durations);
  const high = Math.max(...durations);
  const timing = !durations.length ? '' : low === high ? `${low}ms` : `${low}–${high}ms`;
  return [outcomes.join(', '), timing].filter(Boolean).join(' · ');
}

function bodyNote(body) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > NOTE_CHARS ? `${text.slice(0, NOTE_CHARS - 1)}…` : text;
}

export function traceToMermaid(trace, { labels = {}, collapseRepeats = true, notes = false } = {}) {
  const spans = (trace?.spans || [])
    .map((span) => ({ ...span, from: span.from || 'client', to: span.to || 'service' }))
    .sort((a, b) => a.startedAt - b.startedAt);
  if (!spans.length) throw invalid('Trace has no requests');
  const ids = new Map();
  const used = new Set();
  const participant = (name) => {
    if (ids.has(name)) return ids.get(name);
    let id = slug(name).replace(/-/g, '_') || 'service';
    if (/^\d/.test(id)) id = `s_${id}`;
    if (RESERVED.has(id)) id = `${id}_`;
    let unique = id;
    for (let index = 2; used.has(unique); index += 1) unique = `${id}_${index}`;
    used.add(unique);
    ids.set(name, unique);
    return unique;
  };
  for (const span of spans) {
    participant(span.from);
    participant(span.to);
  }

  const events = [];
  spans.forEach((span, index) => {
    const answered = Boolean(span.endedAt || span.status != null || span.error);
    events.push({ at: span.startedAt, order: index * 2, kind: 'request', span, answered });
    if (answered) events.push({ at: span.endedAt || span.startedAt, order: index * 2 + 1, kind: 'response', span });
  });
  events.sort((a, b) => a.at - b.at || a.order - b.order);

  // A call answered before anything else happens is a leaf; runs of identical leaves become one loop.
  const items = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const next = events[index + 1];
    if (event.kind === 'request' && next?.kind === 'response' && next.span === event.span) {
      const key = [event.span.from, event.span.to, event.span.method, requestPath(event.span.path)].join(' ');
      const last = items.at(-1);
      if (collapseRepeats && last?.key === key) last.spans.push(event.span);
      else items.push({ key, spans: [event.span] });
      index += 1;
      continue;
    }
    items.push({ event });
  }

  const root = spans[0];
  const lines = [
    `%% Captured by Traceflow on ${new Date(root.startedAt || Date.now()).toISOString()}`,
    'sequenceDiagram',
    `  title ${mermaidText(`${root.method || 'REQUEST'} ${requestPath(root.path)}`)}`,
  ];
  for (const [name, id] of ids) {
    const label = mermaidText(labels[name] || name);
    lines.push(label === id ? `  participant ${id}` : `  participant ${id} as ${label}`);
  }

  const request = (span, answered, indent) => {
    lines.push(`${indent}${ids.get(span.from)}->>${answered ? '+' : ''}${ids.get(span.to)}: ${mermaidText(requestLabel(span))}`);
    const note = notes && bodyNote(span.requestBody);
    if (note) lines.push(`${indent}Note over ${ids.get(span.from)},${ids.get(span.to)}: ${mermaidText(note)}`);
  };
  const response = (group, indent) => {
    const [span] = group;
    const bad = group.some(isBad);
    // Failures sit on a red band, which every Mermaid renderer draws.
    if (bad) lines.push(`${indent}rect ${FAILURE_FILL}`);
    const inner = bad ? `${indent}  ` : indent;
    lines.push(`${inner}${ids.get(span.to)}${bad ? '--x' : '-->>'}-${ids.get(span.from)}: ${mermaidText(responseLabel(group))}`);
    const note = notes && group.length === 1 && bodyNote(span.responseBody);
    if (note) lines.push(`${inner}Note over ${ids.get(span.from)},${ids.get(span.to)}: ${mermaidText(note)}`);
    if (bad) lines.push(`${indent}end`);
  };

  for (const item of items) {
    if (item.event) {
      if (item.event.kind === 'request') request(item.event.span, item.event.answered, '  ');
      else response([item.event.span], '  ');
      continue;
    }
    if (item.spans.length === 1) {
      request(item.spans[0], true, '  ');
      response(item.spans, '  ');
      continue;
    }
    lines.push(`  loop ${item.spans.length} times`);
    request(item.spans[0], true, '    ');
    response(item.spans, '    ');
    lines.push('  end');
  }
  return {
    source: `${lines.join('\n')}\n`,
    title: `${root.method || 'request'} ${requestPath(root.path)}`,
  };
}
