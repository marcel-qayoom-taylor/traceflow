# Traceflow

[![CI](https://github.com/marcel-qayoom-taylor/traceflow/actions/workflows/ci.yml/badge.svg)](https://github.com/marcel-qayoom-taylor/traceflow/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/github/license/marcel-qayoom-taylor/traceflow)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

**See your local Node.js services talk to each other.**

Traceflow discovers local listeners, attaches only when you ask it to, and
turns related HTTP calls into an inspectable sequence diagram with request
details and service logs.

Traceflow is designed for local development. It does not require a hosted
collector or send telemetry.

## Requirements

- Node.js 22 or newer
- macOS or Linux
- `lsof` available on the host

## Quick start

Run without installing:

```bash
npx traceflow-debugger
```

Or install the `traceflow` command globally:

```bash
npm install --global traceflow-debugger
traceflow
```

Run directly from a checkout:

```bash
npm install
npm start
```

Open <http://127.0.0.1:9477>, select **Scan**, and explicitly attach the local
Node.js services you want to inspect. Traceflow never attaches to every open
port automatically.

To try the bundled three-service example:

```bash
npm run demo
```

## How it works

1. Traceflow scans loopback ports for local Node.js services.
2. You choose which processes to attach to or which configured services to start.
3. Traceflow groups related requests and renders the flow, timing, status, and logs.

Everything stays on your machine and captured data is held in memory only.

## Features

- Sequence diagrams for related incoming and outgoing HTTP requests
- Request and response headers and bodies with sensitive values redacted
- Pause, step, and resume controls for local requests
- Explicit attachment to already-running Node.js processes
- Optional service startup from a local config file
- Listener discovery with repository badges
- Collapsed bursts for repeated requests without discarding raw traces
- Local service logs and a read-only MCP diagnostics server

## Configuration

Configuration is optional. Without it, Traceflow starts with an empty service
list and discovers local Node.js listeners through **Scan**.

To define services that Traceflow may start, copy the example into the project
where you run Traceflow:

```bash
cp traceflow.config.example.json traceflow.config.json
```

Relative service working directories are resolved from the config file's
directory. Use `TRACEFLOW_CONFIG` to select another file:

```bash
TRACEFLOW_CONFIG=./config/traceflow.json traceflow
```

`traceflow.config.json` is ignored by Git because commands and environment
values are normally machine-specific.

## Security and privacy

Traceflow can inspect, instrument, start, and stop local processes. Only attach
to processes you own or have permission to inspect.

- The server binds to loopback only.
- Mutating APIs and live streams require a random per-run token.
- Cross-origin and unexpected Host requests are rejected.
- Sensitive headers, query parameters, JSON fields, and common token formats
  are redacted before traces enter the in-memory store.
- Captured data is kept in memory and disappears when Traceflow exits.

Do not expose the Traceflow port through a proxy, tunnel, or public network.
See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Development

```bash
npm test
npm run demo
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## MCP diagnostics

`traceflow-mcp` exposes read-only tools for service health, compact trace
summaries, and log search. It reads the local Traceflow instance at
`http://127.0.0.1:9477`; set `TRACEFLOW_URL` to use another loopback port.

## License

[MIT](LICENSE)
