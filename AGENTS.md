# Repository Agent Rules

## Project start

- Start work with `git pull origin main`.
- Check the working tree before editing and do not include unrelated local changes.

## GitHub Actions

- Do not create temporary or one-shot GitHub Actions workflows to edit files, generate patches, validate a branch, merge changes, or delete themselves.
- Never create a push-triggered workflow that commits back to the same branch that triggered it.
- Run checks locally or use direct GitHub contents/tree/commit operations. Keep workflows only for durable repository CI that the user explicitly wants.
- Remove obsolete workflow files before pushing and confirm that `.github/workflows` contains only intentional long-lived automation.

## Completion

- Review the final diff, commit only intended files, and push the completed commit unless the user says not to push.
- Open a pull request only when the user explicitly asks for one.
