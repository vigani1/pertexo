import { z } from 'zod';

import { InvalidWorkflowCursorError } from '../../cursor.js';
import {
  assertSignedCursorLifetime,
  createSignedCursorByteEnvelope,
  currentSignedCursorSeconds,
  SIGNED_CURSOR_MAX_UNIX_SECONDS,
} from './signed.js';

const TTL_SECONDS = 15 * 60;
// Unlike $, this end assertion cannot match before a terminal line separator.
const uuidSchema = z
  .uuid()
  .length(36)
  .regex(/^[0-9a-f-]+(?![\s\S])/u);
const timestampSchema = z
  .string()
  .max(27)
  .refine((value) => {
    if (
      !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z(?![\s\S])/u.test(
        value,
      )
    )
      return false;
    const parsed = new Date(value);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 19) === value.slice(0, 19)
    );
  });
const contextSchema = z
  .object({
    workspaceId: uuidSchema,
    actorId: uuidSchema,
    order: z.enum(['created_asc', 'updated_desc']),
    filterHash: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}(?![\s\S])/u),
  })
  .strict();
const positionSchema = z
  .object({ positionAt: timestampSchema, id: uuidSchema })
  .strict();
const secondsSchema = z
  .number()
  .int()
  .min(0)
  .max(SIGNED_CURSOR_MAX_UNIX_SECONDS);
const payloadSchema = z
  .object({
    v: z.literal(1),
    w: uuidSchema,
    a: uuidSchema,
    o: contextSchema.shape.order,
    f: contextSchema.shape.filterHash,
    t: timestampSchema,
    id: uuidSchema,
    i: secondsSchema,
    e: secondsSchema,
  })
  .strict();

export type WorkflowOrganizationCursorContext = Readonly<
  z.output<typeof contextSchema>
>;
export type WorkflowOrganizationCursorPosition = Readonly<
  z.output<typeof positionSchema>
>;
export type WorkflowOrganizationCursorCodec = Readonly<{
  encode(
    context: WorkflowOrganizationCursorContext,
    position: WorkflowOrganizationCursorPosition,
  ): string;
  decode(
    value: string,
    context: WorkflowOrganizationCursorContext,
  ): WorkflowOrganizationCursorPosition;
}>;

/** The fixed field order is part of version 1's canonical signing protocol. */
function canonicalPayload(payload: z.output<typeof payloadSchema>): string {
  return JSON.stringify({
    v: payload.v,
    w: payload.w,
    a: payload.a,
    o: payload.o,
    f: payload.f,
    t: payload.t,
    id: payload.id,
    i: payload.i,
    e: payload.e,
  });
}

/** Stable, purpose-specific key material is supplied by the configuration owner. */
export function createWorkflowOrganizationCursorCodec(
  key: Uint8Array,
  now: () => number = Date.now,
): WorkflowOrganizationCursorCodec {
  const envelope = createSignedCursorByteEnvelope(
    key,
    'Workflow organization cursor key must contain 32 bytes.',
  );
  return Object.freeze({
    encode(context, position): string {
      try {
        const scope = contextSchema.parse(context);
        const cursor = positionSchema.parse(position);
        const issued = currentSignedCursorSeconds(now);
        const payload = payloadSchema.parse({
          v: 1,
          w: scope.workspaceId,
          a: scope.actorId,
          o: scope.order,
          f: scope.filterHash,
          t: cursor.positionAt,
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
    decode(value, context): WorkflowOrganizationCursorPosition {
      try {
        const bytes = envelope.authenticate(value);
        // Only authenticated, bounded bytes reach JSON/schema parsing.
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
          payload.w !== scope.workspaceId ||
          payload.a !== scope.actorId ||
          payload.o !== scope.order ||
          payload.f !== scope.filterHash
        )
          throw new InvalidWorkflowCursorError();
        return Object.freeze({ positionAt: payload.t, id: payload.id });
      } catch {
        throw new InvalidWorkflowCursorError();
      }
    },
  });
}
