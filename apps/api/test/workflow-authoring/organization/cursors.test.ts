import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  decodeOrganizationPageCursor,
  decodeWorkflowOrganizationCursor,
  encodeOrganizationPageCursor,
  encodeWorkflowOrganizationCursor,
} from '../../../src/workflow-authoring/organization/cursors.js';

const workspaceId = randomUUID();
const actorId = randomUUID();

describe('workflow organization cursors', () => {
  const context = {
    workspaceId,
    actorId,
    order: 'updated_desc' as const,
    filterHash: 'a'.repeat(64),
  };
  const position = {
    positionAt: '2026-10-09T12:00:00.123456Z',
    id: randomUUID(),
  };

  it('continues a workflow listing only for its workspace, actor and query', () => {
    const cursor = encodeWorkflowOrganizationCursor(context, position);
    expect(decodeWorkflowOrganizationCursor(cursor, context)).toEqual(position);
    for (const other of [
      { ...context, workspaceId: randomUUID() },
      { ...context, actorId: randomUUID() },
      { ...context, order: 'created_asc' as const },
      { ...context, filterHash: 'b'.repeat(64) },
    ])
      expect(() => decodeWorkflowOrganizationCursor(cursor, other)).toThrow(
        'workflow cursor is invalid',
      );
  });

  it('rejects a malformed cursor', () => {
    for (const value of [
      '',
      'not-base64-json',
      Buffer.from('{}').toString('base64url'),
    ])
      expect(() => decodeWorkflowOrganizationCursor(value, context)).toThrow(
        'workflow cursor is invalid',
      );
  });

  it('continues a tag page only for its purpose and selected tag', () => {
    const tags = {
      purpose: 'tags' as const,
      workspaceId,
      actorId,
      selectedTagId: null,
    };
    const id = randomUUID();
    const cursor = encodeOrganizationPageCursor(tags, id);
    expect(decodeOrganizationPageCursor(cursor, tags)).toBe(id);
    expect(() =>
      decodeOrganizationPageCursor(cursor, {
        ...tags,
        purpose: 'tag-assignments',
        selectedTagId: randomUUID(),
      }),
    ).toThrow('workflow cursor is invalid');
    expect(() => decodeWorkflowOrganizationCursor(cursor, context)).toThrow(
      'workflow cursor is invalid',
    );
  });
});
