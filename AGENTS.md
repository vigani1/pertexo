# Project Instructions

## Source of truth

- Follow `docs/workflow-platform-backend-plan.md` as the authoritative
  implementation blueprint.
- Treat `docs/workflow-platform-backend-research.md` as supporting research.
- Keep `docs/implementation-progress.md` current. Update its summary, checklist,
  and concrete evidence whenever a checkpoint changes status; never mark a
  phase complete while required plan criteria remain unfinished.
- Create required ADRs before implementing decisions listed in the plan's ADR
  index.

## Git discipline

- For implementation or documentation work that changes the repository, make
  incremental commits as logical changes become complete. Do not leave all
  changes for one final commit.
- A commit must represent one coherent, reviewable purpose. Do not use a fixed
  commit count or commit separately merely because several files changed.
- Before each commit, inspect `git status` and the staged diff. Stage only files
  belonging to the current logical change; preserve unrelated user changes.
- Run the narrowest relevant verification before committing. Record any check
  that could not be run in the handoff.
- Do not commit broken intermediate states to the main development history.
  Each commit should build and pass the checks relevant to its scope whenever
  the repository has those checks available.
- Use imperative Conventional Commit messages, such as `feat: add API
  bootstrap`, `test: cover workspace RLS`, or `docs: record execution dispatch
  decision`.
- Never amend, squash, rebase, force-push, or otherwise rewrite existing
  history unless the user explicitly requests it.
- Never include secrets, local environment files, generated runtime data, or
  unrelated formatting changes in a commit.
- At handoff, report the commits created and any remaining uncommitted changes.

## Commit checkpoints

Commit when one of these becomes independently reviewable:

- a repository or package foundation;
- one vertical-slice behavior with its relevant tests;
- a schema migration plus the code that safely uses it;
- a focused refactor with unchanged behavior and passing verification;
- an ADR or documentation decision that changes implementation guidance; or
- a bug fix with its regression test.

Large phases must use multiple commits. Tiny file-by-file, formatting-only, or
checkpoint/WIP commits are not useful unless the user explicitly asks for them.
