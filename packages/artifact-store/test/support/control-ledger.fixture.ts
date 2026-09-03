import type { GetObjectCommand } from '@aws-sdk/client-s3';
import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createControlLedger } from '../../src/control-ledger.js';
import type {
  AppendControlLedgerRecord,
  ControlLedgerS3Client,
} from '../../src/control-ledger.js';

export const WORKSPACE_ID = '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c01';
const COMMAND_ID = '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c02';
const SUBJECT_ID = '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c03';
export const ZERO_HASH = '0'.repeat(64);
const LEDGER_RESOURCE = 'arn:aws:s3:::pertexo-control-ledger/control-ledger/*';
export const DELETE_DENY = {
  Action: [
    's3:DeleteObject',
    's3:DeleteObjectVersion',
    's3:ReplicateDelete',
    's3:ReplicateObject',
  ],
  Effect: 'Deny',
  Principal: '*',
  Resource: LEDGER_RESOURCE,
} as const;
export const MISSING_IF_NONE_MATCH_DENY = {
  Action: 's3:PutObject',
  Condition: { Null: { 's3:if-none-match': 'true' } },
  Effect: 'Deny',
  Principal: '*',
  Resource: LEDGER_RESOURCE,
} as const;

export function bucketPolicy(...statements: readonly unknown[]): string {
  return JSON.stringify({ Statement: statements });
}

interface StoredObject {
  readonly body: Buffer;
  readonly checksumSha256: string;
  readonly contentType: string;
}

function bytes(body: unknown): Buffer {
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new Error('Expected byte body');
}

export class MemoryS3 implements ControlLedgerS3Client {
  public readonly commands: unknown[] = [];
  public destroyCalls = 0;
  public hangGets = false;
  public objectLockEnabled = true;
  public retentionDays: number | undefined = 30;
  public retentionMode = 'COMPLIANCE';
  public retentionYears: number | undefined;
  public versioningEnabled = true;
  public getFailure: Error | undefined;
  public getChecksumOverride: string | undefined;
  public headFailure: Error | undefined;
  public hangReadiness = false;
  public lifecycleFailure: Error | undefined = Object.assign(
    new Error('no lifecycle'),
    { name: 'NoSuchLifecycleConfiguration' },
  );
  public lifecycleRules: readonly unknown[] | undefined;
  public locationConstraint: string | null | undefined = null;
  public listOutput: unknown;
  public policy: string | undefined = bucketPolicy(
    DELETE_DENY,
    MISSING_IF_NONE_MATCH_DENY,
  );
  public putChecksumOverride: string | undefined;
  public streamFailure: Error | undefined;
  private readonly objects = new Map<string, StoredObject>();

