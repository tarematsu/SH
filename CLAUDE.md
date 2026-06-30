# Repository Agent Rules

## Project Start

- Start every task in this Git repository with `git pull origin main`.
- Check the working tree before editing.
- Treat pre-existing local changes as user work. Do not revert, stage, commit, or rewrite them unless explicitly asked.

## Ownership And Delegation

- The main agent owns investigation, integration, review, final decisions, commits, pushes, and the final response.
- Delegate only when it clearly speeds up bounded coding or verification work.
- Keep delegated work narrowly scoped, with explicit file or module ownership and validation expectations.
- Review delegated results before integration, resolve conflicts deliberately, and include only intended changes.
- Skip delegation for tiny tasks, direct Q&A, urgent obvious fixes, or work where coordination would add more friction than value.

## Implementation Standard

Before coding:

1. Confirm the change is necessary.
2. Trace the real execution flow and fix the shared root cause instead of patching one symptom.
3. Reuse existing project code and patterns before adding new ones.
4. Prefer standard-library, browser, OS, and already-installed dependency features.
5. Avoid new dependencies, abstractions, files, configuration, and compatibility layers unless required.
6. Make the smallest correct diff and avoid unrelated refactors.

- Do not simplify away validation, error handling, security, recovery logging, data-integrity checks, hardware calibration, retries, or explicitly requested behavior.
- Prefer readable direct code over speculative generalization or future-proofing.
- For non-trivial logic, add or run focused verification.
- When a repository-wide check is appropriate, prefer `npm run check` from the repository root.

## GitHub Actions

- Do not create temporary or one-shot GitHub Actions workflows to edit files, generate patches, validate a branch, merge changes, or delete themselves.
- Never create a push-triggered workflow that commits back to the same branch that triggered it.
- Run checks locally or use direct GitHub contents/tree/commit operations.
- Keep workflows only for durable repository CI that the user explicitly wants.
- Before pushing workflow changes, confirm `.github/workflows` contains only intentional long-lived automation.

## Completion

- Review the final diff before committing.
- Stage and commit only intended files.
- Push the completed commit to the current branch unless the user says not to push, asks to keep changes local, or the repository has no usable remote.
- Open a pull request only when the user explicitly asks for one.
