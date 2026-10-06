import {
  normalize,
  hydrateStream,
} from './workflow-execution-value-decoding.js';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { types as nodeTypes } from 'node:util';
import {
  prepareInlineWorkflowExecutionValueV3,
  serializeWorkflowExecutionJsonValueV3,
  type NativeNodeAttemptValueSource,
  parseWorkflowExecutionValueSnapshot,
} from '@pertexo/database/execution';
import { NODE_JSON_LIMITS_V1, type SchemaJson } from '@pertexo/node-sdk';
import { z } from 'zod';

import {
  WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
  assertWorkflowExecutionValueProducer,
  metadataSchema,
  reservationSchema,
  type WorkflowStoredExecutionValueV1,
  type WorkflowExecutionValueOwner,
  type WorkflowExecutionValueProducerOwner,
  type WorkflowExecutionValueCodecDependencies,
  type PreparedWorkflowExecutionValue,
} from './workflow-execution-value-contract.js';

export { WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1 } from './workflow-execution-value-contract.js';
export type {
  WorkflowStoredExecutionValueV1,
  WorkflowExecutionValueOwner,
  WorkflowExecutionValueProducerOwner,
  WorkflowExecutionValueArtifact,
  PreparedWorkflowExecutionValue,
  WorkflowExecutionValueCodecDependencies,
} from './workflow-execution-value-contract.js';

type ArtifactReference = Extract<
  WorkflowStoredExecutionValueV1,
  { kind: 'artifact' }
>;

