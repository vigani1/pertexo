import { describe, expect, it } from 'vitest';

import {
  workspaceInboxListQuerySchema,
  workspaceInboxListResponseSchema,
  workspaceInboxReadAllRequestSchema,
  workspaceInboxReadRequestSchema,
  workspaceInboxReadResponseSchema,
  workspaceInboxStreamEventSchema,
  workspaceInboxSummaryResponseSchema,
  workspaceInboxThreadSchema,
} from '../../src/schemas/identity/inbox.js';
import {
  workspaceInboxClientContract,
  workspaceInboxOpenApiDocument,
} from '../../src/server.js';
import { CONTRACT_ARTIFACTS } from '../../src/server.js';

const thread = {
  workflowId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  workflowName: 'Nightly import',
  kind: 'failed',
  occurrenceCount: 3,
  firstOccurredAt: '2026-09-28T10:00:00.000100Z',
  latestOccurredAt: '2026-09-28T11:00:00.000900Z',
  latestRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  latestFailedStep: {
    nodeId: 'fetch',
    label: 'Fetch orders',
    definitionKey: 'core.http',
    safeErrorCode: 'provider.unavailable',
  },
  revision: '9007199254740993',
  unread: true,
};

describe('workspace inbox thread contracts (ADR 055)', () => {
  it.each(['failed', 'timed_out', 'outcome_unknown'])(
    'accepts a %s thread and preserves microseconds and bigint revisions',
    (kind) => {
      expect(workspaceInboxThreadSchema.parse({ ...thread, kind })).toEqual({
        ...thread,
        kind,
      });
    },
  );

  it.each(['succeeded', 'canceled', 'running'])(
    'rejects a non-failure %s thread',
    (kind) => {
      expect(
        workspaceInboxThreadSchema.safeParse({ ...thread, kind }).success,
      ).toBe(false);
    },
  );

  it.each(['recipientId', 'error', 'input', 'output', 'html'])(
    'rejects unexpected %s content',
    (key) => {
      expect(
        workspaceInboxThreadSchema.safeParse({ ...thread, [key]: 'private' })
          .success,
      ).toBe(false);
    },
  );

  it('rejects impossible counts and unsafe revisions or timestamps', () => {
    for (const change of [
      { occurrenceCount: 0 },
      { occurrenceCount: Number.MAX_SAFE_INTEGER + 1 },
      { revision: '01' },
      { revision: '-1' },
      { revision: '1'.repeat(20) },
      { revision: 1 },
      { latestOccurredAt: '2026-09-28T11:00:00.0009001Z' },
      { latestFailedStep: { nodeId: 'fetch' } },
    ])
      expect(
        workspaceInboxThreadSchema.safeParse({ ...thread, ...change }).success,
      ).toBe(false);
    expect(
      workspaceInboxThreadSchema.parse({ ...thread, latestFailedStep: null })
        .latestFailedStep,
    ).toBeNull();
  });

  it('bounds pages and carries the read-all cut', () => {
    expect(
      workspaceInboxListResponseSchema.parse({
        items: [thread],
        nextCursor: 'opaque',
        revision: '42',
      }).revision,
    ).toBe('42');
    expect(
      workspaceInboxListResponseSchema.safeParse({
        items: Array.from({ length: 101 }, () => thread),
        nextCursor: null,
        revision: '42',
      }).success,
    ).toBe(false);
    expect(
      workspaceInboxSummaryResponseSchema.parse({
        unreadCount: 0,
        revision: '0',
      }),
    ).toEqual({ unreadCount: 0, revision: '0' });
    expect(
      workspaceInboxSummaryResponseSchema.safeParse({
        unreadCount: -1,
        revision: '0',
      }).success,
    ).toBe(false);
  });

  it.each([{}, { filter: 'unread', limit: '100', after: 'opaque' }])(
    'accepts bounded query %j',
    (query) => {
      expect(workspaceInboxListQuerySchema.safeParse(query).success).toBe(true);
    },
  );

  it.each([
    { limit: 101 },
    { limit: 0 },
    { after: '' },
    { filter: 'read' },
    { recipientId: thread.workflowId },
  ])('rejects query %j', (query) => {
    expect(workspaceInboxListQuerySchema.safeParse(query).success).toBe(false);
  });

  it('reads only by a seen revision, never for another person', () => {
    for (const schema of [
      workspaceInboxReadRequestSchema,
      workspaceInboxReadAllRequestSchema,
    ]) {
      expect(schema.parse({ revision: '7' })).toEqual({ revision: '7' });
      expect(schema.safeParse({}).success).toBe(false);
      expect(
        schema.safeParse({ revision: '7', recipientId: thread.workflowId })
          .success,
      ).toBe(false);
    }
    expect(
      workspaceInboxReadResponseSchema.parse({
        workflowId: thread.workflowId,
        unread: false,
        revision: '7',
      }).unread,
    ).toBe(false);
  });

  it('keeps stream events content-free', () => {
    expect(
      workspaceInboxStreamEventSchema.parse({
        schemaVersion: 1,
        revision: null,
      }),
    ).toEqual({ schemaVersion: 1, revision: null });
    expect(
      workspaceInboxStreamEventSchema.safeParse({
        schemaVersion: 1,
        revision: '3',
        workflowName: 'Nightly import',
      }).success,
    ).toBe(false);
  });

  it('declares cookie sessions, CSRF on commands and nondisclosing 404s', () => {
    const paths = workspaceInboxOpenApiDocument.paths;
    for (const command of [
      paths['/v1/workspaces/{workspaceId}/notifications/{workflowId}/read']
        .post,
      paths['/v1/workspaces/{workspaceId}/notifications/read-all'].post,
    ]) {
      expect(command.security).toEqual([{ cookieSession: [] }]);
      expect(command.parameters).toContainEqual(
        expect.objectContaining({
          name: 'X-CSRF-Token',
          in: 'header',
          required: true,
        }),
      );
      expect(command.responses).toHaveProperty('404');
    }
    expect(
      paths['/v1/workspaces/{workspaceId}/notifications'].get.responses,
    ).toHaveProperty('404');
    expect(workspaceInboxClientContract.routes).toHaveLength(5);
    expect(
      CONTRACT_ARTIFACTS.filter((artifact) =>
        artifact.fileName.startsWith('workspace-inbox.'),
      ),
    ).toHaveLength(2);
  });
});
