import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  GetObjectCommandOutput,
  PutObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';

import type { ControlLedgerConfig } from './control-ledger-config.js';

const ZERO_HASH = '0'.repeat(64);
const MAX_RECORD_BYTES = 4 * 1024;
const MAX_RECONCILIATION_RECORDS = 100;
const SEQUENCE_WIDTH = 20;

const uuidSchema = z.uuid();
const sequenceSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);

const recordBaseSchema = z
  .object({
    actorRef: boundedText(128),
    commandId: uuidSchema,
    commandType: z.enum([
      'legal_hold_placed',
      'legal_hold_released',
      'deletion_requested',
      'deletion_restored',
      'purge_started',
      'deletion_completed',
    ]),
    occurredAt: z.iso.datetime({ offset: true }),
    previousHash: hashSchema,
    reason: boundedText(512),
    recordHash: hashSchema,
    schemaVersion: z.literal(1),
    sequence: sequenceSchema,
    subjectId: uuidSchema,
    workspaceId: uuidSchema,
  })
  .strict();

const controlLedgerRecordSchema = z.discriminatedUnion('commandType', [
  recordBaseSchema.extend({
    commandType: z.literal('legal_hold_placed'),
    legalAuthority: boundedText(256),
  }),
  recordBaseSchema.extend({
    commandType: z.literal('legal_hold_released'),
    legalAuthority: boundedText(256),
  }),
  recordBaseSchema.extend({
    commandType: z.literal('deletion_requested'),
    legalAuthority: boundedText(256).optional(),
  }),
  recordBaseSchema.extend({
    commandType: z.literal('deletion_restored'),
    legalAuthority: boundedText(256).optional(),
  }),
  recordBaseSchema.extend({
    commandType: z.literal('purge_started'),
    legalAuthority: boundedText(256).optional(),
  }),
  recordBaseSchema.extend({
    commandType: z.literal('deletion_completed'),
    legalAuthority: boundedText(256).optional(),
  }),
]);

const appendSchema = z.discriminatedUnion('commandType', [
  recordBaseSchema.omit({ recordHash: true, schemaVersion: true }).extend({
    commandType: z.literal('legal_hold_placed'),
    legalAuthority: boundedText(256),
  }),
  recordBaseSchema.omit({ recordHash: true, schemaVersion: true }).extend({
    commandType: z.literal('legal_hold_released'),
    legalAuthority: boundedText(256),
  }),
  recordBaseSchema.omit({ recordHash: true, schemaVersion: true }).extend({
    commandType: z.literal('deletion_requested'),
    legalAuthority: boundedText(256).optional(),
  }),
  recordBaseSchema.omit({ recordHash: true, schemaVersion: true }).extend({
    commandType: z.literal('deletion_restored'),
    legalAuthority: boundedText(256).optional(),
  }),
  recordBaseSchema.omit({ recordHash: true, schemaVersion: true }).extend({
    commandType: z.literal('purge_started'),
    legalAuthority: boundedText(256).optional(),
  }),
  recordBaseSchema.omit({ recordHash: true, schemaVersion: true }).extend({
    commandType: z.literal('deletion_completed'),
    legalAuthority: boundedText(256).optional(),
  }),
]);

export type ControlLedgerRecord = z.output<typeof controlLedgerRecordSchema>;
export type AppendControlLedgerRecord = z.input<typeof appendSchema> & {
  readonly signal?: AbortSignal;
};

export interface ControlLedgerReadRequest {
  readonly sequence: number;
  readonly signal?: AbortSignal;
  readonly workspaceId: string;
}

export interface ReconcileControlLedgerRequest {
  readonly maxRecords: number;
  readonly projectedHash: string;
  readonly projectedSequence: number;
  readonly signal?: AbortSignal;
  readonly workspaceId: string;
}

export interface ControlLedgerReconciliation {
  readonly hasMore: boolean;
  readonly pageEndHash: string;
  readonly pageEndSequence: number;
  readonly reachedHighWater: boolean;
  readonly records: readonly ControlLedgerRecord[];
}

export interface ControlLedgerReadiness {
  readonly bucket: string;
  readonly minRetentionDays: number;
  readonly prefix: 'control-ledger/workspaces/';
}

