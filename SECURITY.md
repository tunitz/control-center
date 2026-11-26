# Security Policy

## Supported Versions

Security fixes are applied to `main` and released via the latest version tag and container image.

| Version | Supported |
| --- | --- |
| Latest release (`main`) | Yes |
| Older releases | No |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report vulnerabilities privately through GitHub Security Advisories:

- <https://github.com/tunitz/control-center/security/advisories/new>

Include a clear description of the issue, steps to reproduce or proof-of-concept, affected versions/deployment mode, and potential impact. You will receive an acknowledgement as soon as possible.

## Security Model and Scope

- Control Center uses a **single admin password** (argon2id hash + HTTP-only `SameSite=Strict` session cookie) with rate-limited login and setup, plus `x-cc: 1` CSRF protection on all mutations. It is designed for single-operator self-hosting, **not** public multi-tenant exposure.
- Per-unit ed25519 SSH private keys are encrypted at rest with `CC_MASTER_KEY`, and managed units pin SSH host keys on first contact.
- Unit installers configure a dedicated key-only `sshd` (default port `62478`) with forced-command restrictions (`read`, `ack`, `info`, allowlisted `svc-*`, and `power` verbs) and protected system units (`ccagent*`, `ssh`, `sshd`).
- Always terminate **TLS (HTTPS)** at a reverse proxy when accessing Control Center beyond a trusted network, and back up `CC_MASTER_KEY` separately from SQLite backups.
