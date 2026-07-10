# Local Release

`sh-monitor` can be deployed from the local Windows machine without waiting for Git-based automation.

## Codex-safe push rule

When Codex needs to push release-helper changes to `main`, include this marker in the commit message:

```text
[codex-local-release]
```

The repository workflow skips push-triggered checks when that marker is present, so Codex-driven local release work does not create duplicate GitHub Actions runs.

## Local release command

From `C:\sh-monitor`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\local-release.ps1
```

## What the script does

1. Confirms the Git worktree is clean.
2. Runs repository checks.
3. Validates and deploys the Cloudflare Worker.
4. Applies every SQL file in `database/migrations` to the production D1 database.
5. Deploys the Pages site from `site/public` with Wrangler.
6. Verifies the Worker health endpoint.

## Requirements

- `wrangler` already authenticated
- Node dependencies installable on the local machine
- Access to the `sh-monitor` D1 database and Pages project

## Notes

- This path avoids Git-based Cloudflare deployment and can be run directly from Codex.
- The Pages project name is taken from `site/wrangler.jsonc` (`skrzk`).
