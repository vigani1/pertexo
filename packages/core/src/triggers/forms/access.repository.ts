import type { SealedConnectionSecret } from '@pertexo/secrets/server';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowForms } from '@pertexo/database/schema';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { FormAccess } from '@pertexo/contracts';
import { generatePersistedId } from '@pertexo/database/platform';
import type { SetFormAccessInput } from './form-admission.types.js';
export const capabilityHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const accessSelection = {
  access: workflowForms.access,
  publicId: workflowForms.publicId,
  revision: workflowForms.revision,
};
export async function readFormAccess(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; workflowId: string }>,
): Promise<FormAccess> {
  const rows = await drizzle(client)
    .select(accessSelection)
    .from(workflowForms)
    .where(
      and(
        eq(workflowForms.workspaceId, input.workspaceId),
        eq(workflowForms.workflowId, input.workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  return rows[0] ?? { access: 'members', publicId: null, revision: 0 };
}
export async function upsertFormAccess(
  client: PoolClient,
  input: SetFormAccessInput,
  nodeId: string,
  digest: string | null,
): Promise<FormAccess> {
  const db = drizzle(client);
  const result = await db
    .insert(workflowForms)
    .values({
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      publicId: generatePersistedId(),
      access: input.access,
      capabilityHash: digest,
      sealedCapability:
        input.access === 'public' ? input.sealedCapability : null,
      revision: 1,
      nodeId,
    })
    .onConflictDoUpdate({
      target: [workflowForms.workspaceId, workflowForms.workflowId],
      set: {
        access: input.access,
        capabilityHash: digest,
        sealedCapability:
          input.access === 'public' ? input.sealedCapability : null,
        nodeId,
        revision: sql`${workflowForms.revision}+1`,
        updatedAt: sql`clock_timestamp()`,
      },
    })
    .returning(accessSelection)
    .catch(rethrowQueryFailure);
  const changed = result[0];
  if (changed === undefined) throw new Error('Form access write missing');
  return changed;
}

/** The managing flow calls this only after checking workflow:update in the folder. */
export async function readSealedFormCapability(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; workflowId: string }>,
): Promise<SealedConnectionSecret | null> {
  const [row] = await drizzle(client)
    .select({ sealedCapability: workflowForms.sealedCapability })
    .from(workflowForms)
    .where(
      and(
        eq(workflowForms.workspaceId, input.workspaceId),
        eq(workflowForms.workflowId, input.workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  return (row?.sealedCapability ?? null) as SealedConnectionSecret | null;
}
