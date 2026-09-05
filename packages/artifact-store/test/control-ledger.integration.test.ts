import {
  CreateBucketCommand,
  DeleteObjectCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  PutObjectLockConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { parseDualRegionControlLedgerConfig } from '../src/control-ledger-config.js';
import {
  ControlLedgerConflictError,
  ControlLedgerReadinessError,
  createControlLedger,
} from '../src/control-ledger.js';
import type {
  AppendControlLedgerRecord,
  ControlLedger,
} from '../src/control-ledger.js';
import {
  ControlLedgerPartialReplicationError,
  createDualRegionControlLedger,
} from '../src/dual-region-control-ledger.js';

const integrationDescribe =
  process.env.CONTROL_LEDGER_INTEGRATION === 'true' ? describe : describe.skip;
const provider = process.env.CONTROL_LEDGER_INTEGRATION_PROVIDER;
const exactPolicyIt = provider === 'aws' ? it : it.skip;
const minioIt = provider === 'minio' ? it : it.skip;
const ZERO_HASH = '0'.repeat(64);

function client(
  config: ReturnType<typeof parseDualRegionControlLedgerConfig>['primary'],
): S3Client {
  return new S3Client({
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    region: config.region,
  });
}

function adminClient(
  config: ReturnType<typeof parseDualRegionControlLedgerConfig>['primary'],
  accessKeyId: string | undefined,
  secretAccessKey: string | undefined,
): S3Client {
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error(
      'Control ledger integration admin credentials are required',
    );
  }
  return new S3Client({
    credentials: { accessKeyId, secretAccessKey },
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    region: config.region,
  });
}

function bucketPolicy(bucket: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DenyLedgerMutation',
        Effect: 'Deny',
        Principal: '*',
        Action: [
          's3:DeleteObject',
          's3:DeleteObjectVersion',
          's3:ReplicateObject',
          's3:ReplicateDelete',
        ],
        Resource: `arn:aws:s3:::${bucket}/control-ledger/*`,
      },
      {
        Sid: 'RequireConditionalCreate',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:PutObject',
        Resource: `arn:aws:s3:::${bucket}/control-ledger/*`,
        Condition: { Null: { 's3:if-none-match': 'true' } },
      },
    ],
  });
}

function isAlreadyOwned(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return ['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(
    (error as { readonly name?: string }).name ?? '',
  );
}

async function prepareBucket(
  s3: S3Client,
  bucket: string,
  retentionDays: number,
): Promise<void> {
  try {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        ObjectLockEnabledForBucket: true,
      }),
    );
  } catch (error: unknown) {
    if (!isAlreadyOwned(error)) throw error;
  }
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: 'Enabled' },
    }),
  );
  await s3.send(
    new PutObjectLockConfigurationCommand({
      Bucket: bucket,
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: {
          DefaultRetention: {
            Days: retentionDays,
            Mode: 'COMPLIANCE',
          },
        },
      },
    }),
  );
  const policy = JSON.parse(bucketPolicy(bucket)) as {
    readonly Statement: readonly unknown[];
    readonly Version: string;
  };
  await s3.send(
    new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: JSON.stringify({
        Version: policy.Version,
        Statement: [policy.Statement[0]],
      }),
    }),
  );
  if (provider === 'aws') {
    await s3.send(
      new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: JSON.stringify(policy),
      }),
    );
  }
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as { readonly name?: string }).name;
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as { readonly message?: string }).message;
}

function status(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  return (
    error as { readonly $metadata?: { readonly httpStatusCode?: number } }
  ).$metadata?.httpStatusCode;
}