export interface ControlLedger {
  append(request: AppendControlLedgerRecord): Promise<ControlLedgerRecord>;
  checkReadiness(signal?: AbortSignal): Promise<ControlLedgerReadiness>;
  close(): void;
  read(request: ControlLedgerReadRequest): Promise<ControlLedgerRecord | null>;
  reconcile(
    request: ReconcileControlLedgerRequest,
  ): Promise<ControlLedgerReconciliation>;
}

export interface ControlLedgerS3Client {
  destroy(): void;
  send(
    command:
      | GetBucketVersioningCommand
      | GetBucketLifecycleConfigurationCommand
      | GetBucketPolicyCommand
      | GetObjectCommand
      | GetObjectLockConfigurationCommand
      | HeadBucketCommand
      | ListObjectsV2Command
      | PutObjectCommand,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<unknown>;
}

export class ControlLedgerReadinessError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ControlLedgerReadinessError';
  }
}

export class ControlLedgerConflictError extends Error {
  public constructor() {
    super('Control ledger sequence already contains a different record');
    this.name = 'ControlLedgerConflictError';
  }
}

export class ControlLedgerIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ControlLedgerIntegrityError';
  }
}

export class ControlLedgerClosedError extends Error {
  public constructor() {
    super('Control ledger is closed');
    this.name = 'ControlLedgerClosedError';
  }
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value !== 'object') {
    throw new ControlLedgerIntegrityError('Control ledger value is not JSON');
  }
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function recordMaterial(
  record: ControlLedgerRecord,
): Omit<ControlLedgerRecord, 'recordHash'> {
  const { recordHash, ...material } = record;
  void recordHash;
  return material;
}

function hashMaterial(material: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(material), 'utf8')
    .digest('hex');
}

function recordKey(workspaceId: string, sequence: number): string {
  return `control-ledger/workspaces/${workspaceId}/records/${String(sequence).padStart(SEQUENCE_WIDTH, '0')}.json`;
}

function requestSignal(
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return externalSignal === undefined
    ? timeoutSignal
    : AbortSignal.any([externalSignal, timeoutSignal]);
}

function hasErrorName(error: unknown, name: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { readonly name?: string }).name === name;
}

function isPreconditionFailed(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    readonly $metadata?: { readonly httpStatusCode?: number };
    readonly name?: string;
  };
  return (
    candidate.$metadata?.httpStatusCode === 412 ||
    candidate.name === 'PreconditionFailed'
  );
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Control ledger read aborted');
}

function actionPatternMatches(pattern: string, action: string): boolean {
  const expression = pattern
    .replaceAll(/[.+?^${}()|[\]\\]/gu, '\\$&')
    .replaceAll('*', '.*');
  return new RegExp(`^${expression}$`, 'iu').test(action);
}

function values(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value;
  }
  return [];
}

function resourceCoversLedger(resource: string, bucket: string): boolean {
  const requiredPrefix = `arn:aws:s3:::${bucket}/control-ledger/`;
  if (!resource.endsWith('*')) return false;
  const coveredPrefix = resource.slice(0, -1);
  return (
    coveredPrefix.startsWith(`arn:aws:s3:::${bucket}/`) &&
    requiredPrefix.startsWith(coveredPrefix)
  );
}

function isMissingIfNoneMatchCondition(condition: unknown): boolean {
  if (typeof condition !== 'object' || condition === null) return false;
  const operators = Object.entries(condition as Record<string, unknown>);
  if (operators.length !== 1 || operators[0]?.[0] !== 'Null') return false;
  const nullCondition = operators[0][1];
  if (typeof nullCondition !== 'object' || nullCondition === null) return false;
  const entries = Object.entries(nullCondition as Record<string, unknown>);
  // IAM Null with "true" matches requests where this condition key is absent.
  return (
    entries.length === 1 &&
    entries[0]?.[0] === 's3:if-none-match' &&
    entries[0][1] === 'true'
  );
}

