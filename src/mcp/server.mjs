#!/usr/bin/env node

import readline from 'node:readline';

const traceflowUrl = process.env.TRACEFLOW_URL || 'http://127.0.0.1:9477';

const tools = [
  {
    name: 'traceflow_overview',
    description: 'Read a compact, token-efficient local Traceflow health overview. Use this first when diagnosing a locally running service; request logs or a trace only when the overview identifies something to investigate.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Optional service name to filter the overview.' },
        traceLimit: { type: 'integer', minimum: 1, maximum: 20, description: 'Recent trace summaries to return. Defaults to 8.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'traceflow_search_logs',
    description: 'Search compact, deduplicated Traceflow log summaries. Use after traceflow_overview identifies a service or symptom; raw logs are deliberately not returned.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Optional service name to filter logs.' },
        query: { type: 'string', description: 'Optional case-insensitive text to match.' },
        level: { type: 'string', enum: ['all', 'error', 'warn'], description: 'Log severity filter. Defaults to all.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Number of grouped log entries to return. Defaults to 20.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'traceflow_trace',
    description: 'Inspect one Traceflow trace by ID. Defaults to span summaries; headers and bodies must be explicitly requested and are redacted/truncated.',
    inputSchema: {
      type: 'object',
      properties: {
        traceId: { type: 'string', description: 'Trace ID returned by traceflow_overview.' },
        include: { type: 'string', enum: ['summary', 'headers', 'bodies'], description: 'Detail level. Defaults to summary.' },
        maxChars: { type: 'integer', minimum: 256, maximum: 12000, description: 'Maximum characters per body when include is bodies. Defaults to 4000.' },
      },
      required: ['traceId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'traceflow_snapshot',
    description: 'Read the legacy, verbose Traceflow snapshot with raw logs. Use only when the compact tools do not provide enough evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'Optional service name to filter logs and request summaries.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async (line) => {
  try {
    const message = JSON.parse(line);
    const response = await handle(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorResponse(null, -32700, error.message))}\n`);
  }
});

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return errorResponse(message?.id ?? null, -32600, 'Invalid JSON-RPC request');
  if (message.method === 'notifications/initialized') return null;
  if (message.method === 'initialize') {
    return result(message.id, {
      protocolVersion: message.params?.protocolVersion || '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'traceflow', version: '0.1.0' },
      instructions: 'Use traceflow_overview first when debugging local running services. It only reads the local Traceflow instance; use traceflow_search_logs and traceflow_trace to drill down. traceflow_snapshot is the legacy verbose escape hatch.',
    });
  }
  if (message.method === 'tools/list') return result(message.id, { tools });
  if (message.method === 'tools/call') return callTool(message.id, message.params || {});
  return errorResponse(message.id, -32601, `Method not found: ${message.method}`);
}

async function callTool(id, params) {
  if (!tools.some((tool) => tool.name === params.name)) return errorResponse(id, -32602, `Unknown tool: ${params.name}`);
  try {
    const state = await fetchState();
    const args = params.arguments || {};
    let content;
    switch (params.name) {
      case 'traceflow_overview':
        content = overview(state, args);
        break;
      case 'traceflow_search_logs':
        content = searchLogs(state, args);
        break;
      case 'traceflow_trace':
        content = traceDetail(state, args);
        break;
      default:
        content = summarize(state, args.service);
    }
    return result(id, { content: [{ type: 'text', text: JSON.stringify(content, null, 2) }] });
  } catch (error) {
    return result(id, {
      isError: true,
      content: [{ type: 'text', text: `Traceflow is not reachable at ${traceflowUrl}: ${error.message}` }],
    });
  }
}

function overview(state, { service, traceLimit = 8 }) {
  const matchesService = (span) => !service || span.from === service || span.to === service;
  const traces = (state.traces || [])
    .map((trace) => traceSummary(trace, matchesService))
    .filter((trace) => trace.spans.length)
    .slice(0, traceLimit);
  const relevantLogs = (state.logEntries || []).filter((entry) => !service || entry.service === service);
  const alerts = groupLogs(relevantLogs.filter((entry) => logLevel(entry.line) !== 'info'), 8);
  const slowSpans = traces.flatMap((trace) => trace.spans
    .filter((span) => span.durationMs !== null && span.durationMs >= 1000)
    .map((span) => ({ traceId: trace.id, ...span })))
    .slice(0, 8);
  return {
    services: (state.services || []).map(({ name, status, agent }) => ({ name, status, agent })),
    alerts,
    slowSpans,
    recentTraces: traces,
  };
}

function searchLogs(state, { service, query = '', level = 'all', limit = 20 }) {
  const needle = query.toLowerCase();
  const entries = (state.logEntries || []).filter((entry) => {
    const entryLevel = logLevel(entry.line);
    return (!service || entry.service === service)
      && (level === 'all' || entryLevel === level)
      && (!needle || entry.line.toLowerCase().includes(needle));
  });
  return { logs: groupLogs(entries, limit) };
}

function traceDetail(state, { traceId, include = 'summary', maxChars = 4000 }) {
  const trace = (state.traces || []).find((item) => item.id === traceId);
  if (!trace) return { error: `Trace ${traceId} was not found. It may have expired from Traceflow's in-memory buffer.` };
  return {
    id: trace.id,
    spans: (trace.spans || []).map((span) => {
      const result = compactSpan(span);
      if (include === 'headers' || include === 'bodies') {
        result.requestHeaders = redactHeaders(span.requestHeaders);
        result.responseHeaders = redactHeaders(span.responseHeaders);
      }
      if (include === 'bodies') {
        result.requestBody = clip(span.requestBody, maxChars);
        result.responseBody = clip(span.responseBody, maxChars);
        result.requestTruncated = !!span.requestTruncated || String(span.requestBody || '').length > maxChars;
        result.responseTruncated = !!span.responseTruncated || String(span.responseBody || '').length > maxChars;
      }
      return result;
    }),
  };
}

function traceSummary(trace, matchesService) {
  return {
    id: trace.id,
    spans: (trace.spans || []).filter(matchesService).map(compactSpan),
  };
}

function compactSpan(span) {
  return {
    from: span.from,
    to: span.to,
    method: span.method,
    path: compactPath(span.path),
    status: span.status,
    durationMs: span.endedAt ? span.endedAt - span.startedAt : null,
    error: span.error ? clip(span.error, 240) : null,
  };
}

function groupLogs(entries, limit) {
  const grouped = new Map();
  for (const entry of entries) {
    const level = logLevel(entry.line);
    const message = clip(entry.line, 360);
    const key = `${entry.service}\u0000${level}\u0000${message}`;
    const current = grouped.get(key) || { service: entry.service, level, message, count: 0 };
    current.count += 1;
    grouped.set(key, current);
  }
  return [...grouped.values()].slice(-limit);
}

function logLevel(line) {
  const text = String(line).toLowerCase();
  if (/\b(error|fatal|exception|failed|failure)\b|\"status\"\s*:\s*5\d\d/.test(text)) return 'error';
  if (/\bwarn(ing)?\b/.test(text)) return 'warn';
  return 'info';
}

function compactPath(path) {
  const value = String(path || '/').split('?')[0];
  return clip(value, 120);
}

function redactHeaders(headers) {
  return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [
    key,
    /^(authorization|cookie|set-cookie|x-api-key)$/i.test(key) ? '[redacted]' : clip(value, 240),
  ]));
}

function clip(value, maxChars) {
  const text = String(value || '');
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

async function fetchState() {
  const response = await fetch(`${traceflowUrl}/api/state`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function summarize(state, service) {
  const matchesService = (span) => !service || span.from === service || span.to === service;
  const services = (state.services || []).map(({ name, port, status, agent }) => ({ name, port, status, agent }));
  const logs = (state.logEntries || [])
    .filter((entry) => !service || entry.service === service)
    .slice(-100);
  const traces = (state.traces || [])
    .map((trace) => ({
      id: trace.id,
      spans: (trace.spans || [])
        .filter(matchesService)
        .map((span) => ({
          from: span.from,
          to: span.to,
          method: span.method,
          path: span.path,
          status: span.status,
          durationMs: span.endedAt ? span.endedAt - span.startedAt : null,
          error: span.error,
        })),
    }))
    .filter((trace) => trace.spans.length)
    .slice(0, 20);
  return { services, logs, traces };
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
