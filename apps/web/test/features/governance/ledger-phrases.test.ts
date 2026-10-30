import { expect, it } from 'vitest';
import { auditActionWords } from '@/features/governance/model/ledger';

it('names everyday actions instead of reading out their codes', () => {
  for (const [action, words] of [
    ['workflow.run.started', 'started a run'],
    ['workflow.run.replayed', 'ran a run again'],
    ['preview.execution_accepted', 'tested a step'],
    ['workflow.tags.replace', 'changed a workflow’s tags'],
    ['workflow.folder.create', 'created a folder'],
    ['workflow.comment.created', 'commented on a workflow'],
    [
      'workflow.comment.thread.changed',
      'resolved or reopened a comment thread',
    ],
    ['connection.test_dispatched', 'tested a connection'],
  ] as const)
    expect(auditActionWords(action)).toBe(words);
  expect(auditActionWords('schedule.admission_throttled')).toBe(
    'recorded “schedule admission throttled”',
  );
});
it('names a workspace reactivation', () => {
  expect(auditActionWords('workspace.reactivated')).toBe(
    'reactivated the workspace',
  );
});
