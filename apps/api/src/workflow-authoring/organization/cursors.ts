import { z } from 'zod';

import {
  decodeOpaqueCursor,
  encodeOpaqueCursor,
} from '../../platform/http/opaque-cursor.js';
import { InvalidWorkflowCursorError } from '../cursor.js';

/*
 * Opaque keyset positions. A cursor is valid only for the workspace, actor
 * and query it was issued for; it never authorizes anything, so it is not
 * signed (ADR 064 amendment).
 */

const workflowCursorSchema = z
  .object({
    kind: z.literal('workflow-organization'),
    workspaceId: z.uuid(),
    actorId: z.uuid(),
    order: z.enum(['created_asc', 'updated_desc']),
    filterHash: z.string().regex(/^[0-9a-f]{64}$/u),
    positionAt: z.iso.datetime(),
    id: z.uuid(),
  })
  .strict();

const pageCursorSchema = z
  .object({
    kind: z.enum(['tags', 'tag-assignments']),
    workspaceId: z.uuid(),
    actorId: z.uuid(),
    selectedTagId: z.uuid().nullable(),
    id: z.uuid(),
  })
  .strict();

export type WorkflowOrganizationCursorContext = Readonly<{
  workspaceId: string;
  actorId: string;
  order: 'created_asc' | 'updated_desc';
  filterHash: string;
}>;
export type WorkflowOrganizationCursorPosition = Readonly<{
  positionAt: string;
  id: string;
}>;
export type OrganizationPageCursorContext = Readonly<{
  purpose: 'tags' | 'tag-assignments';
  workspaceId: string;
  actorId: string;
  selectedTagId: string | null;
}>;

function decode<T>(value: string, schema: z.ZodType<T>): T {
  const payload = decodeOpaqueCursor(schema, value);
  if (payload === undefined) throw new InvalidWorkflowCursorError();
  return payload;
}

export function encodeWorkflowOrganizationCursor(
  context: WorkflowOrganizationCursorContext,
  position: WorkflowOrganizationCursorPosition,
): string {
  return encodeOpaqueCursor(workflowCursorSchema, {
    kind: 'workflow-organization',
    ...context,
    ...position,
  });
}

export function decodeWorkflowOrganizationCursor(
  value: string,
  context: WorkflowOrganizationCursorContext,
): WorkflowOrganizationCursorPosition {
  const cursor = decode(value, workflowCursorSchema);
  if (
    cursor.workspaceId !== context.workspaceId ||
    cursor.actorId !== context.actorId ||
    cursor.order !== context.order ||
    cursor.filterHash !== context.filterHash
  )
    throw new InvalidWorkflowCursorError();
  return Object.freeze({ positionAt: cursor.positionAt, id: cursor.id });
}

export function encodeOrganizationPageCursor(
  context: OrganizationPageCursorContext,
  id: string,
): string {
  return encodeOpaqueCursor(pageCursorSchema, {
    kind: context.purpose,
    workspaceId: context.workspaceId,
    actorId: context.actorId,
    selectedTagId: context.selectedTagId,
    id,
  });
}

export function decodeOrganizationPageCursor(
  value: string,
  context: OrganizationPageCursorContext,
): string {
  const cursor = decode(value, pageCursorSchema);
  if (
    cursor.kind !== context.purpose ||
    cursor.workspaceId !== context.workspaceId ||
    cursor.actorId !== context.actorId ||
    cursor.selectedTagId !== context.selectedTagId
  )
    throw new InvalidWorkflowCursorError();
  return cursor.id;
}