function policyProtection(
  policyText: string,
  bucket: string,
): Readonly<{ deletesDenied: boolean; missingIfNoneMatchDenied: boolean }> {
  let policy: unknown;
  try {
    policy = JSON.parse(policyText) as unknown;
  } catch {
    return { deletesDenied: false, missingIfNoneMatchDenied: false };
  }
  if (typeof policy !== 'object' || policy === null) {
    return { deletesDenied: false, missingIfNoneMatchDenied: false };
  }
  const statementValue = (policy as { readonly Statement?: unknown }).Statement;
  const statements = Array.isArray(statementValue)
    ? statementValue
    : [statementValue];
  const requiredActions = new Set([
    's3:DeleteObject',
    's3:DeleteObjectVersion',
    's3:ReplicateDelete',
    's3:ReplicateObject',
  ]);
  let missingIfNoneMatchDenied = false;
  for (const statement of statements) {
    if (typeof statement !== 'object' || statement === null) continue;
    const candidate = statement as {
      readonly Action?: unknown;
      readonly Condition?: unknown;
      readonly Effect?: unknown;
      readonly Principal?: unknown;
      readonly Resource?: unknown;
    };
    const coversLedger = values(candidate.Resource).some((resource) =>
      resourceCoversLedger(resource, bucket),
    );
    if (
      candidate.Effect !== 'Deny' ||
      candidate.Principal !== '*' ||
      !coversLedger
    ) {
      continue;
    }
    if (candidate.Condition === undefined) {
      for (const required of requiredActions) {
        if (
          values(candidate.Action).some((pattern) =>
            actionPatternMatches(pattern, required),
          )
        ) {
          requiredActions.delete(required);
        }
      }
    }
    if (
      isMissingIfNoneMatchCondition(candidate.Condition) &&
      values(candidate.Action).some((pattern) =>
        actionPatternMatches(pattern, 's3:PutObject'),
      )
    ) {
      missingIfNoneMatchDenied = true;
    }
  }
  return {
    deletesDenied: requiredActions.size === 0,
    missingIfNoneMatchDenied,
  };
}

