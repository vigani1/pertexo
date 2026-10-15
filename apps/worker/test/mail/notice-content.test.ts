import { randomUUID } from 'node:crypto';
import type { NoticeMailToSeal } from '@pertexo/database/notifications';
import {
  createApplicationSecretEnvelope,
  openNoticeUnsubscribe,
} from '@pertexo/integrations/server';
import { expect, it } from 'vitest';
import { sealNoticeMail } from '../../src/mail/notice-content.js';

it('bounds a maximum batch with Unicode names and seals an independently scoped unsubscribe link', () => {
  const envelope = createApplicationSecretEnvelope({
    current: {
      version: 'notice-test',
      key: Buffer.alloc(32, 8).toString('base64'),
    },
  });
  const input: NoticeMailToSeal = {
    id: randomUUID(),
    expiresAt: new Date(Date.now() + 86_400_000),
    toEmail: 'member@example.test',
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    revision: 7,
    memberRevision: 3,
    items: Array.from({ length: 100 }, () => ({
      id: randomUUID(),
      revision: '9223372036854775807',
      noticeKind: 'workflow_failure',
      name: '\n\r\u2028' + '🧵'.repeat(70) + 'NOT_DISPLAYED',
      count: 2_147_483_647,
      subjectId: randomUUID(),
      workflowId: randomUUID(),
    })),
  };
  const sealed = sealNoticeMail(
    envelope,
    'security@example.test',
    'https://app.example.test',
    input,
  );
  const serialized = envelope.open(
    sealed,
    `pertexo/authentication-mail/workspace_notice/${input.id}/${input.expiresAt.toISOString()}`,
  );
  expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(12_288);
  const message = JSON.parse(serialized) as { text: string; subject: string };
  expect(message.subject).toBe('100 workspace notices');
  expect(message.text.match(/^Workflow failed:/gmu)).toHaveLength(25);
  expect(message.text).toContain('75 more notices');
  expect(message.text).not.toMatch(/NOT_DISPLAYED|[\r\u2028]/u);
  const capability = /unsubscribe#([A-Za-z0-9_-]+)/u.exec(message.text)?.[1];
  if (capability === undefined)
    throw new Error('Unsubscribe capability missing');
  expect(openNoticeUnsubscribe(envelope, capability, new Date())).toMatchObject(
    {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      revision: 7,
      memberRevision: 3,
    },
  );
});