  public async send(
    command:
      | GetBucketVersioningCommand
      | GetBucketLifecycleConfigurationCommand
      | GetBucketLocationCommand
      | GetBucketPolicyCommand
      | GetObjectCommand
      | GetObjectLockConfigurationCommand
      | HeadBucketCommand
      | ListObjectsV2Command
      | PutObjectCommand,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<unknown> {
    this.commands.push(command);
    if (command instanceof HeadBucketCommand) {
      if (this.hangReadiness) await this.waitForAbort(options?.abortSignal);
      if (this.headFailure !== undefined) throw this.headFailure;
      return {};
    }
    if (command instanceof GetBucketLocationCommand) {
      return { LocationConstraint: this.locationConstraint };
    }
    if (command instanceof GetBucketVersioningCommand) {
      return { Status: this.versioningEnabled ? 'Enabled' : 'Suspended' };
    }
    if (command instanceof GetObjectLockConfigurationCommand) {
      return {
        ObjectLockConfiguration: {
          ObjectLockEnabled: this.objectLockEnabled ? 'Enabled' : undefined,
          Rule: {
            DefaultRetention: {
              Days: this.retentionDays,
              Mode: this.retentionMode,
              Years: this.retentionYears,
            },
          },
        },
      };
    }
    if (command instanceof GetBucketLifecycleConfigurationCommand) {
      if (this.lifecycleFailure !== undefined) throw this.lifecycleFailure;
      return { Rules: this.lifecycleRules };
    }
    if (command instanceof GetBucketPolicyCommand) {
      return { Policy: this.policy };
    }
    if (command instanceof ListObjectsV2Command) {
      if (this.listOutput !== undefined) return this.listOutput;
      const prefix = String(command.input.Prefix);
      const startAfter = String(command.input.StartAfter);
      const maximum = Number(command.input.MaxKeys);
      const keys = [...this.objects.keys()]
        .filter(
          (candidate) => candidate.startsWith(prefix) && candidate > startAfter,
        )
        .sort();
      const contents = keys.slice(0, maximum).map((Key) => ({ Key }));
      const isTruncated = keys.length > maximum;
      return {
        Contents: contents,
        IsTruncated: isTruncated,
        KeyCount: contents.length,
        ...(isTruncated ? { NextContinuationToken: 'bounded-probe' } : {}),
      };
    }
    if (command instanceof PutObjectCommand) {
      const key = String(command.input.Key);
      const body = bytes(command.input.Body);
      if (command.input.IfNoneMatch === '*' && this.objects.has(key)) {
        throw Object.assign(new Error('precondition'), {
          $metadata: { httpStatusCode: 412 },
          name: 'PreconditionFailed',
        });
      }
      this.objects.set(key, {
        body,
        checksumSha256: String(command.input.ChecksumSHA256),
        contentType: String(command.input.ContentType),
      });
      return {
        ChecksumSHA256:
          this.putChecksumOverride ?? command.input.ChecksumSHA256,
      };
    }
    if (this.getFailure !== undefined) throw this.getFailure;
    if (this.hangGets) await this.waitForAbort(options?.abortSignal);
    const object = this.objects.get(String(command.input.Key));
    if (object === undefined) {
      throw Object.assign(new Error('missing'), {
        $metadata: { httpStatusCode: 404 },
        name: 'NoSuchKey',
      });
    }
    const streamFailure = this.streamFailure;
    return {
      Body:
        streamFailure === undefined
          ? Readable.from([object.body])
          : new Readable({
              read() {
                this.destroy(streamFailure);
              },
            }),
      ContentLength: object.body.byteLength,
      ContentType: object.contentType,
      ChecksumSHA256: this.getChecksumOverride ?? object.checksumSha256,
    };
  }

  public destroy(): void {
    this.destroyCalls += 1;
  }

  public get(key: string): Buffer | undefined {
    return this.objects.get(key)?.body;
  }

  public getRequired(key: string): Buffer {
    const body = this.get(key);
    if (body === undefined) throw new Error(`Missing memory object: ${key}`);
    return body;
  }

  public putRaw(
    key: string,
    body: Buffer,
    contentType = 'application/json',
  ): void {
    this.objects.set(key, {
      body,
      checksumSha256: createHash('sha256').update(body).digest('base64'),
      contentType,
    });
  }

  private async waitForAbort(signal: AbortSignal | undefined): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      const abort = (): void => {
        const reason: unknown = signal?.reason;
        reject(
          reason instanceof Error
            ? reason
            : new Error('Memory S3 request aborted'),
        );
      };
      if (signal?.aborted === true) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

const NOW = new Date('2026-08-26T00:00:00.000Z');

export function fixture(
  client = new MemoryS3(),
  requestTimeoutMs = 50,
  region = 'us-east-1',
) {
  return {
    client,
    ledger: createControlLedger(
      {
        accessKeyId: 'access',
        bucket: 'pertexo-control-ledger',
        endpoint: 'http://localhost:9090',
        forcePathStyle: true,
        minRetentionDays: 30,
        region,
        requestTimeoutMs,
        secretAccessKey: 'secret',
      },
      { client, now: () => NOW },
    ),
  };
}

export function command(
  overrides: Partial<AppendControlLedgerRecord> = {},
): AppendControlLedgerRecord {
  return {
    actorRef: 'operator:test',
    commandId: COMMAND_ID,
    commandType: 'deletion_requested',
    occurredAt: '2026-08-26T12:34:56.000Z',
    previousHash: ZERO_HASH,
    reason: 'workspace owner request',
    sequence: 1,
    subjectId: SUBJECT_ID,
    workspaceId: WORKSPACE_ID,
    ...overrides,
  } as AppendControlLedgerRecord;
}

export function key(sequence: number): string {
  return `control-ledger/workspaces/${WORKSPACE_ID}/records/${String(sequence).padStart(20, '0')}.json`;
}
