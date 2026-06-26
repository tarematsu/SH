# Global Codex Workflow

## Project start

- When the chat is for a Git project, start unconditionally with `git pull origin main` before inspecting or editing files.
- When the chat is not for a project, do not run `git pull`.
- After pulling, check the working tree and avoid including unrelated user changes in your work.

## Work delegation

- For coding tasks, the main agent owns investigation, integration, review, final decisions, commits, pushes, and the final response.
- By default, have a `gpt-5.4-mini` worker handle bounded implementation or testing work when that can speed up the task.
- Keep delegated work narrowly scoped, with clear file or module ownership and explicit validation expectations.
- The main agent must review delegated results, resolve conflicts, run or verify the relevant checks, and integrate only the intended changes.
- Skip delegation for tiny tasks, simple command checks, direct Q&A, urgent obvious fixes, or work where delegation would add more friction than value.

## Git completion

- After coding work is complete and verified, create a Git commit when the workspace is a Git repository.
- Push the completed commit to the current branch on GitHub by default.
- Review the diff before committing, and do not stage unrelated user changes.
- Do not push when the user says not to push, asks to keep changes local, or the repository has no usable remote.
- Only open a GitHub PR when the user asks for it or the current task explicitly includes PR publication.
