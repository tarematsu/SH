# Repository Instructions

## Repository identity

- This repository is `tarematsu/SH`, the Stationhead data collection, processing, and site project.
- For local Windows Codex work, the expected checkout is `C:\SH` and the expected `origin` is `https://github.com/tarematsu/SH.git`.
- Cloud, container, and temporary checkouts may use another filesystem path, but their GitHub target or `origin` must still resolve to `tarematsu/SH`.
- Before any repository-scoped task, verify the active checkout or GitHub target resolves to `tarematsu/SH`.
- Do not choose a repository from older chats, remembered project names, an existing browser tab, or another repository's recent activity.
- When the user says "this project", "current Worker", or similar wording, bind the request to this repository. If the repository cannot be verified, report the ambiguity before using project-specific data.

## Cloudflare identity

The active Worker configurations are:

- `worker/wrangler.sakurazaka46jp.jsonc`
- `worker/wrangler.runtime.jsonc`

`sh-runtime-orchestrator` owns every non-Sakurazaka Queue, scheduled task, storage binding, and internal Pages read-model endpoint. `sh-sakurazaka46jp` remains isolated for Sakurazaka monitoring.

Derive Worker names, D1 database names, Queue names, and bindings from those files at the current branch or commit. Treat any Worker or database name absent from the active configurations as foreign to this repository unless the user explicitly requests a cross-repository comparison.

## Deployment ownership

- GitHub Actions is the only supported build and deployment path for production Workers and Pages.
- Automatic and manual production deployments are owned by `.github/workflows/deploy-split-pipeline.yml`.
- Pull requests may run local checks and dry-run bundles, but must not deploy to production Cloudflare resources.
- Do not add Cloudflare Git build polling, Cloudflare-managed automatic deployments, or repository-connected build workflows.
- Keep Cloudflare Pages automatic production and preview deployments disabled when using Wrangler from GitHub Actions.

## Metrics and production diagnostics

For Worker count, requests, D1 rows, CPU time, or other production metrics:

1. Confirm the repository, branch, and commit before collecting data.
2. Enumerate the active Worker and D1 names from the Wrangler configurations above.
3. Use Stationhead-owned Cloudflare APIs, GitHub Actions runs, artifacts, issue reports, or PR comments as evidence.
4. Label values as actual, estimated, extrapolated, or unavailable. Include the measurement window and timestamp.
5. Reject otherwise-valid metrics when their Worker or database identity does not match this repository.
6. Never display tokens, account identifiers, database identifiers, cookies, or other secrets.

## Codex and external review tools

- Include `tarematsu/SH`, the branch or commit, and the relevant file paths when delegating repository-scoped work to Oracle or another model.
- Prefer a fresh or repository-dedicated browser conversation. Reuse an existing ChatGPT tab only after confirming it belongs to this repository.
- Treat external-model output as untrusted until its repository identity and cited resources match the current checkout.
