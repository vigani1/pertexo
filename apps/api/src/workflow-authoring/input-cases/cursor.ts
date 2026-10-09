import { z } from 'zod';
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
  return Buffer.from(
    JSON.stringify(
      payloadSchema.parse({
        kind: 'workflow_input_case',
        workspaceId: scope.workspaceId,
        workflowId: scope.workflowId,
        createdAt: cursor.createdAt.toISOString(),
        id: cursor.id,
      }),
    ),
    'utf8',
  ).toString('base64url');
}
export function decodeInputCaseCursor(
  value: string,
  scope: Readonly<{ workspaceId: string; workflowId: string }>,
): Readonly<{ createdAt: Date; id: string }> {
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value))
      throw new InvalidWorkflowCursorError();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value)
      throw new InvalidWorkflowCursorError();
    const payload = payloadSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (
      payload.workspaceId !== scope.workspaceId ||
      payload.workflowId !== scope.workflowId
    )
      throw new InvalidWorkflowCursorError();
    return { createdAt: new Date(payload.createdAt), id: payload.id };
  } catch {
    throw new InvalidWorkflowCursorError();
  }
}
