# Security and local-data boundary

Workflow Foundry separates distributable source code from machine-local operational data.

## Repository-safe content

The source repository must contain only generic implementation, generic examples, and synthetic test data. Do not commit:

- real repository names, branch names, worktree names, or internal project terminology;
- absolute user or workspace paths;
- internal Git remote URLs, service domains, environment names, or deployment targets;
- screenshots captured from a real Registry or workflow list;
- tokens, credentials, private keys, `.env` contents, or authentication headers.

Use synthetic names such as `sample-app`, `sample-service`, and `integration` in tests and documentation.

## Machine-local data

The configured `server.dataDir` stores operational data outside the source repository. With the default configuration this is `~/.workflow-manager`.

`state.json` may contain repository labels, absolute paths, Git remote URLs, runtime commands, release targets, group associations, workflow acceptance snapshots, and migration metadata. Runtime and release logs may contain command output and local paths. Treat the whole data directory as private local data: do not copy it into the repository, attach it to bug reports without redaction, or package it with application builds.

`workflow-manager.local.yaml` is ignored because it may contain machine-specific settings. The committed example configuration must remain generic.

## Screenshots and diagnostics

Before sharing screenshots or logs, redact repository names, branches, commit references, absolute paths, internal domains, and user identifiers. Prefer reproducing UI examples with a temporary synthetic Git repository.
