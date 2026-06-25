# Global Codex Workflow

## Claude Code planning delegate

For coding tasks, proactively use delegation. Before implementation, ask Claude Code for a short planning review unless the task is tiny or clearly does not benefit from it.

- Prefer a short prompt and a longer timeout when delegating to Claude Code.
- Prefer running `claude --model sonnet -p "<prompt>"` from the target project directory.
- If `claude` is not available in the current process PATH, use `C:\Users\yuuki\.local\bin\claude.exe --model sonnet -p "<prompt>"`.
- Ask Claude Code not to edit files. It should only return a concise Japanese plan, risks, validation points, and alternatives if relevant.
- If Claude Code is unavailable, fails, times out, or asks for missing task context, fall back to a Codex subagent using `gpt-5.5` with medium reasoning effort for the planning review unless the task is tiny.
- Codex owns the default implementation path, file edits, final integration, and the final response.
- Before editing code, check Git synchronization status first, and if the local branch is behind or uncertain, start with `git pull` before making changes.
- Actively look for opportunities to delegate bounded implementation subtasks to Codex subagents, especially for complex implementations, broad refactors, parallelizable work, or clearly separable modules. Assign each subagent a clear scope and file/module ownership, then review and integrate the results in the main Codex thread.
- Actively delegate testing and verification work to Codex subagents after non-trivial changes. Give verification subagents a clear test scope, ask them to run or inspect relevant checks independently, and use their findings before finalizing.
- After coding work is complete and verified, create a Git commit for the completed changes when the workspace is a Git repository, then push it to the current branch on GitHub by default. Review the diff first and avoid including unrelated user changes. Do not push when the user says not to push, asks to keep changes local, or the repository has no usable remote. Only open a GitHub PR when the user asks for it or the current task explicitly includes PR publication.
- Skip this delegation for tiny tasks, simple command checks, direct Q&A, urgent fixes where the plan is obvious, or when calling Claude Code would add more friction than value.
- Mention Claude Code or subagent fallback details only when useful to the user.
