# Traceflow

For any local service implementation, debugging, or test work:

- Call `traceflow_overview` first to inspect compact service health and recent request summaries. Use `traceflow_search_logs` or `traceflow_trace` only to drill into an identified symptom; reserve the verbose `traceflow_snapshot` for cases where those tools are insufficient.
- Call it again after starting or restarting a service, before relying on that runtime state.
- Call it before concluding that a local-runtime issue is resolved or reporting its likely cause.

Keep this focused on local-runtime work; do not call it for unrelated repository tasks.
