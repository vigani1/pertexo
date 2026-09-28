import { describe, expect, it } from 'vitest';

import {
  workspaceInboxEntrySchema,
  workspaceInboxListQuerySchema,
  workspaceInboxListResponseSchema,
  workspaceInboxReadRequestSchema,
  workspaceInboxReadResponseSchema,
  workspaceInboxSummaryResponseSchema,
} from '../src/http/workspace-inbox.js';
import {
  workspaceInboxClientContract,
  workspaceInboxOpenApiDocument,
} from '../src/workspace-inbox.js';
import { CONTRACT_ARTIFACTS } from '../src/artifacts.js';

const entry = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  kind: 'failed',
  runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workflowId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  occurredAt: '2026-09-28T10:00:00.000100Z',
  createdAt: '2026-09-28T10:00:00.000900Z',
  expiresAt: '2026-10-28T10:00:00.000900Z',
  readAt: null,
};

describe('private workspace inbox contracts', () => {
  it.each(['failed', 'timed_out', 'outcome_unknown'])(
    'allows %s and preserves microseconds',
    (kind) => {
      expect(workspaceInboxEntrySchema.parse({ ...entry, kind })).toEqual({
        ...entry,
        kind,
      });
    },
  );
  it.each(['succeeded', 'canceled', 'running'])(
    'rejects non-failure %s',
    (kind) => {
      expect(
        workspaceInboxEntrySchema.safeParse({ ...entry, kind }).success,
      ).toBe(false);
    },
  );
  it.each(['recipientId', 'error', 'input', 'providerToken', 'html'])(
    'rejects unexpected %s payload',
    (key) => {
      expect(
        workspaceInboxEntrySchema.safeParse({ ...entry, [key]: 'private' })
          .success,
      ).toBe(false);
    },
  );
  it('preserves bigint revision strings and explicit unread/read state', () => {
    const revision = '9007199254740993';
    expect(
      workspaceInboxListResponseSchema.parse({
        items: [entry],
        nextCursor: null,
        revision,
      }).revision,
    ).toBe(revision);
    expect(
      workspaceInboxReadResponseSchema.parse({
        entry: { ...entry, readAt: '2026-09-28T10:00:01.000123Z' },
        revision,
      }).entry.readAt,
    ).toBe('2026-09-28T10:00:01.000123Z');
    expect(
      workspaceInboxSummaryResponseSchema.parse({
        unreadCount: 0,
        revision: '0',
      }),
    ).toEqual({ unreadCount: 0, revision: '0' });
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
    { recipientId: entry.id },
  ])('rejects query %j', (query) => {
    expect(workspaceInboxListQuerySchema.safeParse(query).success).toBe(false);
  });
  it('rejects unsafe counters, revisions, oversized pages and non-microsecond output', () => {
    for (const revision of ['-1', '01', '1.5', '1e3', '1'.repeat(20), 1]) {
      expect(
        workspaceInboxSummaryResponseSchema.safeParse({
          unreadCount: 0,
          revision,
        }).success,
      ).toBe(false);
    }
    expect(
      workspaceInboxSummaryResponseSchema.safeParse({
        unreadCount: -1,
        revision: '0',
      }).success,
    ).toBe(false);
    expect(
      workspaceInboxSummaryResponseSchema.safeParse({
        unreadCount: Number.MAX_SAFE_INTEGER + 1,
        revision: '0',
      }).success,
    ).toBe(false);
    expect(
      workspaceInboxListResponseSchema.safeParse({
        items: Array.from({ length: 101 }, () => entry),
        revision: '1',
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      workspaceInboxEntrySchema.safeParse({
        ...entry,
        createdAt: '2026-09-28T10:00:00.0009001Z',
      }).success,
    ).toBe(false);
  });
  it('never accepts a recipient or cutoff in the single-read command', () => {
    expect(workspaceInboxReadRequestSchema.parse({})).toEqual({});
    expect(
      workspaceInboxReadRequestSchema.safeParse({ recipientId: entry.id })
        .success,
    ).toBe(false);
  });
  it('declares ordinary cookie/CSRF protection and nondisclosing collection 404', () => {
    const paths = workspaceInboxOpenApiDocument.paths;
    const read =
      paths['/v1/workspaces/{workspaceId}/notifications/{notificationId}/read']
        .post;
    expect(read.security).toEqual([{ cookieSession: [] }]);
    expect(read.parameters).toContainEqual(
      expect.objectContaining({
        name: 'X-CSRF-Token',
        in: 'header',
        required: true,
      }),
    );
    expect(
      paths['/v1/workspaces/{workspaceId}/notifications'].get.responses,
    ).toHaveProperty('404');
    expect(workspaceInboxClientContract.routes).toHaveLength(3);
    expect(
      CONTRACT_ARTIFACTS.filter((artifact) =>
        artifact.fileName.startsWith('workspace-inbox.'),
      ),
    ).toHaveLength(2);
  });
});
