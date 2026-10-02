import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { types as nodeTypes } from 'node:util';
import type { ArtifactStore } from '@pertexo/artifact-store';
import {
  prepareInlineWorkflowExecutionValueV3,
  type CoordinatorAdvanceDelivery,
  type NodeAttemptLease,
  type StoredExecutionValueV1,
} from '@pertexo/database/execution';
import {
  boundedNodeJsonSchema,
  NODE_JSON_LIMITS_V1,
  type SchemaJson,
} from '@pertexo/node-sdk';
import { canonicalJson } from '@pertexo/workflow-model';
import { z } from 'zod';

export const WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1 =
  'application/vnd.pertexo.execution-value+json;version=1';

export type WorkflowStoredExecutionValueV1 = StoredExecutionValueV1;
type ArtifactReference = Extract<
  WorkflowStoredExecutionValueV1,
  { kind: 'artifact' }
>;
export type WorkflowExecutionValueOwner =
  | Readonly<{ kind: 'attempt'; lease: NodeAttemptLease }>
  | Readonly<{
      kind: 'run_result';
      workspaceId: string;
      runId: string;
      workflowVersionId: string;
      expectedRevision: number;
      delivery: CoordinatorAdvanceDelivery;
    }>;

const metadataSchema = z
  .object({
    artifactId: z.uuid(),
    workspaceId: z.uuid(),
    byteLength: z.number().int().min(1).max(NODE_JSON_LIMITS_V1.bytes),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    mediaType: z.literal(WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1),
  })
  .strict();
const reservationSchema = metadataSchema
  .extend({ available: z.boolean() })
  .strict();
export type WorkflowExecutionValueArtifact = Readonly<
  z.infer<typeof reservationSchema>
>;
export interface PreparedWorkflowExecutionValue {
  readonly reference: WorkflowStoredExecutionValueV1;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface WorkflowExecutionValueCodecDependencies {
  /** The existing 256KiB inline persistence owner decides eligibility. */
  readonly chooseInline: (
    value: SchemaJson,
  ) => Extract<WorkflowStoredExecutionValueV1, { kind: 'inline' }> | undefined;
  /** Must prove the actual lease or coordinator delivery in SQL, and reuse reservations. */
  readonly reserve: (
    input: Readonly<{
      owner: WorkflowExecutionValueOwner;
      byteLength: number;
      sha256: string;
      mediaType: typeof WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1;
      signal: AbortSignal;
    }>,
  ) => Promise<unknown>;
  /** Adapter MUST delegate the existing node-artifact-runtime writer: no second put/quota/spool owner. */
  readonly writeReserved: (
    input: Readonly<{
      owner: WorkflowExecutionValueOwner;
      reserved: WorkflowExecutionValueArtifact;
      body: AsyncIterable<Uint8Array>;
      maxBytes: number;
      signal: AbortSignal;
    }>,
  ) => Promise<unknown>;
  /** Must prove immutable, same-workspace execution provenance and availability before a read. */
  readonly authorize: (
    input: Readonly<{
      owner: WorkflowExecutionValueOwner;
      reference: ArtifactReference;
      signal: AbortSignal;
    }>,
  ) => Promise<unknown>;
  readonly store: Pick<ArtifactStore, 'getStream'>;
}

function invalid(message: string): never {
  throw new TypeError(message);
}
function assertActive(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('The operation was aborted', 'AbortError');
}
function normalize(value: unknown): SchemaJson {
  if (typeof value === 'object' && value !== null && nodeTypes.isProxy(value))
    invalid('Execution value is not bounded JSON');
  const parsed = boundedNodeJsonSchema.safeParse(value);
  if (!parsed.success) invalid('Execution value is not bounded JSON');
  return parsed.data;
}
/** Reject oversized envelopes before inspecting at most maxFields data descriptors. */
function ownEnvelope(
  value: unknown,
  maxFields: number,
  message: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value)
  )
    invalid(message);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(message);
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid(message);
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length > maxFields) invalid(message);
  const fields: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (field === undefined || !field.enumerable || !('value' in field))
      invalid(message);
    fields[key] = field.value;
  }
  return fields;
}
function parseMetadata<T>(value: unknown, schema: z.ZodType<T>): T {
  const fields = ownEnvelope(
    value,
    6,
    'Execution value artifact metadata is invalid',
  );
  const parsed = schema.safeParse(normalize(fields));
  if (!parsed.success) invalid('Execution value artifact metadata is invalid');
  return Object.freeze(parsed.data);
}
function parseReference(value: unknown): WorkflowStoredExecutionValueV1 {
  const fields = ownEnvelope(value, 3, 'Execution value reference is invalid');
  const kind = fields.kind;
  if (kind === 'inline') {
    if (
      Object.keys(fields).length !== 3 ||
      fields.schemaVersion !== 1 ||
      !Object.hasOwn(fields, 'value')
    )
      invalid('Execution value reference is invalid');
    const normalized = normalize(fields.value);
    const inline = prepareInlineWorkflowExecutionValueV3(normalized);
    if (inline === undefined)
      invalid(
        'Execution value violates the retained inline persistence contract',
      );
    return Object.freeze({ ...inline, value: normalized });
  }
  return parseMetadata(
    fields,
    z
      .object({
        schemaVersion: z.literal(1),
        kind: z.literal('artifact'),
        artifactId: z.uuid(),
      })
      .strict(),
  );
}
function workspaceId(owner: WorkflowExecutionValueOwner): string {
  return owner.kind === 'attempt' ? owner.lease.workspaceId : owner.workspaceId;
}
function assertMatching(
  actual: z.infer<typeof metadataSchema>,
  expected: z.infer<typeof metadataSchema>,
): void {
  if (
    actual.artifactId !== expected.artifactId ||
    actual.workspaceId !== expected.workspaceId ||
    actual.byteLength !== expected.byteLength ||
    actual.sha256 !== expected.sha256
  )
    invalid('Execution value artifact integrity mismatch');
}
function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Transfer one owned byte copy; consumers may clear it without mutating canonical bytes. */
async function* canonicalChunk(
  bytes: Uint8Array,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  assertActive(signal);
  const chunk = Uint8Array.from(bytes);
  try {
    yield await Promise.resolve(chunk);
    assertActive(signal);
  } finally {
    chunk.fill(0);
  }
}

