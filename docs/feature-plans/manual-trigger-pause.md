# Manual workflow trigger pause

Status: Implemented.

## Scope

People with workflow publish permission can pause a published workflow's
triggers in Workflow settings and resume them with the existing command.
Workflow details and the Workflows list show the pause, and Triggers explains
its effects.

## Rules

- Manual and automatic pauses share one state, revision and pause history.
  A manual pause records its actor and time. An automatic pause records the
  failure streak. Further pauses preserve the current cause.
- Pause and resume check the revision and support exact command retries.
  Repeating a transition at the current revision returns the current state
  without another state change or audit fact.
- Paused schedules record skipped occurrences. Webhooks and forms refuse new
  submissions, polls stop, and failure triggers skip paused targets. Run by
  hand and Test follow their existing admission rules. Archive and restore
  preserve the pause.
- Cover the commands and trigger behavior in core integration, API and web
  tests, with one live pause and resume journey.
