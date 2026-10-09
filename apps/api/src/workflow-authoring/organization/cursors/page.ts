import { z } from 'zod';

import { InvalidWorkflowCursorError } from '../../cursor.js';
import {
  assertSignedCursorLifetime,
  createSignedCursorByteEnvelope,
  currentSignedCursorSeconds,
  SIGNED_CURSOR_MAX_UNIX_SECONDS,
} from './signed.js';

const TTL_SECONDS = 900;
const SUBKEY_LABEL = 'pertexo.workflow.organization.page-cursor-key.v1';
const uuidSchema = z
  .uuid()
  .length(36)
  .regex(/^[0-9a-f-]+(?![\s\S])/u);
const scopeShape = { workspaceId: uuidSchema, actorId: uuidSchema };
const contextSchema = z.discriminatedUnion('purpose', [
  z
    .object({
      ...scopeShape,
      purpose: z.literal('tags'),
      selectedTagId: z.null(),
    })
    .strict(),
  z
    .object({
      ...scopeShape,
      purpose: z.literal('tag-assignments'),
      selectedTagId: uuidSchema,
    })
    .strict(),
]);
const positionSchema = z.object({ id: uuidSchema }).strict();
const secondsSchema = z
  .number()
  .int()
  .min(0)
  .max(SIGNED_CURSOR_MAX_UNIX_SECONDS);
const payloadSchema = z
  .object({
    v: z.literal(1),
    p: z.enum(['tags', 'tag-assignments']),
    w: uuidSchema,
    a: uuidSchema,
    s: uuidSchema.nullable(),
    id: uuidSchema,
    i: secondsSchema,
    e: secondsSchema,
  })
  .strict()
  .refine((payload) =>
    payload.p === 'tags' ? payload.s === null : payload.s !== null,
  );

export type WorkflowOrganizationPageCursorContext = Readonly<
  z.output<typeof contextSchema>
>;
export type WorkflowOrganizationPageCursorPosition = Readonly<
  z.output<typeof positionSchema>
>;
export type WorkflowOrganizationPageCursorCodec = Readonly<{
  encode(
    context: WorkflowOrganizationPageCursorContext,
    position: WorkflowOrganizationPageCursorPosition,
  ): string;
  decode(
    value: string,
    context: WorkflowOrganizationPageCursorContext,
  ): WorkflowOrganizationPageCursorPosition;
}>;

/** Version 1 always orders UUIDs ascending; purpose cannot select another order. */
function canonicalPayload(payload: z.output<typeof payloadSchema>): string {
  return JSON.stringify({
    v: payload.v,
    p: payload.p,
    w: payload.w,
    a: payload.a,
    s: payload.s,
    id: payload.id,
    i: payload.i,
    e: payload.e,
  });
}

/** The stable organization root is injected; this purpose owns a derived subkey. */
export function createWorkflowOrganizationPageCursorCodec(
  key: Uint8Array,
  now: () => number = Date.now,
): WorkflowOrganizationPageCursorCodec {
  const envelope = createSignedCursorByteEnvelope(
    key,
    'Workflow organization page cursor key must contain 32 bytes.',
    SUBKEY_LABEL,
  );
  return Object.freeze({
    encode(context, position): string {
      try {
        const scope = contextSchema.parse(context);
        const cursor = positionSchema.parse(position);
        const issued = currentSignedCursorSeconds(now);
        const payload = payloadSchema.parse({
          v: 1,
          p: scope.purpose,
          w: scope.workspaceId,
          a: scope.actorId,
          s: scope.selectedTagId,
          id: cursor.id,
          i: issued,
          e: issued + TTL_SECONDS,
        });
        const bytes = Buffer.from(canonicalPayload(payload), 'utf8');
        return envelope.encode(bytes);
      } catch {
        throw new InvalidWorkflowCursorError();
      }
    },
    decode(value, context): WorkflowOrganizationPageCursorPosition {
      try {
        const bytes = envelope.authenticate(value);
        const payload = payloadSchema.parse(JSON.parse(bytes.toString('utf8')));
        if (!bytes.equals(Buffer.from(canonicalPayload(payload), 'utf8')))
          throw new InvalidWorkflowCursorError();
        const scope = contextSchema.parse(context);
        assertSignedCursorLifetime(
          payload.i,
          payload.e,
          currentSignedCursorSeconds(now),
          TTL_SECONDS,
        );
        if (
          payload.p !== scope.purpose ||
          payload.w !== scope.workspaceId ||
          payload.a !== scope.actorId ||
          payload.s !== scope.selectedTagId
        )
          throw new InvalidWorkflowCursorError();
        return Object.freeze({ id: payload.id });
      } catch {
        throw new InvalidWorkflowCursorError();
      }
    },
  });
}
