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
import { describe, expect, it } from 'vitest';

import { ControlLedgerReadinessError } from '../src/control-ledger.js';
import {
  DELETE_DENY,
  MISSING_IF_NONE_MATCH_DENY,
  MemoryS3,
  WORKSPACE_ID,
  ZERO_HASH,
  bucketPolicy,
  command,
  fixture,
  key,
} from './support/control-ledger.fixture.js';

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
