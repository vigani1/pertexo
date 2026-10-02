import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { DatabaseConfig } from '../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../platform/database-runtime.js';
import { withTenantScopedClient } from '../tenant-access/workspace.js';
import {
  WorkflowIdempotencyConflictError,
  WorkflowNotFoundError,
} from './workflow-authoring-errors.js';
import {
  WorkflowOrganizationUnavailableError,
  WorkflowOrganizationValidationError,
} from './workflow-organization-errors.js';
export {
  WorkflowOrganizationUnavailableError,
  WorkflowOrganizationValidationError,
} from './workflow-organization-errors.js';

type FavoriteScope = Readonly<{
  workspaceId: string;
  actorId: string;
  workflowId: string;
  signal?: AbortSignal;
}>;
type TokenScope = Pick<FavoriteScope, 'workspaceId' | 'actorId' | 'workflowId'>;
type AbsenceProof = Readonly<{
  generation: string;
  issuedAtSeconds: number;
  expiresAtSeconds: number;
}>;

/** Private cryptographic seam, injected by the application key owner. Neither
 * generation nor verification proof is a transport request field. A rejected
 * token returns null; unexpected operational/programming failures still throw. */
export interface WorkflowFavoriteAbsenceTokenAuthority {
  readonly issue: (
    scope: TokenScope,
    snapshot: Readonly<{ generation: string; issuedAtSeconds: number }>,
  ) => string;
  readonly verify: (
    value: string,
    scope: TokenScope,
    generation: string,
  ) => AbsenceProof | null;
}
export type WorkflowFavoriteState = Readonly<{
  isFavorite: boolean;
  favoriteRevision: string;
}>;
export type WorkflowFavoriteResult = WorkflowFavoriteState &
  Readonly<{ replayed: boolean }>;
export type WorkflowFavoriteCommand = FavoriteScope &
  Readonly<{
    favorite: boolean;
    expectedFavoriteRevision: string;
    idempotencyKey: string;
  }>;
export interface WorkflowFavoriteDatabase {
  readFavorite(input: FavoriteScope): Promise<WorkflowFavoriteState>;
  setFavorite(input: WorkflowFavoriteCommand): Promise<WorkflowFavoriteResult>;
  close(): Promise<void>;
}
export class WorkflowFavoriteRevisionConflictError extends Error {
  override readonly name = 'WorkflowFavoriteRevisionConflictError';
  constructor() {
    super('Workflow favorite revision does not match');
  }
}

const uuid = z.uuid().overwrite((value) => value.toLowerCase());
const seconds = z.number().int().min(0).max(253_402_300_799);
const scopeSchema = z.object({
  workspaceId: uuid,
  actorId: uuid,
  workflowId: uuid,
  signal: z.instanceof(AbortSignal).optional(),
});
function parseScope(input: FavoriteScope): FavoriteScope {
  const { signal, ...scope } = scopeSchema.parse(input);
  return signal === undefined ? scope : { ...scope, signal };
}
const absenceRevisionSchema = z
  .string()
  .max(128)
  .regex(
    /^absent\.v1\.(0|[1-9][0-9]{0,11})\.(0|[1-9][0-9]{0,11})\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$(?![\s\S])/u,
  )
  .refine((value) => {
    const parts = value.split('.');
    const issued = Number(parts[2]);
    const expires = Number(parts[3]);
    return expires <= 253_402_300_799 && expires - issued === 86_400;
  });
const keySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$(?![\s\S])/u)
  .refine((value) => !value.includes(','));
const bodySchema = z
  .object({
    favorite: z.boolean(),
    expectedFavoriteRevision: z.string().min(1).max(128),
  })
  .strict();
const stateSchema = z
  .object({ isFavorite: z.boolean(), favoriteRevision: uuid })
  .strict();
const resultSchema = stateSchema.extend({ replayed: z.boolean() }).strict();
const snapshotSchema = z
  .object({ generation: uuid, readAtSeconds: seconds })
  .strict();
const proofSchema = z
  .object({
    generation: uuid,
    issuedAtSeconds: seconds,
    expiresAtSeconds: seconds,
  })
  .strict()
  .refine((proof) => proof.expiresAtSeconds - proof.issuedAtSeconds === 86_400);
const claimSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('replay'), result: resultSchema }).strict(),
  z.object({ kind: z.literal('new'), generation: uuid }).strict(),
]);

function mapFavoriteFailure(error: unknown): never {
  const pg = z.object({ code: z.string() }).safeParse(error);
  if (!pg.success) throw error;
  switch (pg.data.code) {
    case '42501':
      throw new WorkflowNotFoundError('Workflow is not visible');
    case 'P7001':
      throw new WorkflowOrganizationUnavailableError();
    case 'P7002':
      throw new WorkflowIdempotencyConflictError(
        'Idempotency key request mismatch',
      );
    case 'P7010':
      throw new WorkflowFavoriteRevisionConflictError();
    case '22023':
      throw new WorkflowOrganizationValidationError();
    default:
      throw error;
  }
}

