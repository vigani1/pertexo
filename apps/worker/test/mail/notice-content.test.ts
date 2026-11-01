import { randomUUID } from 'node:crypto';
import type { NoticeMailToSeal } from '@pertexo/core/inbox';
import {
  createApplicationSecretEnvelope,
  openNoticeUnsubscribe,
} from '@pertexo/integrations/server';
import { expect, it } from 'vitest';
import { sealNoticeMail } from '../../src/mail/notice-content.js';

it('bounds a maximum batch with Unicode names and seals an independently scoped unsubscribe link', () => {
  const envelope = createApplicationSecretEnvelope({
    current: {
      version: 'v'.repeat(64),
      key: Buffer.alloc(32, 8).toString('base64'),
    },
  });
  const input: NoticeMailToSeal = {
    id: randomUUID(),
    expiresAt: new Date(Date.now() + 86_400_000),
    toEmail:
      'm'.repeat(64) +
      '@' +
      ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join(
        '.',
      ),
    workspaceName: '🧵'.repeat(70),
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    revision: Number.MAX_SAFE_INTEGER,
    memberRevision: Number.MAX_SAFE_INTEGER,
    items: Array.from({ length: 100 }, () => ({
      id: randomUUID(),
      revision: '9223372036854775807',
      noticeKind: 'workflow_failure',
      name: '🧵'.repeat(70) + 'NOT_DISPLAYED',
      count: 2_147_483_647,
      subjectId: randomUUID(),
      workflowId: randomUUID(),
    })),
  };
  const sealed = sealNoticeMail(
    envelope,
    input.toEmail,
    'https://' +
      ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join(
        '.',
      ),
    input,
  );
  const serialized = envelope.open(
    sealed,
    `pertexo/authentication-mail/workspace_notice/${input.id}/${input.expiresAt.toISOString()}`,
  );
  expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(12_288);
  const message = JSON.parse(serialized) as {
    text: string;
    subject: string;
    unsubscribeUrl: string;
  };
  expect(message.subject).toMatch(/^100 notices:.* — 🧵/u);
  expect(message.subject).not.toMatch(/[\r\n\u2028\u2029]/u);
  expect(new URL(message.unsubscribeUrl).searchParams.get('token')).toBe(
    /unsubscribe#([A-Za-z0-9_-]+)/u.exec(message.text)?.[1],
  );
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
      revision: Number.MAX_SAFE_INTEGER,
      memberRevision: Number.MAX_SAFE_INTEGER,
    },
  );
});

it.each([
  [
    'workflow_failure',
    '\nImport\r\u2028',
    'Workflow failed: Import — Operations',
  ],
  [
    'connection_attention',
    'Billing key',
    'Connection needs attention: Billing key — Operations',
  ],
  [
    'failure_alert_attention',
    'Slack',
    'Failure alerts can’t be delivered: Slack — Operations',
  ],
  ['limit_reached', 'Operations', 'Workspace limit reached — Operations'],
  [
    'limit_approaching',
    'Active runs',
    'Workspace nearing a limit: Active runs — Operations',
  ],
] as const)(
  'names the %s subject and workspace',
  (noticeKind, name, subject) => {
    const envelope = createApplicationSecretEnvelope({
      current: { version: 'v1', key: Buffer.alloc(32, 8).toString('base64') },
    });
    const input: NoticeMailToSeal = {
      id: randomUUID(),
      expiresAt: new Date(Date.now() + 86400000),
      toEmail: 'member@example.test',
      workspaceId: randomUUID(),
      workspaceName: '\nOperations\r\u2029',
      actorId: randomUUID(),
      revision: 1,
      memberRevision: 1,
      items: [
        {
          id: randomUUID(),
          revision: '1',
          noticeKind,
          name,
          count: 1,
          subjectId: randomUUID(),
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
    expect(
      JSON.parse(
        envelope.open(
          sealed,
          `pertexo/authentication-mail/workspace_notice/${input.id}/${input.expiresAt.toISOString()}`,
        ),
      ),
    ).toMatchObject({ subject });
  },
);

it('links mentions to their canonical discussion and fits maximum digest names without copying comments', () => {
  const envelope = createApplicationSecretEnvelope({
    current: { version: 'v1', key: Buffer.alloc(32, 8).toString('base64') },
  });
  const input: NoticeMailToSeal = {
    id: randomUUID(),
    expiresAt: new Date(Date.now() + 86400000),
    toEmail: 'member@example.test',
    workspaceId: randomUUID(),
    workspaceName: '🧵'.repeat(70),
    actorId: randomUUID(),
    revision: 1,
    memberRevision: 1,
    items: Array.from({ length: 100 }, () => ({
      id: randomUUID(),
      revision: '1',
      name: '🧵'.repeat(70),
      count: 1,
      noticeKind: 'workflow_mention',
      subjectId: randomUUID(),
      workflowId: randomUUID(),
      discussion: { threadId: randomUUID(), commentId: randomUUID() },
    })),
  };
  const origin =
    'https://' +
    ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');
  const sealed = sealNoticeMail(
    envelope,
    'notices@example.test',
    origin,
    input,
  );
  const serialized = envelope.open(
    sealed,
    `pertexo/authentication-mail/workspace_notice/${input.id}/${input.expiresAt.toISOString()}`,
  );
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(12288);
  const message = JSON.parse(serialized) as { text: string };
  const urls = message.text
    .split('\n')
    .filter(
      (line) => line.startsWith(origin + '/w/') && line.includes('/comments?'),
    );
  expect(urls.length).toBeGreaterThan(0);
  expect(urls.length).toBeLessThan(25);
  expect(message.text).toContain(String(100 - urls.length) + ' more notices');
  const first = input.items[0];
  if (first?.noticeKind !== 'workflow_mention')
    throw new Error('Mention missing');
  const url = new URL(urls[0] ?? '');
  expect(url.pathname).toBe(
    `/w/${input.workspaceId}/workflows/${first.workflowId}/comments`,
  );
  expect(Object.fromEntries(url.searchParams)).toEqual({
    thread: first.discussion.threadId,
    comment: first.discussion.commentId,
  });
});
