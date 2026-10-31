# Comments and editing presence

Open a workflow's **Comments** tab to discuss the workflow or a particular step.
A member who can read the workflow can start and reply to threads, resolve and
reopen them. Only a comment's author can edit or delete its text. Discussions
also remain available on archived workflows.

## Start a discussion

Choose **New discussion**, select the workflow or a step and write plain text.
Alternatively, select a step in Build and choose **Discuss this step** from its
menu. Renaming the step preserves its discussion. If the step is removed, the
thread keeps its former name and explains that it is no longer in the draft.

Comments accept up to 8,000 characters. Use **@ Mention** to select up to twenty
current workspace members; selected names appear beside the comment. There is no
special username syntax, HTML or file attachment support.

Mentioned members receive a private Inbox notice linking to the exact comment.
Their existing workflow mute and personal email settings apply. Email is off by
default; when enabled it names the workflow and links to the discussion without
including the comment text. Self-mentions are quiet. Text edits, resolving and
reopening do not notify the same people again. Removing a mention removes its
notice; explicitly adding it again creates a new mention.

## Replies, edits and deletion

Resolve a thread when the discussion is finished and reopen it before replying
again. The unfinished reply stays in place when another member resolves the
thread. Refreshes keep local text and open controls intact.

If another session changed the same comment, saving asks you to review the
latest state. Your local text is kept. If the response to a command is lost,
**Retry the same action** sends that exact command again rather than duplicating
it. Do not start a replacement action until its result is known.

Deleting an opening comment preserves other people's replies. Deleting the last
comment removes the empty thread. Canonical comment text is physically deleted;
audit records retain operation metadata only. Discussion reads load up to twenty
comments at a time. **Older comments**, **Latest replies** and **More
discussions** navigate longer histories.

## See who else is here

The workflow bar shows **N here** when other tabs are viewing the workflow. Open
it to see names, viewing/editing state and unsaved changes. Multiple tabs for
the same member are grouped; your own other tabs are identified too.

A visible tab renews its presence every fifteen seconds. Other tabs refresh it
about every ten seconds; an interrupted, closed or background tab expires after
forty-five seconds without renewing. Presence is advisory: an unavailable
presence service does not stop editing or execution.

An unsaved-changes warning asks you to coordinate before saving. It does not
lock a workflow, merge graphs or reveal unfinished field values. If someone
saves first, the draft revision check still refuses a stale save and pauses
saving. Compare shows both copies; **Keep mine** saves yours over theirs and
**Load theirs** replaces yours. A save the network lost, with nobody else
editing, simply goes again. This is not live multiplayer editing.

## Privacy and retention

Comments follow current workflow read permission; removing a member immediately
removes access. Names-only member discovery never exposes the admin Team email
roster. Comments are kept until deleted or the workflow/workspace is deleted.
Mention notices expire after thirty days without deleting the discussion or
recreating notifications from old comments.

Workflow export, import, duplication and environment promotion never copy
comments, mentions or presence. Presence stores tab identity, editing/dirty
flags and the base draft revision only—never graphs, cursor positions or field
values. Comment text is not copied into audit records, command receipts,
notification mail or live hints.
