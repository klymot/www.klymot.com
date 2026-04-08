# Security Policy

## Supported Versions

klymot is a static website. Only the current version deployed from the `main` branch is
supported.

| Version | Supported |
|---------|-----------|
| latest (main) | ✅ |
| older snapshots | ❌ |

## Scope

klymot runs entirely in the browser with no backend, no user accounts, and no server-side
processing. It:

- Fetches static JSON data files bundled in this repository
- Uses MapLibre GL JS and Carto free basemap tiles (third-party CDNs)
- Stores only theme preference in `localStorage`
- Collects no personal data

Because there is no backend or authentication, the attack surface is limited to client-side
vulnerabilities (XSS, dependency issues in vendored/CDN scripts, etc.).

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, use [GitHub's private vulnerability reporting](../../security/advisories/new) to report
the issue confidentially.

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Any suggested mitigations (optional but appreciated)

You can expect an acknowledgement within **7 days** and a resolution or status update within **30
 days**.

## Out of Scope

- Vulnerabilities in third-party services (Carto tile CDN, MapLibre CDN, Google Fonts)
- Issues requiring physical access to the end user's machine
- Social engineering attacks
- Self-XSS (where the attacker must exploit their own browser)
