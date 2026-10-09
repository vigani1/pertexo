import { workflowRunStatusSchema } from '@pertexo/contracts';
import { z } from 'zod';

import {
  decodeOpaqueCursor,
  encodeOpaqueCursor,
} from '../platform/http/opaque-cursor.js';

const filterSchema = z
  .object({
    workflowId: z.uuid().nullable(),
    workflowNamePrefix: z.string().min(1).max(128).nullable().optional(),
    status: workflowRunStatusSchema.nullable(),
    createdAtFrom: z.iso.datetime({ offset: true }).nullable(),
    createdAtBefore: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();

const cursorPayloadSchema = z
  .object({
    kind: z.literal('workflow-runs'),
    workspaceId: z.uuid(),
    order: z.literal('created_at_desc_id_desc'),
    filters: filterSchema,
    createdAt: z.iso.datetime({ precision: 6 }),
    id: z.uuid(),
  })
  .strict();

export type WorkflowRunCursorContext = Readonly<{
  workspaceId: string;
  workflowId?: string;
  workflowNamePrefix?: string;
  status?: z.output<typeof workflowRunStatusSchema>;
  createdAtFrom?: string;
  createdAtBefore?: string;
}>;

class InvalidWorkflowRunCursorError extends TypeError {
  public override readonly name = 'InvalidWorkflowRunCursorError';

  public constructor() {
    super('workflow run cursor is invalid');
  }
}

export function encodeWorkflowRunCursor(
  context: WorkflowRunCursorContext,
  position: Readonly<{ createdAt: string; id: string }>,
): string {
  return encodeOpaqueCursor(cursorPayloadSchema, {
    kind: 'workflow-runs',
    workspaceId: context.workspaceId,
    order: 'created_at_desc_id_desc',
    filters: cursorFilters(context),
    ...position,
  });
}

export function decodeWorkflowRunCursor(
  value: string,
  context: WorkflowRunCursorContext,
): Readonly<{ createdAt: string; id: string }> {
  const payload = decodeOpaqueCursor(cursorPayloadSchema, value);
  if (
    payload?.workspaceId !== context.workspaceId ||
    JSON.stringify(normalizeFilters(payload.filters)) !==
      JSON.stringify(normalizeFilters(cursorFilters(context)))
  )
    throw new InvalidWorkflowRunCursorError();
  return Object.freeze({ createdAt: payload.createdAt, id: payload.id });
}

function cursorFilters(context: WorkflowRunCursorContext) {
  return filterSchema.parse({
    workflowId: context.workflowId ?? null,
    ...(context.workflowNamePrefix === undefined
      ? {}
      : { workflowNamePrefix: context.workflowNamePrefix }),
    status: context.status ?? null,
    createdAtFrom: context.createdAtFrom ?? null,
    createdAtBefore: context.createdAtBefore ?? null,
  });
}

function normalizeFilters(filters: z.output<typeof filterSchema>) {
  return {
    workflowId: filters.workflowId,
    workflowNamePrefix: filters.workflowNamePrefix ?? null,
    status: filters.status,
    createdAtFrom: filters.createdAtFrom,
    createdAtBefore: filters.createdAtBefore,
  };
}
