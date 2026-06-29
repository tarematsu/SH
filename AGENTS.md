# Repository Agent Rules

## Project start

- Start work with `git pull origin main`.
- Check the working tree before editing and do not include unrelated local changes.

## Minimal implementation

Before coding:

1. Confirm the requested change is necessary.
2. Reuse existing project code and patterns before adding new ones.
3. Prefer standard-library, browser, OS, and already-installed dependency features.
4. Avoid new dependencies, abstractions, files, configuration, and compatibility layers unless required.
5. Trace the real execution flow and fix the shared root cause instead of patching one symptom.
6. Make the smallest correct diff and do not refactor unrelated code.

- Do not simplify away validation, error handling, security, recovery logging, data-integrity checks, hardware calibration, retries, or explicitly requested behavior.
- For non-trivial logic, add or run one small, relevant verification.
- Prefer readable direct code over speculative generalization or future-proofing.

## GitHub Actions

- Do not create temporary or one-shot GitHub Actions workflows to edit files, generate patches, validate a branch, merge changes, or delete themselves.
- Never create a push-triggered workflow that commits back to the same branch that triggered it.
- Run checks locally or use direct GitHub contents/tree/commit operations. Keep workflows only for durable repository CI that the user explicitly wants.
- Remove obsolete workflow files before pushing and confirm that `.github/workflows` contains only intentional long-lived automation.

## Completion

- Review the final diff, commit only intended files, and push the completed commit unless the user says not to push.
- Open a pull request only when the user explicitly asks for one.
