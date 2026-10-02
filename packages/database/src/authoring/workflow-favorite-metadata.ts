import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { WorkflowFavoriteAbsenceTokenAuthority } from './workflow-favorites.js';

type Scope = Readonly<{
  workspaceId: string;
  actorId: string;
  workflowId: string;
}>;
const snapshot = z
  .object({
    generation: z.uuid(),
    readAtSeconds: z.number().int().min(0).max(253_402_300_799),
  })
  .strict();
type Snapshot = z.output<typeof snapshot>;
const absence = z
  .string()
  .max(128)
  .regex(
    /^absent\.v1\.(0|[1-9][0-9]{0,11})\.(0|[1-9][0-9]{0,11})\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$(?![\s\S])/u,
  )
  .refine((value) => {
    const parts = value.split('.'),
      issued = Number(parts[2]),
      expires = Number(parts[3]);
    return expires <= 253_402_300_799 && expires - issued === 86_400;
  });

/** Private generation and database clock stay inside the tenant transaction;
 * only the authenticated opaque revision is projected to callers. */
export async function readWorkflowFavoriteGeneration(
  client: PoolClient,
): Promise<Snapshot> {
  const result = await client.query<{ snapshot: unknown }>(
    'select app.read_workflow_favorite_generation() snapshot',
  );
  return snapshot.parse(result.rows[0]?.snapshot);
}
export function issueWorkflowFavoriteAbsenceRevision(
  authority: WorkflowFavoriteAbsenceTokenAuthority,
  scope: Scope,
  current: Snapshot,
): string {
  return absence.parse(
    authority.issue(scope, {
      generation: current.generation,
      issuedAtSeconds: current.readAtSeconds,
    }),
  );
}
