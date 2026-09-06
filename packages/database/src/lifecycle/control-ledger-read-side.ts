import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
import {
  EXPECTED_MIGRATION_HEAD,
  MINIMUM_POSTGRES_MAJOR,
} from '../platform/readiness.js';
import { sha256HexSchema as hashSchema } from '../validation/persisted-primitives.js';
import {
  acquirePoolClient,
  query,
  type MaintenancePool,
} from './control-ledger-postgres.js';
import { ControlLedgerReconciliationError } from './control-ledger-errors.js';

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);

export interface CommittedArtifactInventoryRecord {
  readonly artifactId: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly sha256: string;
  readonly workspaceId: string;
}

export interface CommittedArtifactInventoryPage {
  readonly artifacts: readonly CommittedArtifactInventoryRecord[];
  readonly hasMore: boolean;
}

export interface CommittedArtifactInventoryInput {
  readonly afterArtifactId?: string;
  readonly afterWorkspaceId?: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface ControlLedgerReadSide {
  checkRestoreReadiness(input: {
    readonly expectedMaintenanceRole: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  listCommittedArtifacts(
    input: CommittedArtifactInventoryInput,
  ): Promise<CommittedArtifactInventoryPage>;
}

export function createControlLedgerReadSide(
  config: DatabaseConfig,
  pool: MaintenancePool,
): ControlLedgerReadSide {
  return Object.freeze({
    checkRestoreReadiness: async (input: {
      readonly expectedMaintenanceRole: string;
      readonly signal?: AbortSignal;
    }): Promise<void> => {
      const parsedInput = z
        .object({
          expectedMaintenanceRole: z.string().regex(/^[a-z_][a-z0-9_]*$/u),
          signal: z
            .custom<AbortSignal>((value) => value instanceof AbortSignal)
            .optional(),
        })
        .strict()
        .parse(input);
      const client = await acquirePoolClient(pool, parsedInput.signal);
      try {
        const result = await query<{
          boundary_compatible: boolean;
          current_user: string;
          migration_head: string | null;
          postgres_major: number;
        }>(
          client,
          `select current_user,
             current_setting('server_version_num')::integer / 10000 as postgres_major,
             (select name from pertexo_internal.schema_migrations order by name desc limit 1) as migration_head,
             not role.rolsuper
               and not role.rolbypassrls
               and not pg_has_role(current_user,$1::name,'MEMBER')
               and has_function_privilege(current_user,'app.lock_workspace_control_ledger(uuid)','EXECUTE')
               and has_function_privilege(current_user,'app.project_workspace_legal_hold(uuid,bigint,uuid,character varying,uuid,character,character,character varying,character varying,character varying,timestamp with time zone)','EXECUTE')
               and has_function_privilege(current_user,'app.project_workspace_deletion(uuid,bigint,uuid,character varying,uuid,character,character,character varying,character varying,character varying,timestamp with time zone,interval)','EXECUTE')
               and has_function_privilege(current_user,'app.enumerate_workspace_control_anchors(uuid,integer)','EXECUTE')
               and has_function_privilege(current_user,'app.enumerate_committed_tenant_artifacts(uuid,uuid,integer)','EXECUTE')
                and has_function_privilege(current_user,'app.find_due_workspace_purge()','EXECUTE')
                and has_function_privilege(current_user,'app.workspace_purge_repair_command_id(uuid)','EXECUTE')
                and has_function_privilege(current_user,'app.prepare_workspace_purge_job(uuid,bigint,character,character varying,interval)','EXECUTE')
                and has_function_privilege(current_user,'app.project_workspace_purge_started(uuid,uuid,bigint,bigint,character,character)','EXECUTE')
                and has_function_privilege(current_user,'app.find_due_workspace_purge_step()','EXECUTE')
                and has_function_privilege(current_user,'app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)','EXECUTE')
                and has_function_privilege(current_user,'app.checkpoint_workspace_object_versions_page(uuid,uuid,bigint,integer,boolean,bigint,character)','EXECUTE')
                and has_function_privilege(current_user,'app.release_workspace_purge_step(uuid,uuid,bigint)','EXECUTE')
                and has_function_privilege(current_user,'app.find_due_workspace_purge_completion()','EXECUTE')
                and has_function_privilege(current_user,'app.prepare_workspace_purge_completion(uuid,bigint,character,character varying,interval)','EXECUTE')
                and has_function_privilege(current_user,'app.authorize_workspace_purge_completion_append(uuid,uuid,bigint,bigint,character)','EXECUTE')
                and has_function_privilege(current_user,'app.project_workspace_purge_completion(uuid,uuid,bigint,bigint,character,character)','EXECUTE')
               and not has_table_privilege(current_user,'app.workspaces','INSERT,UPDATE,DELETE,TRUNCATE')
               and not has_table_privilege(current_user,'app.workspace_control_ledger_projection','INSERT,UPDATE,DELETE,TRUNCATE')
               as boundary_compatible
           from pg_roles role where role.rolname=current_user`,
          [config.ownerRole],
          parsedInput.signal,
        );
        const row = result.rows.at(0);
        if (
          result.rowCount !== 1 ||
          row?.current_user !== parsedInput.expectedMaintenanceRole ||
          row.postgres_major < MINIMUM_POSTGRES_MAJOR ||
          row.migration_head !== EXPECTED_MIGRATION_HEAD ||
          !row.boundary_compatible
        )
          throw new Error(
            'Restore maintenance database boundary is incompatible',
          );
      } finally {
        client.release();
      }
    },
    listCommittedArtifacts: async (
      input: CommittedArtifactInventoryInput,
    ): Promise<CommittedArtifactInventoryPage> => {
      const parsedInput = z
        .object({
          afterArtifactId: uuidSchema.optional(),
          afterWorkspaceId: uuidSchema.optional(),
          limit: z.number().int().min(1).max(999),
          signal: z
            .custom<AbortSignal>((value) => value instanceof AbortSignal)
            .optional(),
        })
        .strict()
        .superRefine((value, context) => {
          if (
            (value.afterArtifactId === undefined) !==
            (value.afterWorkspaceId === undefined)
          )
            context.addIssue({
              code: 'custom',
              message: 'Artifact inventory cursor must be complete',
            });
        })
        .parse(input);
      const client = await acquirePoolClient(pool, parsedInput.signal);
      try {
        const result = await query<{
          artifact_id: string;
          byte_length: string | number;
          media_type: string;
          sha256: string;
          workspace_id: string;
        }>(
          client,
          `select workspace_id,artifact_id,byte_length,media_type,sha256
             from app.enumerate_committed_tenant_artifacts($1,$2,$3)`,
          [
            parsedInput.afterWorkspaceId ?? null,
            parsedInput.afterArtifactId ?? null,
            parsedInput.limit + 1,
          ],
          parsedInput.signal,
        );
        const hasMore = result.rows.length > parsedInput.limit;
        const artifacts = result.rows.slice(0, parsedInput.limit).map((row) => {
          const byteLength = Number(row.byte_length);
          if (!Number.isSafeInteger(byteLength) || byteLength < 0)
            throw new ControlLedgerReconciliationError(
              'Committed artifact inventory contains an invalid byte length',
            );
          return Object.freeze({
            artifactId: uuidSchema.parse(row.artifact_id),
            byteLength,
            mediaType: boundedText(255).parse(row.media_type),
            sha256: hashSchema.parse(row.sha256),
            workspaceId: uuidSchema.parse(row.workspace_id),
          });
        });
        return Object.freeze({ artifacts: Object.freeze(artifacts), hasMore });
      } finally {
        client.release();
      }
    },
  });
}
