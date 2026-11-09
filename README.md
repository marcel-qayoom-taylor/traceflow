# Traceflow

[![CI](https://github.com/marcel-qayoom-taylor/traceflow/actions/workflows/ci.yml/badge.svg)](https://github.com/marcel-qayoom-taylor/traceflow/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/github/license/marcel-qayoom-taylor/traceflow)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

**See your local Node.js services talk to each other.**

Traceflow discovers local listeners and port-less Node processes such as queue
workers, attaches only when you ask it to, and turns related HTTP calls into an
inspectable sequence diagram with request details and service logs.

Traceflow is designed for local development. It does not require a hosted collector or send telemetry.

<img width="2560" height="1291" alt="Screenshot 2026-09-24 at 12 55 50 pm" src="https://github.com/user-attachments/assets/bf842b18-9234-48fb-b9c9-3ecf13e7b36b" />


## Video

https://github.com/user-attachments/assets/6df8d237-a995-44cd-a413-fbab897a1d31



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

1. Traceflow scans loopback ports for local Node.js services, and terminal-started
   Node.js processes that do not listen on a port.
2. You choose which processes to attach to or which configured services to start.
3. Traceflow groups related requests and renders the flow, timing, status, and logs.

Everything stays on your machine and captured data is held in memory only.

## Features

- Sequence diagrams for related incoming and outgoing HTTP requests
- Browser-to-external fetch and XHR traces for attached local web apps
- Request and response headers and bodies with sensitive values redacted
- Pause, step, and resume controls for local requests
- Explicit attachment to already-running Node.js processes
- Process services for workers without a port, such as `yarn dev:queues`: start,
  stop, read logs, and trace their outbound calls
- Reattach those services after they restart. Turn off Auto-reattach in Settings to stop that.
- Optional service startup from a local config file
- Listener discovery with repository badges
- Collapsed bursts for repeated requests without discarding raw traces
- Status, slow-hop, and pin filters, with failing and slowest hops marked on the diagram
- Pins that keep a trace when older ones expire
- Service logs linked to the request that wrote them
- Local service logs and an MCP server for diagnostics and diagrams
- A local Mermaid editor with colour-coded participants, PNG/SVG copy and
  download, and any captured trace turned into an editable sequence diagram

## Diagrams

Use the **Traces | Diagrams** switch in the header, or go to
`http://127.0.0.1:9477/diagrams`, for a local Mermaid editor. It doesn't need any
services. Type on the left and the preview updates as you go. Drag the divider
to resize the editor, drag the preview to pan, scroll to zoom and double-click
to fit.

- **Export** holds every output: copy PNG (`⌘⇧C`), SVG or the Mermaid source,
  or download PNG, SVG or `.mmd`.
- The default **Colour** theme gives each participant its own colour. The
  settings cog changes the theme and style, the PNG size and transparency, and
  the editor's font size and line wrapping. It also shows where diagrams are
  saved. A `%%{init}%%` theme in the source still takes precedence.
- **From a trace** in the sidebar turns a recently captured trace into a
  diagram, as does **Edit as diagram** on the traces view. **Copy Mermaid** copies
  a trace without saving it. The diagram nests calls, shows the status and
  duration of each response, and marks failures with `--x`. Participants use
  your service names, or the repository name when you haven't set one. Query
  strings are left out.
- Wrap text in backticks for inline code: `` `POST` `/api/orders` including `recaptchaResponse` ``
  draws each part in monospace on a soft background, in the preview and in exports.
  Trace diagrams use this for each method and path. Other Mermaid renderers, such
  as GitHub or mermaid.live, show the backticks as typed.
- Click a message, note or participant in the preview to jump to its line. Put
  the cursor on a line to highlight what it draws.
- The editor colours Mermaid syntax and suggests keywords and participant names
  as you type. Right after an arrow it suggests where the message can go. Use
  `↑`/`↓` and `Enter` or `Tab`, or turn suggestions off in settings.
- **Present** shows the diagram full screen. In a sequence diagram, `→` and
  `←` (or a click) reveal one message at a time, and the view zooms to each new
  message and the participants it involves. Participant names stay pinned to
  the top once their boxes scroll away. Scroll or pinch to zoom, drag to pan,
  press `+`, `-` or `0` (whole diagram), `F` to turn the follow zoom off, and
  `Esc` to exit.
- **Compare** in the sidebar puts two traces side by side. Messages only in A
  are red, messages only in B are green, and responses that got noticeably
  slower in B are amber. It starts with the latest trace and an earlier run of
  the same request.
- Trace diagrams group repeated calls, such as status polling, into one
  `loop N times`, and draw each failed response on a red band. Settings can
  turn grouping off or add shortened request and response bodies as notes.
- Click a syntax error to jump to its line, which is also underlined.
- Diagrams save as you type to `.mmd` files in `~/.traceflow/diagrams`. Set
  `diagramsDir` in `traceflow.config.json` (relative to that file) or
  `TRACEFLOW_DIAGRAMS_DIR` to keep them in a repository. Changes made to a file
  in another editor or by an agent show up straight away.

Mermaid 12.3.0 is bundled under `src/public/vendor` (MIT), so the editor works
offline.

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

### Process services

A service without a `port` is a process service. Traceflow follows it by its
command and working directory instead of by a listening port, which suits queue
workers, schedulers and other programs that only make outbound calls:

```json
{ "name": "queues", "cwd": "../api-service", "command": "yarn dev:queues" }
```

- **Start** runs the command with the Traceflow agent preloaded, so every Node
  process it starts is traced and its output appears in the log panel.
- If you start it yourself in a terminal, Traceflow recognises the running
  process by command and directory. **Attach** connects to the Node processes
  under it (the worker, not `yarn` or a watcher such as `nodemon` or `tsx`),
  and **Stop** ends that process tree.
- Matching uses the parts of the command after the package manager, for example
  `dev:queues`. Set `match` to a string or an array of strings when the running
  command differs from the configured one.
- Process services have no incoming requests. Their outbound calls start new
  traces with the service as the first participant.

**Scan** also lists Node processes without a port that were started from a
terminal inside a Git repository. Attaching one remembers it like a port, and
it is attached again when the same command restarts.

`traceflow.config.json` is ignored by Git because commands and environment
values are normally machine-specific. Attached services are remembered in
`traceflow.services.json`, next to that config, and restored on the next start.

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

Its diagram tools let an agent draw for you: `traceflow_diagrams` and
`traceflow_diagram_read` read the editor's diagrams, `traceflow_diagram_write`
creates or replaces one, and `traceflow_trace_diagram` turns a captured trace
into a sequence diagram and can save it. These are the only MCP tools that
write, and they only write `.mmd` files in the diagrams folder. An open editor
shows each change immediately.

## License

[MIT](LICENSE)

### Service preflight and stacks

Use **Healthcheck** on a service card or the read-only `traceflow_preflight` MCP tool
for repository, installed Node version, missing example environment keys, port
conflicts and readiness checks. Values are never returned. Start blocks on missing
launch prerequisites. Missing example keys are advisory: run `sync-env-example`
in that repository to append defaults. Configure `healthPath` (for example `/ready`)
on a port service to check an HTTP health endpoint; without one, process presence
is not a readiness guarantee. Checks never follow redirects or call remote hosts.

Define named stacks in your local config:

```json
{ "stacks": { "checkout": ["web-app", "api-service"] } }
```

**Settings → Manage stacks** starts members in listed order, reusing processes
already running in the correct directory. It stops at the first failure and keeps
successful starts available for investigation or cleanup. Stop runs in reverse
order and affects only the same process instances that stack started during this
Traceflow session. Services started independently or reused by a stack are left
running. Stop an owning stack only when other tasks no longer need its services.
Worker membership is explicit; starting a stack can start its configured workers.
The read-only `traceflow_stacks` MCP tool lists membership and cleanup ownership.
To check a stack without starting it, call `traceflow_preflight` with
`{ "stack": "checkout" }`. Each member must be running for the stack to be
`ok`. A readiness warning still means that readiness was not verified; `ok`
only means no checks reported an error. The `status` field is `unhealthy` for
errors, `degraded` for warnings, and `healthy` when all checks pass. Running
process services also report the last observed Traceflow agent heartbeat when
available. This confirms agent activity, not queue connectivity or job progress.

Local API: `GET /api/preflight?service=name`, `GET /api/stacks`, and session-token
protected `POST /api/stacks/:name/start` or `/stop`. Lifecycle controls retain the
existing loopback, origin and session-token checks. MCP cannot start or stop stacks.

Stacks wait up to ten seconds for each newly started service with a configured
`healthPath` before starting the next member. Without one, startup confirms only
that the launch was requested. Stack ownership is held in memory for this session.
