# Security Policy

## Do not report secrets in public issues

If you discover an exposed credential or production identifier, contact the
maintainer privately through GitHub Security Advisories. Do not paste secrets,
chat content, attachments, server addresses, Base tokens, OpenIDs, or business
records into a public issue.

## Deployment responsibilities

- Keep `openclaw.json`, credentials, state snapshots, logs and backups outside
  the repository with restrictive filesystem permissions.
- Configure `AUTOBOARD_FINANCE_RECIPIENT_ALLOWLIST` before enabling financial
  tools or cards.
- Use a dedicated test tenant for `live-self-test`.
- Review Feishu app scopes and grant only the permissions required by the
  enabled modules.
- Treat AI-extracted financial records as drafts until an authorized human
  verifies the source evidence in Feishu.
- Rotate a credential immediately if it appears in Git history, logs or an
  issue. Removing only the latest file version is not sufficient.

## Supported versions

Security fixes are maintained on the latest `main` branch.