async function boundedBody(
  output: GetObjectCommandOutput,
  signal: AbortSignal,
): Promise<Buffer> {
  if (
    output.ContentLength === undefined ||
    output.ContentLength < 1 ||
    output.ContentLength > MAX_RECORD_BYTES ||
    output.ContentType !== 'application/json'
  ) {
    if (output.Body instanceof Readable) output.Body.destroy();
    throw new ControlLedgerIntegrityError(
      'Control ledger object metadata is invalid',
    );
  }
  if (!(output.Body instanceof Readable)) {
    throw new ControlLedgerIntegrityError(
      'Control ledger object body is not streamable',
    );
  }

  const body = output.Body;
  const abort = (): void => {
    body.destroy(abortError(signal));
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const chunks: Buffer[] = [];
  let byteLength = 0;
  try {
    for await (const chunk of body) {
      const bytes = Buffer.from(chunk as Uint8Array);
      byteLength += bytes.byteLength;
      if (byteLength > MAX_RECORD_BYTES || byteLength > output.ContentLength) {
        throw new ControlLedgerIntegrityError(
          'Control ledger object exceeds its bound',
        );
      }
      chunks.push(bytes);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    if (!body.destroyed) body.destroy();
  }
  if (byteLength !== output.ContentLength) {
    throw new ControlLedgerIntegrityError(
      'Control ledger object length is invalid',
    );
  }
  const bytes = Buffer.concat(chunks);
  if (
    output.ChecksumSHA256 !== undefined &&
    output.ChecksumSHA256 !==
      createHash('sha256').update(bytes).digest('base64')
  ) {
    throw new ControlLedgerIntegrityError(
      'Control ledger object checksum is invalid',
    );
  }
  return bytes;
}

function parseRecord(
  bytes: Buffer,
  workspaceId: string,
  sequence: number,
): ControlLedgerRecord {
  let untrusted: unknown;
  try {
    untrusted = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new ControlLedgerIntegrityError(
      'Control ledger object is not valid JSON',
    );
  }
  const parsed = controlLedgerRecordSchema.safeParse(untrusted);
  if (!parsed.success) {
    throw new ControlLedgerIntegrityError(
      'Control ledger record contract is invalid',
    );
  }
  const record = parsed.data;
  const canonicalBytes = Buffer.from(canonicalJson(record), 'utf8');
  if (!bytes.equals(canonicalBytes)) {
    throw new ControlLedgerIntegrityError(
      'Control ledger record is not canonical JSON',
    );
  }
  if (record.workspaceId !== workspaceId || record.sequence !== sequence) {
    throw new ControlLedgerIntegrityError(
      'Control ledger record identity is invalid',
    );
  }
  if (record.sequence === 1 && record.previousHash !== ZERO_HASH) {
    throw new ControlLedgerIntegrityError(
      'First control ledger record does not use the zero hash',
    );
  }
  if (record.recordHash !== hashMaterial(recordMaterial(record))) {
    throw new ControlLedgerIntegrityError(
      'Control ledger record hash is invalid',
    );
  }
  return Object.freeze(record);
}

class AwsControlLedger implements ControlLedger {
  private closed = false;

  public constructor(
    private readonly config: ControlLedgerConfig,
    private readonly client: ControlLedgerS3Client,
    private readonly ownsClient: boolean,
    private readonly now: () => Date,
  ) {}

  public async append(
    request: AppendControlLedgerRecord,
  ): Promise<ControlLedgerRecord> {
    this.assertOpen();
    await this.checkReadiness(request.signal);
    const { signal: requestAbortSignal, ...untrustedCommand } = request;
    requestAbortSignal?.throwIfAborted();
    const command = appendSchema.parse(untrustedCommand);
    if (command.sequence === 1) {
      if (command.previousHash !== ZERO_HASH) {
        throw new ControlLedgerIntegrityError(
          'First control ledger record must use the zero hash',
        );
      }
    } else {
      const predecessor = await this.read({
        sequence: command.sequence - 1,
        ...(requestAbortSignal === undefined
          ? {}
          : { signal: requestAbortSignal }),
        workspaceId: command.workspaceId,
      });
      if (predecessor === null) {
        throw new ControlLedgerIntegrityError(
          'Control ledger predecessor is missing',
        );
      }
      if (predecessor.recordHash !== command.previousHash) {
        throw new ControlLedgerIntegrityError(
          'Control ledger previous hash does not match predecessor',
        );
      }
    }

    const material = { ...command, schemaVersion: 1 as const };
    const record = controlLedgerRecordSchema.parse({
      ...material,
      recordHash: hashMaterial(material),
    });
    const bytes = Buffer.from(canonicalJson(record), 'utf8');
    if (bytes.byteLength > MAX_RECORD_BYTES) {
      throw new ControlLedgerIntegrityError(
        'Control ledger record exceeds its bound',
      );
    }
    const signal = requestSignal(
      this.config.requestTimeoutMs,
      requestAbortSignal,
    );
    try {
      const output = (await this.client.send(
        new PutObjectCommand({
          Body: bytes,
          Bucket: this.config.bucket,
          ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
          ContentLength: bytes.byteLength,
          ContentType: 'application/json',
          IfNoneMatch: '*',
          Key: recordKey(record.workspaceId, record.sequence),
          ObjectLockMode: 'COMPLIANCE',
          ObjectLockRetainUntilDate: new Date(
            this.now().getTime() +
              this.config.minRetentionDays * 24 * 60 * 60 * 1_000,
          ),
        }),
        { abortSignal: signal },
      )) as PutObjectCommandOutput;
      const checksum = createHash('sha256').update(bytes).digest('base64');
      if (
        output.ChecksumSHA256 !== undefined &&
        output.ChecksumSHA256 !== checksum
      ) {
        throw new ControlLedgerIntegrityError(
          'Control ledger write checksum is invalid',
        );
      }
      return Object.freeze(record);
    } catch (error: unknown) {
      if (!isPreconditionFailed(error)) throw error;
      const existing = await this.read({
        sequence: record.sequence,
        ...(requestAbortSignal === undefined
          ? {}
          : { signal: requestAbortSignal }),
        workspaceId: record.workspaceId,
      });
      if (
        existing !== null &&
        canonicalJson(existing) === bytes.toString('utf8')
      ) {
        return existing;
      }
      throw new ControlLedgerConflictError();
    }
  }

  public async checkReadiness(
    signal?: AbortSignal,
  ): Promise<ControlLedgerReadiness> {
    this.assertOpen();
    const options = {
      abortSignal: requestSignal(this.config.requestTimeoutMs, signal),
    };
    try {
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.config.bucket }),
        options,
      );
      const versioning = (await this.client.send(
        new GetBucketVersioningCommand({ Bucket: this.config.bucket }),
        options,
      )) as { readonly Status?: string };
      if (versioning.Status !== 'Enabled') {
        throw new ControlLedgerReadinessError(
          'Control ledger bucket versioning must be Enabled',
        );
      }
      const lock = (await this.client.send(
        new GetObjectLockConfigurationCommand({ Bucket: this.config.bucket }),
        options,
      )) as {
        readonly ObjectLockConfiguration?: {
          readonly ObjectLockEnabled?: string;
          readonly Rule?: {
            readonly DefaultRetention?: {
              readonly Days?: number;
              readonly Mode?: string;
              readonly Years?: number;
            };
          };
        };
      };
      const configuration = lock.ObjectLockConfiguration;
      const retention = configuration?.Rule?.DefaultRetention;
      if (configuration?.ObjectLockEnabled !== 'Enabled') {
        throw new ControlLedgerReadinessError(
          'Control ledger bucket Object Lock must be Enabled',
        );
      }
      if (retention?.Mode !== 'COMPLIANCE') {
        throw new ControlLedgerReadinessError(
          'Control ledger bucket default retention must use COMPLIANCE mode',
        );
      }
      const retentionDays =
        retention.Days ??
        (retention.Years === undefined ? undefined : retention.Years * 365);
      if (
        retentionDays === undefined ||
        retentionDays < this.config.minRetentionDays
      ) {
        throw new ControlLedgerReadinessError(
          'Control ledger bucket default retention is below the configured minimum',
        );
      }
      try {
        const lifecycle = (await this.client.send(
          new GetBucketLifecycleConfigurationCommand({
            Bucket: this.config.bucket,
          }),
          options,
        )) as { readonly Rules?: readonly unknown[] };
        if (lifecycle.Rules === undefined || lifecycle.Rules.length > 0) {
          throw new ControlLedgerReadinessError(
            'Control ledger bucket must have no lifecycle rules',
          );
        }
      } catch (error: unknown) {
        if (!hasErrorName(error, 'NoSuchLifecycleConfiguration')) throw error;
      }
      const policy = (await this.client.send(
        new GetBucketPolicyCommand({ Bucket: this.config.bucket }),
        options,
      )) as { readonly Policy?: string };
      const protection = policyProtection(
        policy.Policy ?? '',
        this.config.bucket,
      );
      if (!protection.deletesDenied) {
        throw new ControlLedgerReadinessError(
          'Control ledger bucket policy must unconditionally deny object deletion, version deletion, and replication mutation',
        );
      }
      if (!protection.missingIfNoneMatchDenied) {
        throw new ControlLedgerReadinessError(
          'Control ledger bucket policy must deny writes missing If-None-Match',
        );
      }
    } catch (error: unknown) {
      if (options.abortSignal.aborted) {
        options.abortSignal.throwIfAborted();
      }
      if (error instanceof ControlLedgerReadinessError) throw error;
      throw new ControlLedgerReadinessError(
        'Control ledger bucket readiness could not be verified',
      );
    }
    options.abortSignal.throwIfAborted();
    return Object.freeze({
      bucket: this.config.bucket,
      minRetentionDays: this.config.minRetentionDays,
      prefix: 'control-ledger/workspaces/' as const,
    });
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsClient) this.client.destroy();
  }

  public async read(
    request: ControlLedgerReadRequest,
  ): Promise<ControlLedgerRecord | null> {
    this.assertOpen();
    const identity = z
      .object({ sequence: sequenceSchema, workspaceId: uuidSchema })
      .parse(request);
    const signal = requestSignal(this.config.requestTimeoutMs, request.signal);
    let output: GetObjectCommandOutput;
    try {
      output = (await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          ChecksumMode: 'ENABLED',
          Key: recordKey(identity.workspaceId, identity.sequence),
        }),
        { abortSignal: signal },
      )) as GetObjectCommandOutput;
    } catch (error: unknown) {
      if (hasErrorName(error, 'NoSuchKey')) return null;
      throw error;
    }
    return parseRecord(
      await boundedBody(output, signal),
      identity.workspaceId,
      identity.sequence,
    );
  }

  public async reconcile(
    request: ReconcileControlLedgerRequest,
  ): Promise<ControlLedgerReconciliation> {
    this.assertOpen();
    await this.checkReadiness(request.signal);
    const parsed = z
      .object({
        maxRecords: z.number().int().min(1).max(MAX_RECONCILIATION_RECORDS),
        projectedHash: hashSchema,
        projectedSequence: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER - 1),
        workspaceId: uuidSchema,
      })
      .parse(request);
    if (parsed.projectedSequence === 0 && parsed.projectedHash !== ZERO_HASH) {
      throw new ControlLedgerIntegrityError(
        'Empty projection must use the zero hash',
      );
    }

    if (parsed.projectedSequence > 0) {
      const anchor = await this.read({
        sequence: parsed.projectedSequence,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        workspaceId: parsed.workspaceId,
      });
      if (anchor === null) {
        throw new ControlLedgerIntegrityError(
          'Control ledger projection anchor is invalid',
        );
      }
      if (
        anchor.workspaceId !== parsed.workspaceId ||
        anchor.sequence !== parsed.projectedSequence ||
        anchor.recordHash !== parsed.projectedHash
      ) {
        throw new ControlLedgerIntegrityError(
          'Control ledger projection anchor is invalid',
        );
      }
    }

    const prefix = `control-ledger/workspaces/${parsed.workspaceId}/records/`;
    const listSignal = requestSignal(
      this.config.requestTimeoutMs,
      request.signal,
    );
    const listed = (await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.config.bucket,
        MaxKeys: parsed.maxRecords + 1,
        Prefix: prefix,
        StartAfter:
          parsed.projectedSequence === 0
            ? prefix
            : recordKey(parsed.workspaceId, parsed.projectedSequence),
      }),
      { abortSignal: listSignal },
    )) as {
      readonly Contents?: readonly { readonly Key?: string }[];
      readonly IsTruncated?: boolean;
      readonly KeyCount?: number;
      readonly NextContinuationToken?: string;
    };
    const contents = listed.Contents ?? [];
    if (
      typeof listed.IsTruncated !== 'boolean' ||
      listed.KeyCount !== contents.length ||
      contents.length > parsed.maxRecords + 1 ||
      (listed.IsTruncated &&
        (contents.length !== parsed.maxRecords + 1 ||
          listed.NextContinuationToken === undefined ||
          listed.NextContinuationToken.length === 0)) ||
      (!listed.IsTruncated && listed.NextContinuationToken !== undefined)
    ) {
      throw new ControlLedgerIntegrityError(
        'Control ledger reconciliation list contract is invalid',
      );
    }
    for (const [index, item] of contents.entries()) {
      const expectedSequence = parsed.projectedSequence + index + 1;
      if (
        expectedSequence > Number.MAX_SAFE_INTEGER ||
        item.Key !== recordKey(parsed.workspaceId, expectedSequence)
      ) {
        throw new ControlLedgerIntegrityError(
          'Control ledger reconciliation keys are not consecutive',
        );
      }
    }

    const records: ControlLedgerRecord[] = [];
    let pageEndSequence = parsed.projectedSequence;
    let pageEndHash = parsed.projectedHash;
    const returnedCount = Math.min(contents.length, parsed.maxRecords);
    for (let index = 0; index < returnedCount; index += 1) {
      const next = await this.read({
        sequence: pageEndSequence + 1,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        workspaceId: parsed.workspaceId,
      });
      if (next === null) {
        throw new ControlLedgerIntegrityError(
          'Control ledger listed record is missing',
        );
      }
      if (next.previousHash !== pageEndHash) {
        throw new ControlLedgerIntegrityError(
          'Control ledger reconciliation hash chain is invalid',
        );
      }
      records.push(next);
      pageEndSequence = next.sequence;
      pageEndHash = next.recordHash;
    }
    const hasMore = contents.length > parsed.maxRecords;
    if (hasMore) {
      const probe = await this.read({
        sequence: pageEndSequence + 1,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        workspaceId: parsed.workspaceId,
      });
      if (probe?.previousHash !== pageEndHash) {
        throw new ControlLedgerIntegrityError(
          'Control ledger reconciliation probe is invalid',
        );
      }
    }
    const reachedHighWater = !hasMore;
    return Object.freeze({
      hasMore,
      pageEndHash,
      pageEndSequence,
      reachedHighWater,
      records: Object.freeze(records),
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new ControlLedgerClosedError();
  }
}

export function createControlLedger(
  config: ControlLedgerConfig,
  options: Readonly<{
    client?: ControlLedgerS3Client;
    clientOwnership?: 'borrowed' | 'owned';
    now?: () => Date;
  }> = {},
): ControlLedger {
  const client =
    options.client ??
    new S3Client({
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      region: config.region,
    });
  const ownsClient =
    options.client === undefined || options.clientOwnership === 'owned';
  return new AwsControlLedger(
    config,
    client,
    ownsClient,
    options.now ?? (() => new Date()),
  );
}
