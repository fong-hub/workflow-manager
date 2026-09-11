# Project Runtime Rules

## Runtime port startup contract

1. Runtime port resolution is a startup precondition. Select and reserve the port before executing repository `prepareCommand` or `startCommand`.
2. An explicitly requested port must be an integer from `1` to `65535`. Manual ports are overrides and are not restricted to the automatic `runtime.portRange`.
3. When no port is specified, select the first available port from `runtime.portRange`.
4. Check both workflow-manager's in-memory ownership and the operating-system socket before accepting a port. A conflict must reject the start request immediately and must not run repository commands.
5. Recheck the selected port immediately before spawning the runtime because preparation may be slow and an external process may claim the socket meanwhile.
6. Release port ownership after pre-spawn failure, managed-process exit, or stop cleanup. Keep the selected port and failure detail in runtime state for diagnosis.
7. The runtime start API accepts an optional JSON body shaped as `{ "port": 3100 }`; an unavailable port is an HTTP `409 Conflict`.


## Runtime lifecycle persistence contract

8. Runtime process state must survive a Workflow Manager restart: persist the workflow/repository identity, selected worktree, port, PID, and a process birth marker before treating a runtime as running.
9. On startup, reconcile persisted active runtimes with the operating system. Adopt a live process only when its PID is still alive and its birth marker is not reused; otherwise mark the state failed and release its port reservation.
10. A normal `SIGINT`/`SIGTERM` shutdown must stop all managed or adopted runtime process groups before the manager exits. Unexpected termination is recovered by the startup reconciliation path.
11. Port allocation must reconcile adopted runtimes before selecting a new port, so a dead restored process cannot leave a ghost reservation.
