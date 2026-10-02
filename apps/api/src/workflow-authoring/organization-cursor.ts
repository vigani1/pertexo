import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { InvalidWorkflowCursorError } from './cursor.js';

const MAX_WIRE_BYTES = 512;
const TTL_SECONDS = 15 * 60;
const MAX_UNIX_SECONDS = 253_402_300_799; // Last second of year 9999 UTC.
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
const secondsSchema = z.number().int().min(0).max(MAX_UNIX_SECONDS);
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

function canonicalBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+(?![\s\S])/u.test(value))
    throw new InvalidWorkflowCursorError();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value)
    throw new InvalidWorkflowCursorError();
  return bytes;
}

/** Stable, purpose-specific key material is supplied by the configuration owner. */
export function createWorkflowOrganizationCursorCodec(
  key: Uint8Array,
  now: () => number = Date.now,
): WorkflowOrganizationCursorCodec {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32)
    throw new TypeError(
      'Workflow organization cursor key must contain 32 bytes.',
    );
  const ownedKey = Buffer.from(key);
  const sign = (bytes: Uint8Array): Buffer =>
    createHmac('sha256', ownedKey).update(bytes).digest();
  const currentSeconds = (): number => {
    const millis = now();
    if (
      !Number.isSafeInteger(millis) ||
      millis < 0 ||
      millis > MAX_UNIX_SECONDS * 1000 + 999
    )
      throw new InvalidWorkflowCursorError();
    return Math.floor(millis / 1000);
  };
  return Object.freeze({
    encode(context, position): string {
      try {
        const scope = contextSchema.parse(context);
        const cursor = positionSchema.parse(position);
        const issued = currentSeconds();
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
        const wire = `${bytes.toString('base64url')}.${sign(bytes).toString('base64url')}`;
        if (wire.length > MAX_WIRE_BYTES)
          throw new InvalidWorkflowCursorError();
        return wire;
      } catch {
        throw new InvalidWorkflowCursorError();
      }
    },
    decode(value, context): WorkflowOrganizationCursorPosition {
      try {
        if (
          typeof value !== 'string' ||
          value.length > MAX_WIRE_BYTES ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![\s\S])/u.test(value)
        )
          throw new InvalidWorkflowCursorError();
        const [encoded, signature] = value.split('.');
        if (encoded === undefined || signature === undefined)
          throw new InvalidWorkflowCursorError();
        const bytes = canonicalBase64Url(encoded);
        const suppliedMac = canonicalBase64Url(signature);
        if (
          suppliedMac.byteLength !== 32 ||
          !timingSafeEqual(sign(bytes), suppliedMac)
        )
          throw new InvalidWorkflowCursorError();
        // Only authenticated, bounded bytes reach JSON/schema parsing.
        const payload = payloadSchema.parse(JSON.parse(bytes.toString('utf8')));
        if (!bytes.equals(Buffer.from(canonicalPayload(payload), 'utf8')))
          throw new InvalidWorkflowCursorError();
        const scope = contextSchema.parse(context);
        const current = currentSeconds();
        if (
          payload.i > current ||
          payload.e <= current ||
          payload.e - payload.i !== TTL_SECONDS ||
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