/** Owns receipt-first authentication and write in one tenant transaction. No
 * caller coordinates locks or supplies a trusted generation/clock selector. */
export function createWorkflowFavoriteDatabase(
  config: DatabaseConfig,
  options: Readonly<{
    absenceTokens: WorkflowFavoriteAbsenceTokenAuthority;
    runtime?: DatabaseRuntime;
  }>,
): WorkflowFavoriteDatabase {
  const lease = acquireDatabasePool(config, options.runtime);
  async function transact<T>(
    input: FavoriteScope,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const scope = parseScope(input);
    try {
      return await withTenantScopedClient(
        lease.pool,
        scope,
        operation,
        scope.signal === undefined ? {} : { signal: scope.signal },
      );
    } catch (error: unknown) {
      return mapFavoriteFailure(error);
    }
  }
  return Object.freeze({
    async readFavorite(input: FavoriteScope): Promise<WorkflowFavoriteState> {
      const scope = parseScope(input);
      return transact(scope, async (client) => {
        const snapshot = await client.query<{ snapshot: unknown }>(
          'select app.read_workflow_favorite_generation() snapshot',
        );
        const current = snapshotSchema.parse(snapshot.rows[0]?.snapshot);
        const visible = await client.query(
          'select 1 from app.workflows where workspace_id=$1 and id=$2 for share',
          [scope.workspaceId, scope.workflowId],
        );
        if (visible.rowCount !== 1)
          throw new WorkflowNotFoundError('Workflow is not visible');
        const favorite = await client.query<{
          favorite: boolean;
          revision: string;
        }>(
          'select favorite,revision from app.workflow_favorites where workspace_id=$1 and actor_id=$2 and workflow_id=$3',
          [scope.workspaceId, scope.actorId, scope.workflowId],
        );
        const row = favorite.rows[0];
        if (row !== undefined)
          return Object.freeze(
            stateSchema.parse({
              isFavorite: row.favorite,
              favoriteRevision: row.revision,
            }),
          );
        return Object.freeze({
          isFavorite: false,
          favoriteRevision: absenceRevisionSchema.parse(
            options.absenceTokens.issue(
              {
                workspaceId: scope.workspaceId,
                actorId: scope.actorId,
                workflowId: scope.workflowId,
              },
              {
                generation: current.generation,
                issuedAtSeconds: current.readAtSeconds,
              },
            ),
          ),
        });
      });
    },
    async setFavorite(
      input: WorkflowFavoriteCommand,
    ): Promise<WorkflowFavoriteResult> {
      const scope = parseScope(input);
      const body = bodySchema.parse({
        favorite: input.favorite,
        expectedFavoriteRevision: input.expectedFavoriteRevision,
      });
      const digest = createHash('sha256')
        .update(keySchema.parse(input.idempotencyKey))
        .digest('hex');
      return transact(scope, async (client) => {
        const args = [scope.workflowId, digest, JSON.stringify(body)];
        const prepared = await client.query<{ claim: unknown }>(
          'select app.prepare_workflow_favorite_command($1,$2,$3::jsonb) claim',
          args,
        );
        const claim = claimSchema.parse(prepared.rows[0]?.claim);
        // Crucially bypass MAC/expiry/key rotation after an exact committed
        // recovery. SQL has already fenced current authority/visibility/lifetime.
        if (claim.kind === 'replay') return Object.freeze(claim.result);
        let proof: AbsenceProof | null = null;
        if (body.expectedFavoriteRevision.startsWith('absent.v1.')) {
          const verified = options.absenceTokens.verify(
            body.expectedFavoriteRevision,
            {
              workspaceId: scope.workspaceId,
              actorId: scope.actorId,
              workflowId: scope.workflowId,
            },
            claim.generation,
          );
          if (verified === null)
            throw new WorkflowFavoriteRevisionConflictError();
          proof = proofSchema.parse(verified);
          if (proof.generation !== claim.generation)
            throw new WorkflowFavoriteRevisionConflictError();
        }
        const written = await client.query<{ result: unknown }>(
          'select app.execute_workflow_favorite_command($1,$2,$3::jsonb,$4,$5,$6) result',
          [
            ...args,
            proof?.generation ?? null,
            proof?.issuedAtSeconds ?? null,
            proof?.expiresAtSeconds ?? null,
          ],
        );
        return Object.freeze(resultSchema.parse(written.rows[0]?.result));
      });
    },
    close: lease.close,
  });
}
