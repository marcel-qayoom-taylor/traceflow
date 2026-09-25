# Changelog

All notable changes will be documented here.

This project follows Semantic Versioning.

## Unreleased

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
