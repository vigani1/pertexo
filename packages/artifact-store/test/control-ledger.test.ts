import {
  GetBucketLifecycleConfigurationCommand,
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

function fixture(client = new MemoryS3(), requestTimeoutMs = 50) {
  return {
    client,
    ledger: createControlLedger(
      {
        accessKeyId: 'access',
        bucket: 'pertexo-control-ledger',
        endpoint: 'http://localhost:9090',
        forcePathStyle: true,
        minRetentionDays: 30,
        region: 'us-east-1',
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
  it('writes exact canonical bytes and hashes the canonical record without recordHash', async () => {
    const { client, ledger } = fixture();
    const record = await ledger.append(command());
    const material =
      '{"actorRef":"operator:test","commandId":"018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c02","commandType":"deletion_requested","occurredAt":"2026-08-26T12:34:56.000Z","previousHash":"' +
      ZERO_HASH +
      '","reason":"workspace owner request","schemaVersion":1,"sequence":1,"subjectId":"018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c03","workspaceId":"018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c01"}';
    const expectedHash = createHash('sha256').update(material).digest('hex');
    const expectedBytes = Buffer.from(
      material.replace(
        '"schemaVersion"',
        `"recordHash":"${expectedHash}","schemaVersion"`,
      ),
    );

    expect(record.recordHash).toBe(expectedHash);
    expect(client.get(key(1))).toEqual(expectedBytes);
    const put = client.commands.find(
      (candidate) => candidate instanceof PutObjectCommand,
    );
    if (!(put instanceof PutObjectCommand)) {
      throw new Error('Expected a control ledger PUT');
    }
    expect(put.input).toMatchObject({
      Bucket: 'pertexo-control-ledger',
      ContentLength: expectedBytes.byteLength,
      ContentType: 'application/json',
      IfNoneMatch: '*',
      Key: key(1),
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: new Date('2026-09-25T00:00:00.000Z'),
    });
    expect(put.input.Key).not.toMatch(/^workspaces\//u);
    expect(put.input.Key).not.toContain(
      'workspaces/' + WORKSPACE_ID + '/artifacts',
    );
  });

  it('appends a subsequent record only after validating its predecessor', async () => {
    const { ledger } = fixture();
    const first = await ledger.append(command());
    const second = await ledger.append(
      command({
        commandId: '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c04',
        commandType: 'purge_started',
        previousHash: first.recordHash,
        sequence: 2,
      }),
    );

    expect(second.previousHash).toBe(first.recordHash);
    await expect(
      ledger.read({ sequence: 2, workspaceId: WORKSPACE_ID }),
    ).resolves.toEqual(second);
  });

  it('returns an exact replay and rejects different content at a sequence', async () => {
    const { ledger } = fixture();
    const first = await ledger.append(command());

    await expect(ledger.append(command())).resolves.toEqual(first);
    await expect(
      ledger.append(command({ reason: 'different request' })),
    ).rejects.toBeInstanceOf(ControlLedgerConflictError);
  });

  it('fails closed for invalid first/predecessor state and corrupted predecessors', async () => {
    const firstFixture = fixture();
    await expect(
      firstFixture.ledger.append(command({ previousHash: '1'.repeat(64) })),
    ).rejects.toThrow('zero hash');

    const missingFixture = fixture();
    await expect(
      missingFixture.ledger.append(command({ sequence: 2 })),
    ).rejects.toThrow('predecessor is missing');
    expect(
      missingFixture.client.commands.some(
        (candidate) => candidate instanceof PutObjectCommand,
      ),
    ).toBe(false);

    const mismatchFixture = fixture();
    const first = await mismatchFixture.ledger.append(command());
    await expect(
      mismatchFixture.ledger.append(
        command({ previousHash: '1'.repeat(64), sequence: 2 }),
      ),
    ).rejects.toThrow('does not match predecessor');

    const corrupted = Buffer.from(mismatchFixture.client.getRequired(key(1)));
    corrupted[10] = corrupted[10] === 97 ? 98 : 97;
    mismatchFixture.client.putRaw(key(1), corrupted);
    await expect(
      mismatchFixture.ledger.append(
        command({ previousHash: first.recordHash, sequence: 2 }),
      ),
    ).rejects.toBeInstanceOf(ControlLedgerIntegrityError);
  });

  it('recomputes hashes on every read', async () => {
    const { client, ledger } = fixture();
    const record = await ledger.append(command());
    const invalid = Buffer.from(
      client
        .getRequired(key(1))
        .toString('utf8')
        .replace(record.recordHash, 'f'.repeat(64)),
    );
    client.putRaw(key(1), invalid);

    await expect(
      ledger.read({ sequence: 1, workspaceId: WORKSPACE_ID }),
    ).rejects.toThrow('record hash is invalid');
  });

  it('validates service-provided write and read SHA-256 checksums', async () => {
    const writeClient = new MemoryS3();
    writeClient.putChecksumOverride = 'invalid';
    await expect(fixture(writeClient).ledger.append(command())).rejects.toThrow(
      'write checksum is invalid',
    );

    const { client, ledger } = fixture();
    await ledger.append(command());
    client.getChecksumOverride = 'invalid';
    await expect(
      ledger.read({ sequence: 1, workspaceId: WORKSPACE_ID }),
    ).rejects.toThrow('object checksum is invalid');
    const get = client.commands.find(
      (candidate) => candidate instanceof GetObjectCommand,
    );
    expect(get?.input.ChecksumMode).toBe('ENABLED');
  });

  it('does not translate a NoSuchKey raised by the object body stream', async () => {
    const { client, ledger } = fixture();
    await ledger.append(command());
    client.streamFailure = Object.assign(new Error('stream failed'), {
      name: 'NoSuchKey',
    });
    await expect(
      ledger.read({ sequence: 1, workspaceId: WORKSPACE_ID }),
    ).rejects.toMatchObject({ name: 'NoSuchKey' });
  });

  it('serializes concurrent different appends to one winner and one stable conflict', async () => {
    const { ledger } = fixture();
    const results = await Promise.allSettled([
      ledger.append(command()),
      ledger.append(command({ reason: 'competing command' })),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(ControlLedgerConflictError);
    }
  });

  it('treats concurrent exact appends as idempotent replay', async () => {
    const { ledger } = fixture();
    const [left, right] = await Promise.all([
      ledger.append(command()),
      ledger.append(command()),
    ]);
    expect(left).toEqual(right);
  });

  it('reconciles only consecutive records within the caller bound', async () => {
    const { client, ledger } = fixture();
    const first = await ledger.append(command());
    const second = await ledger.append(
      command({
        commandId: '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c04',
        previousHash: first.recordHash,
        sequence: 2,
      }),
    );
    await ledger.append(
      command({
        commandId: '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c05',
        previousHash: second.recordHash,
        sequence: 3,
      }),
    );

    const commandOffset = client.commands.length;
    await expect(
      ledger.reconcile({
        maxRecords: 2,
        projectedHash: ZERO_HASH,
        projectedSequence: 0,
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toMatchObject({
      hasMore: true,
      pageEndHash: second.recordHash,
      pageEndSequence: 2,
      reachedHighWater: false,
      records: [first, second],
    });
    expect(
      client.commands
        .slice(commandOffset)
        .filter((candidate) => candidate instanceof GetObjectCommand),
    ).toHaveLength(3);
    const list = client.commands
      .slice(commandOffset)
      .find((candidate) => candidate instanceof ListObjectsV2Command);
    expect(list?.input).toMatchObject({
      MaxKeys: 3,
      Prefix: `control-ledger/workspaces/${WORKSPACE_ID}/records/`,
      StartAfter: `control-ledger/workspaces/${WORKSPACE_ID}/records/`,
    });
    await expect(
      ledger.reconcile({
        maxRecords: 101,
        projectedHash: ZERO_HASH,
        projectedSequence: 0,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toBeDefined();

    const corruptedProbe = Buffer.from(client.getRequired(key(3)));
    corruptedProbe[10] = corruptedProbe[10] === 97 ? 98 : 97;
    client.putRaw(key(3), corruptedProbe);
    await expect(
      ledger.reconcile({
        maxRecords: 2,
        projectedHash: ZERO_HASH,
        projectedSequence: 0,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toBeInstanceOf(ControlLedgerIntegrityError);
  });

  it('fails closed when bounded listing exposes an external sequence gap', async () => {
    const { client, ledger } = fixture();
    const first = await ledger.append(command());
    const thirdMaterial = {
      ...command({
        commandId: '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c05',
        previousHash: first.recordHash,
        sequence: 3,
      }),
      schemaVersion: 1,
    };
    client.putRaw(key(3), Buffer.from(JSON.stringify(thirdMaterial)));

    await expect(
      ledger.reconcile({
        maxRecords: 100,
        projectedHash: first.recordHash,
        projectedSequence: 1,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow('keys are not consecutive');
    expect(
      client.commands.some(
        (candidate) => candidate instanceof ListObjectsV2Command,
      ),
    ).toBe(true);
  });

  it('fails closed on reconciliation chain mismatch', async () => {
    const { ledger } = fixture();
    await ledger.append(command());
    await expect(
      ledger.reconcile({
        maxRecords: 1,
        projectedHash: '1'.repeat(64),
        projectedSequence: 0,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow('Empty projection must use the zero hash');
  });

  it.each([
    { Contents: [] },
    {
      Contents: [{ Key: key(1) }, { Key: key(3) }],
      IsTruncated: false,
      KeyCount: 2,
    },
    {
      Contents: [{ Key: `${key(1)}.foreign` }],
      IsTruncated: false,
      KeyCount: 1,
    },
    {
      Contents: [{ Key: key(1) }],
      IsTruncated: false,
      KeyCount: 2,
    },
    {
      Contents: [{ Key: key(1) }],
      IsTruncated: true,
      KeyCount: 1,
      NextContinuationToken: 'unexpected',
    },
    {
      Contents: [{ Key: key(1) }, { Key: key(2) }],
      IsTruncated: true,
      KeyCount: 2,
      NextContinuationToken: '',
    },
    {
      Contents: [{ Key: key(1) }, { Key: key(2) }, { Key: key(3) }],
      IsTruncated: true,
      KeyCount: 3,
      NextContinuationToken: 'too-many',
    },
    {
      Contents: [],
      IsTruncated: false,
      KeyCount: 0,
      NextContinuationToken: 'unexpected',
    },
  ])('rejects malformed bounded list response %#', async (listOutput) => {
    const client = new MemoryS3();
    client.listOutput = listOutput;
    await expect(
      fixture(client).ledger.reconcile({
        maxRecords: 1,
        projectedHash: ZERO_HASH,
        projectedSequence: 0,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toBeInstanceOf(ControlLedgerIntegrityError);
  });

  it('fails closed when a strongly listed record disappears before GET', async () => {
    const client = new MemoryS3();
    client.listOutput = {
      Contents: [{ Key: key(1) }],
      IsTruncated: false,
      KeyCount: 1,
    };
    await expect(
      fixture(client).ledger.reconcile({
        maxRecords: 1,
        projectedHash: ZERO_HASH,
        projectedSequence: 0,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow('listed record is missing');
  });

  it('bounds payload/key inputs and requires legal authority for holds', async () => {
    const { ledger } = fixture();
    await expect(
      ledger.append(command({ reason: 'x'.repeat(513) })),
    ).rejects.toBeDefined();
    await expect(
      ledger.append(command({ workspaceId: '../unsafe' })),
    ).rejects.toBeDefined();
    await expect(
      ledger.append(command({ commandType: 'legal_hold_placed' })),
    ).rejects.toBeDefined();
  });

  it('propagates cancellation, enforces timeout, and has explicit client ownership', async () => {
    const borrowed = new MemoryS3();
    borrowed.hangGets = true;
    const { ledger } = fixture(borrowed, 20);
    await expect(
      ledger.read({ sequence: 1, workspaceId: WORKSPACE_ID }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });

    const controller = new AbortController();
    const cancelled = ledger.read({
      sequence: 1,
      signal: controller.signal,
      workspaceId: WORKSPACE_ID,
    });
    const reason = new Error('cancelled by caller');
    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    ledger.close();
    expect(borrowed.destroyCalls).toBe(0);
    await expect(
      ledger.read({ sequence: 1, workspaceId: WORKSPACE_ID }),
    ).rejects.toBeInstanceOf(ControlLedgerClosedError);

    const owned = new MemoryS3();
    const ownedLedger = createControlLedger(
      {
        accessKeyId: 'access',
        bucket: 'pertexo-control-ledger',
        endpoint: 'http://localhost:9090',
        forcePathStyle: true,
        minRetentionDays: 30,
        region: 'us-east-1',
        requestTimeoutMs: 50,
        secretAccessKey: 'secret',
      },
      { client: owned, clientOwnership: 'owned' },
    );
    ownedLedger.close();
    ownedLedger.close();
    expect(owned.destroyCalls).toBe(1);
  });

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
    });
    expect('delete' in ledger).toBe(false);
    expect(client.commands).toHaveLength(5);
    expect(client.commands[0]).toBeInstanceOf(HeadBucketCommand);
    expect(client.commands[1]).toBeInstanceOf(GetBucketVersioningCommand);
    expect(client.commands[2]).toBeInstanceOf(
      GetObjectLockConfigurationCommand,
    );
    expect(client.commands[3]).toBeInstanceOf(
      GetBucketLifecycleConfigurationCommand,
    );
    expect(client.commands[4]).toBeInstanceOf(GetBucketPolicyCommand);
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
