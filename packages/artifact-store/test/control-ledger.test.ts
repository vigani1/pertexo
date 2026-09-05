import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  ControlLedgerClosedError,
  ControlLedgerConflictError,
  ControlLedgerIntegrityError,
  createControlLedger,
} from '../src/control-ledger.js';
import {
  MemoryS3,
  WORKSPACE_ID,
  ZERO_HASH,
  command,
  fixture,
  key,
} from './support/control-ledger.fixture.js';

describe('external control ledger', () => {
  it('reuses a bounded readiness attestation and re-proves it after expiry', async () => {
    const client = new MemoryS3();
    let now = new Date('2026-08-26T00:00:00.000Z');
    const ledger = createControlLedger(
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
      {
        client,
        now: () => now,
        readinessAttestationTtlMs: 1_000,
      },
    );

    await ledger.checkReadiness();
    expect(client.commands).toHaveLength(6);

    await ledger.append(command());
    expect(client.commands).toHaveLength(7);

    now = new Date(now.getTime() + 1_001);
    client.versioningEnabled = false;
    await expect(
      ledger.append(
        command({
          commandId: '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c09',
        }),
      ),
    ).rejects.toThrow('versioning must be Enabled');
    expect(client.commands).toHaveLength(10);
  });

  it('invalidates an attestation when an explicit readiness proof fails', async () => {
    const client = new MemoryS3();
    const { ledger } = fixture(client);
    await ledger.checkReadiness();
    expect(client.commands).toHaveLength(6);

    client.versioningEnabled = false;
    await expect(ledger.checkReadiness()).rejects.toThrow(
      'versioning must be Enabled',
    );
    client.versioningEnabled = true;
    const beforeAppend = client.commands.length;
    await ledger.append(command());
    expect(client.commands.length - beforeAppend).toBe(7);
  });

  it('rejects legal authority on deletion records', async () => {
    const { ledger } = fixture();
    await expect(
      ledger.append(
        command({
          legalAuthority: 'must-not-be-present',
        }),
      ),
    ).rejects.toThrow();
  });

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

  it('bounds reconciliation GET concurrency while preserving chain order', async () => {
    const { client, ledger } = fixture();
    let previousHash = ZERO_HASH;
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      const record = await ledger.append(
        command({
          commandId: `018f47a0-7b5c-7e2d-8c3f-${String(sequence).padStart(12, '0')}`,
          previousHash,
          sequence,
        }),
      );
      previousHash = record.recordHash;
    }
    client.getDelayMs = 2;

    const reconciliation = await ledger.reconcile({
      maxRecords: 10,
      projectedHash: ZERO_HASH,
      projectedSequence: 0,
      workspaceId: WORKSPACE_ID,
    });

    expect(reconciliation.records.map((record) => record.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(client.maxConcurrentGets).toBe(8);
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
});
