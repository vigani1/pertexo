import { createHash } from 'node:crypto';
import { workflowRunStatusSchema } from '@pertexo/contracts';
import { z } from 'zod';

import {
  opaqueCursor,
  decodeOpaqueCursor,
  encodeOpaqueCursor,
} from '../platform/http/opaque-cursor.js';

const filterSchema = z
  .object({
    workflowId: z.uuid().nullable(),
    filterFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    workflowNamePrefix: z.string().min(1).max(128).nullable().optional(),
    status: workflowRunStatusSchema.nullable(),
    createdAtFrom: z.iso.datetime({ offset: true }).nullable(),
    createdAtBefore: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();

const cursorPayloadSchema = opaqueCursor('workflow-runs', {
  workspaceId: z.uuid(),
  order: z.literal('created_at_desc_id_desc'),
  filters: filterSchema,
  createdAt: z.iso.datetime({ precision: 6 }),
  id: z.uuid(),
});

export type WorkflowRunCursorContext = Readonly<{
  workspaceId: string;
  workflowId?: string;
  runValueKey?: string;
  runValue?: string;
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
  const filters = {
    workflowId: context.workflowId ?? null,
    ...(context.workflowNamePrefix === undefined
      ? {}
      : { workflowNamePrefix: context.workflowNamePrefix }),
    status: context.status ?? null,
    createdAtFrom: context.createdAtFrom ?? null,
    createdAtBefore: context.createdAtBefore ?? null,
  };
  if (context.runValueKey === undefined) return filterSchema.parse(filters);
  // Bind the entire combination without letting maximum Unicode filters grow a cursor.
  return filterSchema.parse({
    workflowId: null,
    status: null,
    createdAtFrom: null,
    createdAtBefore: null,
    filterFingerprint: createHash('sha256')
      .update(
        JSON.stringify({
          filters,
          runValueKey: context.runValueKey,
          runValue: context.runValue,
        }),
      )
      .digest('hex'),
  });
}

function normalizeFilters(filters: z.output<typeof filterSchema>) {
  return {
    workflowId: filters.workflowId,
    filterFingerprint: filters.filterFingerprint ?? null,
    workflowNamePrefix: filters.workflowNamePrefix ?? null,
    status: filters.status,
    createdAtFrom: filters.createdAtFrom,
    createdAtBefore: filters.createdAtBefore,
  };
}