function invalid(message: string): never {
  throw new TypeError(message);
}
function assertActive(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('The operation was aborted', 'AbortError');
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

type PrepareInput = Readonly<{
  owner: WorkflowExecutionValueProducerOwner;
  value: unknown;
  signal: AbortSignal;
}>;
type HydrateInput = Readonly<{
  owner: WorkflowExecutionValueOwner;
  reference: unknown;
  signal: AbortSignal;
}>;
type HydrateSourceInput = Readonly<{
  owner: WorkflowExecutionValueOwner;
  source: NativeNodeAttemptValueSource;
  signal: AbortSignal;
}>;

async function prepareValue(
  dependencies: Pick<WorkflowExecutionValueCodecDependencies, 'chooseInline'> &
    Partial<
      Pick<WorkflowExecutionValueCodecDependencies, 'reserve' | 'writeReserved'>
    >,
  input: PrepareInput,
): Promise<PreparedWorkflowExecutionValue> {
  assertActive(input.signal);
  assertWorkflowExecutionValueProducer(input.owner);
  const value = normalize(input.value);
  const bytes = Buffer.from(
    serializeWorkflowExecutionJsonValueV3(value),
    'utf8',
  );
  try {
    const sha256 = digest(bytes);
    const byteLength = bytes.byteLength;
    const inline = dependencies.chooseInline(value);
    assertActive(input.signal);
    if (inline !== undefined) {
      const reference = parseReference(inline);
      if (
        reference.kind !== 'inline' ||
        serializeWorkflowExecutionJsonValueV3(reference.value) !==
          serializeWorkflowExecutionJsonValueV3(value)
      )
        invalid('Inline execution value does not match normalized input');
      return Object.freeze({ reference, sha256, byteLength });
    }
    const reserve = dependencies.reserve;
    const writeReserved = dependencies.writeReserved;
    if (reserve === undefined || writeReserved === undefined)
      throw new Error(
        'Native execution value artifact production is not implemented',
      );
    const reservationInput = Object.freeze({
      owner: input.owner,
      byteLength,
      sha256,
      mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
      signal: input.signal,
    });
    const reserved = parseMetadata(
      await reserve(reservationInput),
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
          await writeReserved({
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
        // This is still a candidate: accepted-source authorization cannot
        // precede the actual input/completion/coordinator acceptance transaction.
        // The owner must reuse this exact reservation without inserting/charging.
        await reserve(reservationInput),
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
  dependencies: Pick<
    WorkflowExecutionValueCodecDependencies,
    'authorize' | 'store'
  >,
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

async function hydrateSourceValue(
  dependencies: Pick<
    WorkflowExecutionValueCodecDependencies,
    'authorizeSource'
  > &
    Partial<Pick<WorkflowExecutionValueCodecDependencies, 'store'>>,
  input: HydrateSourceInput,
): Promise<SchemaJson> {
  assertActive(input.signal);
  const requested = parseWorkflowExecutionValueSnapshot(input.source.snapshot);
  const authorize = dependencies.authorizeSource;
  if (authorize === undefined)
    invalid('Native accepted-source authorization is unavailable');
  const envelope = ownEnvelope(
    await authorize(input),
    2,
    'Native accepted-source authorization is invalid',
  );
  assertActive(input.signal);
  if (
    Object.keys(envelope).some(
      (key) => key !== 'snapshot' && key !== 'artifact',
    )
  )
    invalid('Native accepted-source authorization is invalid');
  const accepted = parseWorkflowExecutionValueSnapshot(
    ownEnvelope(
      envelope.snapshot,
      4,
      'Native accepted-source snapshot is invalid',
    ),
  );
  if (
    accepted.sha256 !== requested.sha256 ||
    accepted.byteLength !== requested.byteLength ||
    accepted.serializedValue !== requested.serializedValue ||
    accepted.reference.kind !== requested.reference.kind
  )
    invalid('Native accepted-source byte identity does not agree');
  const reference = accepted.reference;
  if (reference.kind === 'inline') {
    if (
      requested.reference.kind !== 'inline' ||
      serializeWorkflowExecutionJsonValueV3(reference.value) !==
        serializeWorkflowExecutionJsonValueV3(requested.reference.value) ||
      Object.hasOwn(envelope, 'artifact')
    )
      invalid('Native accepted-source reference does not agree');
    return normalize(reference.value);
  }
  if (
    requested.reference.kind !== 'artifact' ||
    reference.artifactId !== requested.reference.artifactId
  )
    invalid('Native accepted-source reference does not agree');
  const artifact = parseMetadata(envelope.artifact, reservationSchema);
  if (
    artifact.sha256 !== accepted.sha256 ||
    artifact.byteLength !== accepted.byteLength
  )
    invalid('Native accepted-source artifact integrity does not agree');
  if (dependencies.store === undefined)
    throw new Error('Native accepted-source artifact read is unavailable');
  // Reuse the actual bounded stream codec after the exact source owner has
  // authorized this descriptor. Never fall back to legacy artifact possession.
  return hydrateValue(
    { store: dependencies.store, authorize: () => Promise.resolve(artifact) },
    { owner: input.owner, reference, signal: input.signal },
  );
}

/** Preparation-only composition of the SAME codec; no fake read/authorization callbacks. */
export function createWorkflowExecutionValuePreparation(
  dependencies: Pick<
    WorkflowExecutionValueCodecDependencies,
    'chooseInline' | 'reserve' | 'writeReserved'
  >,
) {
  return Object.freeze({
    prepare: (input: PrepareInput) => prepareValue(dependencies, input),
  });
}

/** Inline-only composition of the SAME preparation owner; no fake artifact callbacks. */
export function createWorkflowExecutionValueInlinePreparation() {
  return Object.freeze({
    prepare: (input: PrepareInput) =>
      prepareValue(
        { chooseInline: prepareInlineWorkflowExecutionValueV3 },
        input,
      ),
  });
}

/** Read-only composition of the SAME source codec; no fake writer/store owners. */
export function createWorkflowExecutionValueHydrator(
  dependencies: Pick<
    WorkflowExecutionValueCodecDependencies,
    'authorize' | 'store'
  >,
) {
  return Object.freeze({
    hydrate: (input: HydrateInput) => hydrateValue(dependencies, input),
  });
}

/** Read-only composition of the SAME source codec; no fake writer/store owners. */
export function createWorkflowExecutionValueSourceHydrator(
  dependencies: Required<
    Pick<WorkflowExecutionValueCodecDependencies, 'authorizeSource'>
  > &
    Partial<Pick<WorkflowExecutionValueCodecDependencies, 'store'>>,
) {
  return Object.freeze({
    hydrateSource: (input: HydrateSourceInput) =>
      hydrateSourceValue(dependencies, input),
  });
}

/** Stateless codec seam. Callbacks own authority, reservations and artifact lifecycle. */
export function createWorkflowExecutionValueCodec(
  dependencies: WorkflowExecutionValueCodecDependencies,
) {
  return Object.freeze({
    prepare: (input: PrepareInput) => prepareValue(dependencies, input),
    hydrate: (input: HydrateInput) => hydrateValue(dependencies, input),
    hydrateSource: (input: HydrateSourceInput) =>
      hydrateSourceValue(dependencies, input),
  });
}
