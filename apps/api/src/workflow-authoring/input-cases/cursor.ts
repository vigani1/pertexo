import { z } from 'zod';
import {
  decodeOpaqueCursor,
  encodeOpaqueCursor,
} from '../../platform/http/opaque-cursor.js';
import { InvalidWorkflowCursorError } from '../cursor.js';

const payloadSchema = z
  .object({
    kind: z.literal('workflow_input_case'),
    workspaceId: z.uuid(),
    workflowId: z.uuid(),
    createdAt: z.iso.datetime(),
    id: z.uuid(),
  })
  .strict();
export function encodeInputCaseCursor(
  scope: Readonly<{ workspaceId: string; workflowId: string }>,
  cursor: Readonly<{ createdAt: Date; id: string }>,
): string {
  return encodeOpaqueCursor(payloadSchema, {
    kind: 'workflow_input_case',
    workspaceId: scope.workspaceId,
    workflowId: scope.workflowId,
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  });
}
export function decodeInputCaseCursor(
  value: string,
  scope: Readonly<{ workspaceId: string; workflowId: string }>,
): Readonly<{ createdAt: Date; id: string }> {
  const payload = decodeOpaqueCursor(payloadSchema, value);
  if (
    payload?.workspaceId !== scope.workspaceId ||
    payload.workflowId !== scope.workflowId
  )
    throw new InvalidWorkflowCursorError();
  return { createdAt: new Date(payload.createdAt), id: payload.id };
}