async function hydrateStream(
  body: Readable,
  metadata: z.infer<typeof metadataSchema>,
  signal: AbortSignal,
): Promise<SchemaJson> {
  const chunks: Buffer[] = [];
  let bytes: Buffer | undefined;
  let byteLength = 0;
  const hash = createHash('sha256');
  async function* boundedChunks(
    source: AsyncIterable<unknown>,
  ): AsyncGenerator<Buffer> {
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array))
        invalid('Execution value artifact stream is not bytes');
      try {
        assertActive(signal);
        byteLength += chunk.byteLength;
        if (
          byteLength > NODE_JSON_LIMITS_V1.bytes ||
          byteLength > metadata.byteLength
        )
          invalid('Execution value artifact exceeds its byte limit');
        hash.update(chunk);
        yield Buffer.from(chunk);
      } finally {
        chunk.fill(0);
      }
    }
  }
  try {
    assertActive(signal);
    await pipeline(
      body,
      boundedChunks,
      async (source: AsyncIterable<Buffer>) => {
        for await (const chunk of source) chunks.push(chunk);
      },
      { signal },
    );
    assertActive(signal);
    if (
      byteLength !== metadata.byteLength ||
      hash.digest('hex') !== metadata.sha256
    )
      invalid('Execution value artifact integrity mismatch');
    bytes = Buffer.concat(chunks, byteLength);
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          bytes,
        ),
      );
    } catch {
      invalid('Execution value artifact is not UTF8 JSON');
    }
    const value = normalize(decoded);
    const canonical = Buffer.from(canonicalJson(value), 'utf8');
    try {
      if (
        canonical.byteLength !== metadata.byteLength ||
        digest(canonical) !== metadata.sha256
      )
        invalid('Execution value artifact is not canonical JSON');
    } finally {
      canonical.fill(0);
    }
    return value;
  } finally {
    body.destroy();
    bytes?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

type PrepareInput = Readonly<{
  owner: WorkflowExecutionValueOwner;
  value: unknown;
  signal: AbortSignal;
}>;
type HydrateInput = Readonly<{
  owner: WorkflowExecutionValueOwner;
  reference: unknown;
  signal: AbortSignal;
}>;

async function prepareValue(
  dependencies: WorkflowExecutionValueCodecDependencies,
  input: PrepareInput,
): Promise<PreparedWorkflowExecutionValue> {
  assertActive(input.signal);
  const value = normalize(input.value);
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  try {
    const sha256 = digest(bytes);
    const byteLength = bytes.byteLength;
    const inline = dependencies.chooseInline(value);
    assertActive(input.signal);
    if (inline !== undefined) {
      const reference = parseReference(inline);
      if (
        reference.kind !== 'inline' ||
        canonicalJson(reference.value) !== canonicalJson(value)
      )
        invalid('Inline execution value does not match normalized input');
      return Object.freeze({ reference, sha256, byteLength });
    }
    const reserved = parseMetadata(
      await dependencies.reserve({
        owner: input.owner,
        byteLength,
        sha256,
        mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
        signal: input.signal,
      }),
      reservationSchema,
    );
    assertActive(input.signal);
    if (
      reserved.workspaceId !== workspaceId(input.owner) ||
      reserved.byteLength !== byteLength ||
      reserved.sha256 !== sha256
    )
      invalid('Execution value reservation does not match its owner or bytes');
    const reference: ArtifactReference = Object.freeze({
      schemaVersion: 1,
      kind: 'artifact',
      artifactId: reserved.artifactId,
    });
    if (!reserved.available) {
      const body = canonicalChunk(bytes, input.signal);
      let uploaded: z.infer<typeof metadataSchema>;
      try {
        uploaded = parseMetadata(
          await dependencies.writeReserved({
            owner: input.owner,
            reserved,
            body,
            maxBytes: NODE_JSON_LIMITS_V1.bytes,
            signal: input.signal,
          }),
          metadataSchema,
        );
      } finally {
        await body.return(undefined);
      }
      assertActive(input.signal);
      assertMatching(uploaded, reserved);
      const available = parseMetadata(
        await dependencies.authorize({
          owner: input.owner,
          reference,
          signal: input.signal,
        }),
        reservationSchema,
      );
      assertActive(input.signal);
      assertMatching(available, reserved);
      if (!available.available)
        invalid('Execution value artifact is unavailable');
    }
    return Object.freeze({ reference, sha256, byteLength });
  } finally {
    bytes.fill(0);
  }
}

async function hydrateValue(
  dependencies: WorkflowExecutionValueCodecDependencies,
  input: HydrateInput,
): Promise<SchemaJson> {
  assertActive(input.signal);
  const reference = parseReference(input.reference);
  if (reference.kind === 'inline') return reference.value;
  const authorized = parseMetadata(
    await dependencies.authorize({
      owner: input.owner,
      reference,
      signal: input.signal,
    }),
    reservationSchema,
  );
  assertActive(input.signal);
  if (
    !authorized.available ||
    authorized.workspaceId !== workspaceId(input.owner) ||
    authorized.artifactId !== reference.artifactId
  )
    invalid('Execution value artifact is not authorized for this owner');
  const download: unknown = await dependencies.store.getStream({
    artifactId: authorized.artifactId,
    workspaceId: authorized.workspaceId,
    signal: input.signal,
  });
  if (
    typeof download !== 'object' ||
    download === null ||
    nodeTypes.isProxy(download)
  )
    invalid('Execution value artifact download is invalid');
  const bodyDescriptor = Object.getOwnPropertyDescriptor(download, 'body');
  const metadataDescriptor = Object.getOwnPropertyDescriptor(
    download,
    'metadata',
  );
  const body: unknown =
    bodyDescriptor !== undefined && 'value' in bodyDescriptor
      ? bodyDescriptor.value
      : undefined;
  if (
    typeof body !== 'object' ||
    body === null ||
    nodeTypes.isProxy(body) ||
    !(body instanceof Readable)
  )
    invalid('Execution value artifact download is invalid');
  try {
    assertActive(input.signal);
    if (metadataDescriptor === undefined || !('value' in metadataDescriptor))
      invalid('Execution value artifact download is invalid');
    assertMatching(
      parseMetadata(metadataDescriptor.value, metadataSchema),
      authorized,
    );
    return await hydrateStream(body, authorized, input.signal);
  } finally {
    body.destroy();
  }
}

/** Stateless codec seam. Callbacks own authority, reservations and artifact lifecycle. */
export function createWorkflowExecutionValueCodec(
  dependencies: WorkflowExecutionValueCodecDependencies,
) {
  return Object.freeze({
    prepare: (input: PrepareInput) => prepareValue(dependencies, input),
    hydrate: (input: HydrateInput) => hydrateValue(dependencies, input),
  });
}