integrationDescribe('dual-region control ledger MinIO integration', () => {
  let config!: ReturnType<typeof parseDualRegionControlLedgerConfig>;
  let primary!: S3Client;
  let recovery!: S3Client;
  let primaryAdmin!: S3Client;
  let recoveryAdmin!: S3Client;

  beforeAll(async () => {
    config = parseDualRegionControlLedgerConfig(process.env);
    primary = client(config.primary);
    recovery = client(config.recovery);
    primaryAdmin = adminClient(
      config.primary,
      process.env.CONTROL_LEDGER_ADMIN_ACCESS_KEY_ID,
      process.env.CONTROL_LEDGER_ADMIN_SECRET_ACCESS_KEY,
    );
    recoveryAdmin = adminClient(
      config.recovery,
      process.env.CONTROL_LEDGER_RECOVERY_ADMIN_ACCESS_KEY_ID,
      process.env.CONTROL_LEDGER_RECOVERY_ADMIN_SECRET_ACCESS_KEY,
    );
    await Promise.all([
      prepareBucket(
        primaryAdmin,
        config.primary.bucket,
        config.primary.minRetentionDays,
      ),
      prepareBucket(
        recoveryAdmin,
        config.recovery.bucket,
        config.recovery.minRetentionDays,
      ),
    ]);
  });

  exactPolicyIt(
    'proves real dual-service append, replay, conflict, and retry repair',
    async () => {
      const ledger = createDualRegionControlLedger(
        config.primary,
        config.recovery,
      );
      const workspaceId = randomUUID();
      const command: AppendControlLedgerRecord = {
        actorRef: 'integration-test',
        commandId: randomUUID(),
        commandType: 'legal_hold_placed',
        legalAuthority: 'integration-test-authority',
        occurredAt: new Date().toISOString(),
        previousHash: ZERO_HASH,
        reason: 'real dual-region-compatible service proof',
        sequence: 1,
        subjectId: randomUUID(),
        workspaceId,
      };

      try {
        const readiness = await ledger.checkReadiness();
        expect(readiness).toMatchObject({
          minRetentionDays: Math.min(
            config.primary.minRetentionDays,
            config.recovery.minRetentionDays,
          ),
          prefix: 'control-ledger/workspaces/',
          region: 'eu-central-1',
          primary: { region: 'eu-central-1' },
          recovery: { region: 'eu-west-1' },
        });

        const appended = await ledger.append(command);
        await expect(
          ledger.read({ sequence: 1, workspaceId }),
        ).resolves.toEqual(appended);
        await expect(
          ledger.reconcile({
            maxRecords: 10,
            projectedHash: ZERO_HASH,
            projectedSequence: 0,
            workspaceId,
          }),
        ).resolves.toMatchObject({
          pageEndHash: appended.recordHash,
          pageEndSequence: 1,
          reachedHighWater: true,
          records: [appended],
        });
        await expect(ledger.append(command)).resolves.toEqual(appended);
        await expect(
          ledger.append({ ...command, reason: 'conflicting replay' }),
        ).rejects.toBeInstanceOf(ControlLedgerConflictError);

        const recovery = createControlLedger(config.recovery);
        let failAppend = true;
        const faultedRecovery: ControlLedger = {
          append: async (request) => {
            if (failAppend) {
              failAppend = false;
              throw new Error('injected recovery append outage');
            }
            return recovery.append(request);
          },
          checkReadiness: (signal) => recovery.checkReadiness(signal),
          close: () => undefined,
          read: (request) => recovery.read(request),
          reconcile: (request) => recovery.reconcile(request),
        };
        const faulted = createDualRegionControlLedger(
          createControlLedger(config.primary),
          faultedRecovery,
          { ledgerOwnership: 'owned' },
        );
        const repairCommand: AppendControlLedgerRecord = {
          ...command,
          commandId: randomUUID(),
          subjectId: randomUUID(),
          workspaceId: randomUUID(),
        };
        try {
          await expect(faulted.append(repairCommand)).rejects.toBeInstanceOf(
            ControlLedgerPartialReplicationError,
          );
        } finally {
          faulted.close();
          recovery.close();
        }

        const retry = createDualRegionControlLedger(
          config.primary,
          config.recovery,
        );
        try {
          const repaired = await retry.append(repairCommand);
          await expect(
            retry.reconcile({
              maxRecords: 10,
              projectedHash: ZERO_HASH,
              projectedSequence: 0,
              workspaceId: repairCommand.workspaceId,
            }),
          ).resolves.toMatchObject({
            records: [repaired],
            reachedHighWater: true,
          });
        } finally {
          retry.close();
        }
      } finally {
        ledger.close();
      }
    },
  );

  exactPolicyIt.each(['primary', 'recovery'] as const)(
    'enforces immutable conditional creation in %s',
    async (name) => {
      const s3 = name === 'primary' ? primary : recovery;
      const bucket = config[name].bucket;
      const key = `control-ledger/integration-policy/${randomUUID()}.json`;
      const conditional = new PutObjectCommand({
        Body: '{}',
        Bucket: bucket,
        ContentType: 'application/json',
        IfNoneMatch: '*',
        Key: key,
      });

      await expect(s3.send(conditional)).resolves.toBeDefined();
      await expect(s3.send(conditional)).rejects.toSatisfy(
        (error: unknown) => status(error) === 412,
      );
      await expect(
        s3.send(
          new PutObjectCommand({
            Body: '{"overwrite":true}',
            Bucket: bucket,
            Key: key,
          }),
        ),
      ).rejects.toSatisfy((error: unknown) => status(error) === 403);
      await expect(
        s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
      ).rejects.toSatisfy((error: unknown) => status(error) === 403);
    },
  );

  minioIt.each(['primary', 'recovery'] as const)(
    'proves supported controls and the fail-closed boundary in %s',
    async (name) => {
      const admin = name === 'primary' ? primaryAdmin : recoveryAdmin;
      const s3 = name === 'primary' ? primary : recovery;
      const ledgerConfig = config[name];
      await expect(
        admin.send(
          new PutBucketPolicyCommand({
            Bucket: ledgerConfig.bucket,
            Policy: bucketPolicy(ledgerConfig.bucket),
          }),
        ),
      ).rejects.toSatisfy(
        (error: unknown) =>
          errorName(error) === 'MalformedPolicy' &&
          errorMessage(error)?.includes("'s3:if-none-match'") === true,
      );

      const key = `control-ledger/integration-policy/${randomUUID()}.json`;
      const conditional = new PutObjectCommand({
        Body: '{}',
        Bucket: ledgerConfig.bucket,
        ContentType: 'application/json',
        IfNoneMatch: '*',
        Key: key,
      });
      await expect(s3.send(conditional)).resolves.toBeDefined();
      await expect(s3.send(conditional)).rejects.toSatisfy(
        (error: unknown) => status(error) === 412,
      );
      await expect(
        s3.send(
          new DeleteObjectCommand({
            Bucket: ledgerConfig.bucket,
            Key: key,
          }),
        ),
      ).rejects.toSatisfy((error: unknown) => status(error) === 403);

      const ledger = createControlLedger(ledgerConfig);
      try {
        await expect(ledger.checkReadiness()).rejects.toBeInstanceOf(
          ControlLedgerReadinessError,
        );
      } finally {
        ledger.close();
      }
    },
  );
});
