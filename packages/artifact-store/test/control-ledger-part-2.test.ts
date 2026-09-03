import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  ControlLedgerClosedError,
  ControlLedgerConflictError,
  ControlLedgerIntegrityError,
  ControlLedgerReadinessError,
  createControlLedger,
} from '../src/control-ledger.js';
import type {
  AppendControlLedgerRecord,
  ControlLedgerS3Client,
} from '../src/control-ledger.js';

const WORKSPACE_ID = '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c01';
const COMMAND_ID = '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c02';
const SUBJECT_ID = '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c03';
const ZERO_HASH = '0'.repeat(64);
const LEDGER_RESOURCE = 'arn:aws:s3:::pertexo-control-ledger/control-ledger/*';
const DELETE_DENY = {
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
const MISSING_IF_NONE_MATCH_DENY = {
  Action: 's3:PutObject',
  Condition: { Null: { 's3:if-none-match': 'true' } },
  Effect: 'Deny',
  Principal: '*',
  Resource: LEDGER_RESOURCE,
} as const;

function bucketPolicy(...statements: readonly unknown[]): string {
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

class MemoryS3 implements ControlLedgerS3Client {
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

function fixture(
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

function command(
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

function key(sequence: number): string {
  return `control-ledger/workspaces/${WORKSPACE_ID}/records/${String(sequence).padStart(20, '0')}.json`;
}

describe('external control ledger', () => {
  it.each(['append', 'reconcile'] as const)(
    'preserves readiness cancellation and timeout for %s',
    async (operation) => {
      const cancelledClient = new MemoryS3();
      cancelledClient.hangReadiness = true;
      const cancelledLedger = fixture(cancelledClient).ledger;
      const controller = new AbortController();
      const reason = new Error('cancel readiness');
      const cancelled =
        operation === 'append'
          ? cancelledLedger.append(command({ signal: controller.signal }))
          : cancelledLedger.reconcile({
              maxRecords: 1,
              projectedHash: ZERO_HASH,
              projectedSequence: 0,
              signal: controller.signal,
              workspaceId: WORKSPACE_ID,
            });
      controller.abort(reason);
      await expect(cancelled).rejects.toBe(reason);

      const timeoutClient = new MemoryS3();
      timeoutClient.hangReadiness = true;
      const timeoutLedger = fixture(timeoutClient, 20).ledger;
      const timedOut =
        operation === 'append'
          ? timeoutLedger.append(command())
          : timeoutLedger.reconcile({
              maxRecords: 1,
              projectedHash: ZERO_HASH,
              projectedSequence: 0,
              workspaceId: WORKSPACE_ID,
            });
      await expect(timedOut).rejects.toMatchObject({ name: 'TimeoutError' });
    },
  );

  it('checks all dedicated bucket controls and exposes no delete operation', async () => {
    const { client, ledger } = fixture();
    await expect(ledger.checkReadiness()).resolves.toEqual({
      bucket: 'pertexo-control-ledger',
      minRetentionDays: 30,
      prefix: 'control-ledger/workspaces/',
      region: 'us-east-1',
    });
    expect('delete' in ledger).toBe(false);
    expect(client.commands).toHaveLength(6);
    expect(client.commands[0]).toBeInstanceOf(HeadBucketCommand);
    expect(client.commands[1]).toBeInstanceOf(GetBucketLocationCommand);
    expect(client.commands[2]).toBeInstanceOf(GetBucketVersioningCommand);
    expect(client.commands[3]).toBeInstanceOf(
      GetObjectLockConfigurationCommand,
    );
    expect(client.commands[4]).toBeInstanceOf(
      GetBucketLifecycleConfigurationCommand,
    );
    expect(client.commands[5]).toBeInstanceOf(GetBucketPolicyCommand);
  });

  it('returns the service-reported region and rejects configured drift', async () => {
    const matching = new MemoryS3();
    matching.locationConstraint = 'us-east-1';
    await expect(
      fixture(matching).ledger.checkReadiness(),
    ).resolves.toMatchObject({
      region: 'us-east-1',
    });

    const empty = new MemoryS3();
    empty.locationConstraint = '';
    await expect(fixture(empty).ledger.checkReadiness()).resolves.toMatchObject(
      {
        region: 'us-east-1',
      },
    );

    const ireland = new MemoryS3();
    ireland.locationConstraint = 'EU';
    await expect(
      fixture(ireland, 50, 'eu-west-1').ledger.checkReadiness(),
    ).resolves.toMatchObject({ region: 'eu-west-1' });

    const mismatched = new MemoryS3();
    mismatched.locationConstraint = 'eu-west-1';
    await expect(fixture(mismatched).ledger.checkReadiness()).rejects.toThrow(
      'does not match',
    );
  });

  it('accepts default compliance retention expressed in years', async () => {
    const client = new MemoryS3();
    client.retentionDays = undefined;
    client.retentionYears = 1;
    await expect(
      fixture(client).ledger.checkReadiness(),
    ).resolves.toMatchObject({
      minRetentionDays: 30,
    });
  });

  it('accepts exact absent lifecycle and wildcard or split delete denies', async () => {
    const wildcard = new MemoryS3();
    wildcard.policy = bucketPolicy(
      {
        Action: ['s3:DeleteObject*', 's3:Replicate*'],
        Effect: 'Deny',
        Principal: '*',
        Resource: 'arn:aws:s3:::pertexo-control-ledger/*',
      },
      {
        ...MISSING_IF_NONE_MATCH_DENY,
        Action: 's3:*',
        Resource: 'arn:aws:s3:::pertexo-control-ledger/*',
      },
    );
    await expect(
      fixture(wildcard).ledger.checkReadiness(),
    ).resolves.toBeDefined();

    const split = new MemoryS3();
    split.policy = bucketPolicy(
      {
        Action: 's3:DeleteObject',
        Effect: 'Deny',
        Principal: '*',
        Resource: 'arn:aws:s3:::pertexo-control-ledger/control-ledger/*',
      },
      {
        Action: 's3:DeleteObjectVersion',
        Effect: 'Deny',
        Principal: '*',
        Resource: 'arn:aws:s3:::pertexo-control-ledger/control-ledger/*',
      },
      {
        Action: 's3:ReplicateDelete',
        Effect: 'Deny',
        Principal: '*',
        Resource: 'arn:aws:s3:::pertexo-control-ledger/control-ledger/*',
      },
      {
        Action: 's3:ReplicateObject',
        Effect: 'Deny',
        Principal: '*',
        Resource: 'arn:aws:s3:::pertexo-control-ledger/control-ledger/*',
      },
      MISSING_IF_NONE_MATCH_DENY,
    );
    await expect(fixture(split).ledger.checkReadiness()).resolves.toBeDefined();
  });

  it.each([
    undefined,
    'not-json',
    JSON.stringify({ Statement: [] }),
    JSON.stringify({
      Statement: {
        Action: 's3:DeleteObject',
        Effect: 'Deny',
        Principal: '*',
        Resource: 'arn:aws:s3:::pertexo-control-ledger/control-ledger/*',
      },
    }),
    JSON.stringify({
      Statement: {
        Action: 's3:DeleteObject*',
        Condition: {},
        Effect: 'Deny',
        Principal: '*',
        Resource: 'arn:aws:s3:::pertexo-control-ledger/control-ledger/*',
      },
    }),
    JSON.stringify({
      Statement: {
        Action: 's3:DeleteObject*',
        Effect: 'Allow',
        Principal: '*',
        Resource: 'arn:aws:s3:::pertexo-control-ledger/control-ledger/*',
      },
    }),
    JSON.stringify({
      Statement: {
        Action: 's3:DeleteObject*',
        Effect: 'Deny',
        Principal: { AWS: '*' },
        Resource: 'arn:aws:s3:::pertexo-control-ledger/control-ledger/*',
      },
    }),
    JSON.stringify({
      Statement: {
        Action: 's3:DeleteObject*',
        Effect: 'Deny',
        Principal: '*',
        Resource: 'arn:aws:s3:::another-bucket/*',
      },
    }),
    JSON.stringify({
      Statement: {
        Action: 's3:DeleteObject*',
        Effect: 'Deny',
        Principal: '*',
        Resource: 'arn:aws:s3:::pertexo-control-ledger/artifacts/*',
      },
    }),
  ])('rejects insufficient bucket policy %#', async (policy) => {
    const client = new MemoryS3();
    client.policy = policy;
    await expect(fixture(client).ledger.checkReadiness()).rejects.toThrow(
      'unconditionally deny object deletion, version deletion, and replication mutation',
    );
  });

  it.each([
    's3:DeleteObject',
    's3:DeleteObjectVersion',
    's3:ReplicateDelete',
    's3:ReplicateObject',
  ])(
    'rejects policy missing required immutability action %s',
    async (missing) => {
      const client = new MemoryS3();
      client.policy = bucketPolicy(
        {
          ...DELETE_DENY,
          Action: DELETE_DENY.Action.filter((action) => action !== missing),
        },
        MISSING_IF_NONE_MATCH_DENY,
      );
      await expect(fixture(client).ledger.checkReadiness()).rejects.toThrow(
        'unconditionally deny object deletion, version deletion, and replication mutation',
      );
    },
  );

  it.each([
    undefined,
    {
      ...MISSING_IF_NONE_MATCH_DENY,
      Condition: undefined,
    },
    {
      ...MISSING_IF_NONE_MATCH_DENY,
      Condition: {
        Null: { 's3:if-none-match': 'true' },
        StringEquals: { 's3:if-none-match': '*' },
      },
    },
    {
      ...MISSING_IF_NONE_MATCH_DENY,
      Condition: {
        Null: { 's3:if-none-match': 'true', 's3:other': 'true' },
      },
    },
    {
      ...MISSING_IF_NONE_MATCH_DENY,
      Condition: { Null: { 's3:If-None-Match': 'true' } },
    },
    {
      ...MISSING_IF_NONE_MATCH_DENY,
      Condition: { Null: { 's3:if-none-match': true } },
    },
    {
      ...MISSING_IF_NONE_MATCH_DENY,
      Condition: { Null: { 's3:if-none-match': 'false' } },
    },
    { ...MISSING_IF_NONE_MATCH_DENY, Action: 's3:PutObjectAcl' },
    { ...MISSING_IF_NONE_MATCH_DENY, Principal: { AWS: '*' } },
    {
      ...MISSING_IF_NONE_MATCH_DENY,
      Resource: 'arn:aws:s3:::pertexo-control-ledger/artifacts/*',
    },
    { ...MISSING_IF_NONE_MATCH_DENY, Effect: 'Allow' },
  ])('rejects missing or malformed If-None-Match deny %#', async (putDeny) => {
    const client = new MemoryS3();
    client.policy = bucketPolicy(
      DELETE_DENY,
      ...(putDeny === undefined ? [] : [putDeny]),
    );
    await expect(fixture(client).ledger.checkReadiness()).rejects.toThrow(
      'must deny writes missing If-None-Match',
    );
  });

  it('rejects lifecycle rules and non-exact absent-lifecycle errors', async () => {
    const configured = new MemoryS3();
    configured.lifecycleFailure = undefined;
    configured.lifecycleRules = [{ Status: 'Enabled' }];
    await expect(fixture(configured).ledger.checkReadiness()).rejects.toThrow(
      'must have no lifecycle rules',
    );

    const generic404 = new MemoryS3();
    generic404.lifecycleFailure = Object.assign(new Error('missing'), {
      $metadata: { httpStatusCode: 404 },
      name: 'NotFound',
    });
    await expect(fixture(generic404).ledger.checkReadiness()).rejects.toThrow(
      'readiness could not be verified',
    );
  });

  it.each([
    ['versioning', (client: MemoryS3) => (client.versioningEnabled = false)],
    ['object lock', (client: MemoryS3) => (client.objectLockEnabled = false)],
    ['compliance', (client: MemoryS3) => (client.retentionMode = 'GOVERNANCE')],
    ['retention', (client: MemoryS3) => (client.retentionDays = 29)],
  ])(
    'fails closed before append when %s is not proven',
    async (_name, breakControl) => {
      const client = new MemoryS3();
      breakControl(client);
      const { ledger } = fixture(client);
      await expect(ledger.append(command())).rejects.toBeInstanceOf(
        ControlLedgerReadinessError,
      );
      expect(
        client.commands.some(
          (candidate) => candidate instanceof PutObjectCommand,
        ),
      ).toBe(false);
    },
  );

  it('fails closed before reconciliation when controls cannot be proven', async () => {
    const client = new MemoryS3();
    client.versioningEnabled = false;
    const { ledger } = fixture(client);
    await expect(
      ledger.reconcile({
        maxRecords: 1,
        projectedHash: ZERO_HASH,
        projectedSequence: 0,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toBeInstanceOf(ControlLedgerReadinessError);
  });

  it.each(['NoSuchBucket', 'ServiceUnavailable'])(
    'does not treat %s with HTTP 404 as a missing object',
    async (name) => {
      const client = new MemoryS3();
      client.getFailure = Object.assign(new Error(name), {
        $metadata: { httpStatusCode: 404 },
        name,
      });
      const { ledger } = fixture(client);
      await expect(
        ledger.read({ sequence: 1, workspaceId: WORKSPACE_ID }),
      ).rejects.toMatchObject({ name });
    },
  );

  it.each(['NoSuchBucket', 'ServiceUnavailable'])(
    'fails readiness closed for %s with HTTP 404',
    async (name) => {
      const client = new MemoryS3();
      client.headFailure = Object.assign(new Error(name), {
        $metadata: { httpStatusCode: 404 },
        name,
      });
      await expect(fixture(client).ledger.checkReadiness()).rejects.toEqual(
        new ControlLedgerReadinessError(
          'Control ledger bucket readiness could not be verified',
        ),
      );
    },
  );

  it('validates a nonzero reconciliation anchor before reading its successor', async () => {
    const { client, ledger } = fixture();
    const first = await ledger.append(command());
    await expect(
      ledger.reconcile({
        maxRecords: 1,
        projectedHash: 'f'.repeat(64),
        projectedSequence: 1,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow('projection anchor is invalid');
    await expect(
      ledger.reconcile({
        maxRecords: 1,
        projectedHash: first.recordHash,
        projectedSequence: 1,
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toMatchObject({
      hasMore: false,
      pageEndSequence: 1,
      reachedHighWater: true,
    });
    const list = client.commands.findLast(
      (candidate) => candidate instanceof ListObjectsV2Command,
    );
    expect(list?.input.StartAfter).toBe(key(1));
  });
});
