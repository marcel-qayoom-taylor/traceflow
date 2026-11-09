# Changelog

All notable changes will be documented here.

This project follows Semantic Versioning.

## Unreleased

- Add process services for Node programs without a port, such as queue workers. Configure one without a `port`, or attach one from **Scan**. Traceflow can start and stop it, show its logs, and trace its outbound calls. It reattaches after a restart, including when a watcher such as `nodemon` or `tsx` restarts the worker.
- Report each service's kind in MCP diagnostics.
- Show each log line from a service Traceflow started once instead of twice, and redact secrets in its piped output too.
- Show why a service is not attached on its card instead of only in the status tooltip, and explain when the Node inspector port is taken.
- Never run two attaches to one service at once.
- Keep spaces in wrapped participant names on the diagram.
- Scan in about a third of the time by reading every process in one `ps` call.

## 0.1.6 - 2026-09-29

- Reattach a service after it restarts when it is the same project you already attached. Auto-reattach is on by default and can be turned off in Settings.

## 0.1.5 - 2026-09-25

- Restart an attached service from its dev command, working directory, and pinned Node version.
- Keep short-lived commands such as `yarn clean` from hanging on the Traceflow agent.
- Let log lines be selected and copied, and still open the related request on click.

## 0.1.4 - 2026-09-25

- Filter the trace list by status, slow hops, or pins.
- Mark failing hops and the slowest hop on the sequence diagram.
- Pin a trace so it stays in memory while older traces expire.
- Link service logs to the request that wrote them.
- Trace browser fetch and XHR calls from attached local web apps.
- Remember attached services and restore them on the next start.

## 0.1.3 - 2026-09-24

- Show repository names or local addresses consistently in service logs.
- Assign distinct, readable colours to unconfigured services.
- Add an empty-state scan hint and backdrop dismissal for the scan dialog.

## 0.1.2 - 2026-09-24

- Add local service aliases and removable service cards.
- Route demo sample requests through Traceflow so they work from the published CLI.
- Improve service controls, spacing, and sample-request feedback.

## 0.1.1 - 2026-09-24

- Fix the installed CLI exiting immediately when invoked through npm's binary symlink.

## 0.1.0 - 2026-09-24

- Prepare Traceflow for its first independent open-source release.
