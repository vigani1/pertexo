import { randomUUID } from 'node:crypto';

import type { NoticeMailToSeal } from '@pertexo/core/inbox';
import { createApplicationSecretEnvelope } from '@pertexo/integrations/server';
import { expect, it } from 'vitest';

import { sealNoticeMail } from '../../src/mail/notice-content.js';

it('tells a person where alerts stopped and where to fix it, in plain words', () => {
  const envelope = createApplicationSecretEnvelope({
    current: { version: 'v1', key: Buffer.alloc(32, 8).toString('base64') },
  });
  const destinationId = randomUUID();
  const input: NoticeMailToSeal = {
    id: randomUUID(),
    expiresAt: new Date(Date.now() + 86_400_000),
    toEmail: 'owner@example.test',
    workspaceId: randomUUID(),
    workspaceName: 'Operations',
    actorId: randomUUID(),
    revision: 1,
    memberRevision: 1,
    items: [
      {
        id: randomUUID(),
        revision: '1',
        noticeKind: 'failure_alert_attention',
        name: 'Slack',
        count: 4,
        subjectId: destinationId,
        workflowId: null,
      },
    ],
  };

  const sealed = sealNoticeMail(
    envelope,
    'security@example.test',
    'https://app.example.test',
    input,
  );
  const { subject, text } = JSON.parse(
    envelope.open(
      sealed,
      `pertexo/authentication-mail/workspace_notice/${input.id}/${input.expiresAt.toISOString()}`,
    ),
  ) as { subject: string; text: string };

  expect(subject).toBe('Failure alerts can’t be delivered: Slack — Operations');
  expect(text).toContain('Failure alerts can’t be delivered: Slack');
  expect(text).toContain(
    `https://app.example.test/w/${input.workspaceId}/settings/alerts?destination=${destinationId}`,
  );
  // The workspace's name only ever appears in the subject, as on every notice.
  expect(text).not.toContain('Operations');
  expect(`${subject}\n${text}`).not.toMatch(
    /dead.?letter|intent|outbox|outcome.?unknown/iu,
  );
});
