import { createDatabasePool } from '../postgres-telemetry.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import {
  parseCompatibilityReleaseExpectation,
  type CompatibilityReleaseExpectation,
} from './compatibility-release.js';

const uuidSchema = z.uuid();
const deploymentIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);
const artifactIdSchema = deploymentIdSchema;
const actorSchema = z.string().regex(/^[A-Za-z0-9._:@/-]{1,128}$/u);
const reasonSchema = z.string().trim().min(1).max(500);
const artifactSetSchema = z
  .array(artifactIdSchema)
  .min(1)
  .max(1000)
  .refine((values) => new Set(values).size === values.length)
  .transform((values) => Object.freeze([...values]));

type ActorKind = 'deployment' | 'migration';
type RoleKind = 'api' | 'worker';

export interface CompatibilityReleaseMaintenance {
  activate(
    input: Readonly<{
      activationId: string;
      actorId: string;
      actorKind: ActorKind;
      approvalId: string;
      expectedPredecessor: CompatibilityReleaseExpectation;
      reason: string;
    }>,
  ): Promise<void>;
  approve(
    input: Readonly<{
      actorId: string;
      approvalId: string;
      deploymentId: string;
      reason: string;
      requiredApiArtifacts: readonly string[];
      requiredWorkerArtifacts: readonly string[];
      target: CompatibilityReleaseExpectation;
    }>,
  ): Promise<void>;
  close(): Promise<void>;
  prepare(
    input: Readonly<{
      actorId: string;
      actorKind: ActorKind;
      expectedPredecessor: CompatibilityReleaseExpectation;
      reason: string;
      target: CompatibilityReleaseExpectation;
    }>,
  ): Promise<void>;
  recordPreactivation(
    input: Readonly<{
      artifactId: string;
      checkId: string;
      deploymentId: string;
      roleKind: RoleKind;
      target: CompatibilityReleaseExpectation;
    }>,
  ): Promise<void>;
}

type ActivateInput = Parameters<CompatibilityReleaseMaintenance['activate']>[0];
type ApproveInput = Parameters<CompatibilityReleaseMaintenance['approve']>[0];
type PrepareInput = Parameters<CompatibilityReleaseMaintenance['prepare']>[0];
type RecordPreactivationInput = Parameters<
  CompatibilityReleaseMaintenance['recordPreactivation']
>[0];

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function createCompatibilityReleaseMaintenance(
  config: DatabaseConfig,
): CompatibilityReleaseMaintenance {
  const pool = createDatabasePool(config);

  const transact = async (
    operation: (client: PoolClient) => Promise<void>,
  ): Promise<void> => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${quoteIdentifier(config.ownerRole)}`);
      const role = await client.query<{ current_user: string }>(
        'select current_user',
      );
      if (role.rows[0]?.current_user !== config.ownerRole)
        throw new Error('Compatibility maintenance owner role is unavailable');
      await operation(client);
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  return Object.freeze({
    prepare: async (input: PrepareInput): Promise<void> => {
      const target = parseCompatibilityReleaseExpectation(input.target);
      const predecessor = parseCompatibilityReleaseExpectation(
        input.expectedPredecessor,
      );
      const actorKind = z
        .enum(['deployment', 'migration'])
        .parse(input.actorKind);
      const actorId = actorSchema.parse(input.actorId);
      const reason = reasonSchema.parse(input.reason);
      await transact(async (client) => {
        await client.query(
          `select app.prepare_node_compatibility_release(
             $1, $2, $3::jsonb, $4, $5, $6, $7, $8
           )`,
          [
            target.epoch,
            target.fingerprint,
            target.catalogJson,
            predecessor.epoch,
            predecessor.fingerprint,
            actorKind,
            actorId,
            reason,
          ],
        );
      });
    },
    recordPreactivation: async (
      input: RecordPreactivationInput,
    ): Promise<void> => {
      const target = parseCompatibilityReleaseExpectation(input.target);
      const checkId = uuidSchema.parse(input.checkId);
      const deploymentId = deploymentIdSchema.parse(input.deploymentId);
      const roleKind = z.enum(['api', 'worker']).parse(input.roleKind);
      const artifactId = artifactIdSchema.parse(input.artifactId);
      await transact(async (client) => {
        await client.query(
          `select app.record_node_compatibility_preactivation(
             $1, $2, $3, $4, $5, $6, $7::jsonb
           )`,
          [
            checkId,
            deploymentId,
            target.epoch,
            target.fingerprint,
            roleKind,
            artifactId,
            target.catalogJson,
          ],
        );
      });
    },
    approve: async (input: ApproveInput): Promise<void> => {
      const target = parseCompatibilityReleaseExpectation(input.target);
      const approvalId = uuidSchema.parse(input.approvalId);
      const deploymentId = deploymentIdSchema.parse(input.deploymentId);
      const apiArtifacts = artifactSetSchema.parse(input.requiredApiArtifacts);
      const workerArtifacts = artifactSetSchema.parse(
        input.requiredWorkerArtifacts,
      );
      const actorId = actorSchema.parse(input.actorId);
      const reason = reasonSchema.parse(input.reason);
      await transact(async (client) => {
        await client.query(
          `select app.approve_node_compatibility_activation(
             $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8
           )`,
          [
            approvalId,
            deploymentId,
            target.epoch,
            target.fingerprint,
            JSON.stringify(apiArtifacts),
            JSON.stringify(workerArtifacts),
            actorId,
            reason,
          ],
        );
      });
    },
    activate: async (input: ActivateInput): Promise<void> => {
      const predecessor = parseCompatibilityReleaseExpectation(
        input.expectedPredecessor,
      );
      const activationId = uuidSchema.parse(input.activationId);
      const approvalId = uuidSchema.parse(input.approvalId);
      const actorKind = z
        .enum(['deployment', 'migration'])
        .parse(input.actorKind);
      const actorId = actorSchema.parse(input.actorId);
      const reason = reasonSchema.parse(input.reason);
      await transact(async (client) => {
        await client.query(
          `select app.activate_node_compatibility_release(
             $1, $2, $3, $4, $5, $6, $7
           )`,
          [
            activationId,
            predecessor.epoch,
            predecessor.fingerprint,
            approvalId,
            actorKind,
            actorId,
            reason,
          ],
        );
      });
    },
    close: async (): Promise<void> => pool.end(),
  });
}
