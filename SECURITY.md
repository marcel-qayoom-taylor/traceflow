# Security policy

## Supported versions

Security fixes are provided for the latest released version.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do
not open a public issue for a suspected vulnerability.

Include the affected version, reproduction steps, impact, and any suggested
mitigation. Maintainers will acknowledge a report as soon as practical and
coordinate disclosure after a fix is available.

## Local security model

Traceflow is a local development tool. It binds to loopback by default, can
inspect and instrument explicitly selected Node.js processes, and may capture
request metadata and bodies. Do not expose its port to a network or use it
against processes you do not own or have permission to inspect.
