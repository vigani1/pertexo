import type { Pool, PoolClient } from 'pg';
import { expect, it } from 'vitest';
import { ARTIFACT_OWNER_SOURCES } from '../../src/schema/artifacts/references.js';
import { withDatabase } from '../platform/migrations/upgrade-fixture.js';
import { seedReferenceIndexOwners } from './reference-index.fixture.js';

it('keeps the index equal to a JSON recompute through writes to every owner family', async () => {
  await withDatabase(async ({ admin }) => {
    const { workspaceId, artifactId, businessId, descriptor } =
      await seedReferenceIndexOwners(admin);
    const stored = async (connection: Pool | PoolClient = admin) =>
      (
        await connection.query<{ reference: string }>(
          `select concat_ws('/',workspace_id,artifact_id,owner_family,owner_id,owner_sub_id,owner_slot) reference
       from app.artifact_owner_references where workspace_id=$1 order by reference`,
          [workspaceId],
        )
      ).rows.map((row) => row.reference);
    const recompute = async (connection: Pool | PoolClient = admin) => {
      const references: string[] = [];
      for (const source of ARTIFACT_OWNER_SOURCES) {
        for (const [slot, format] of Object.entries(source.values)) {
          const result = await connection.query<{ reference: string }>(
            `select distinct concat_ws('/',owner.workspace_id,reference,'${source.table}',owner.${source.id},${source.sub ? 'owner.' + source.sub : '0'},'${slot}') reference
             from app.${source.table} owner
             cross join lateral app.artifact_owner_ids(to_jsonb(owner)->$2,$3) reference
             where owner.workspace_id=$1`,
            [workspaceId, slot, format],
          );
          references.push(...result.rows.map((row) => row.reference));
        }
      }
      return references.sort();
    };
    const expected = await recompute();
    expect(expected).toHaveLength(58);

    expect(await stored()).toEqual(expected);
    async function exerciseSlotTransitions(
      source: (typeof ARTIFACT_OWNER_SOURCES)[number],
      client: PoolClient,
      otherOwners: string[],
      assignments: string[],
    ) {
      for (const [slot, format] of Object.entries(source.values)) {
        const expectedSlot = expected.filter(
          (reference) =>
            reference.includes('/' + source.table + '/') &&
            reference.endsWith('/' + slot),
        );
        expect(expectedSlot.length).toBeGreaterThan(0);
        for (const id of [artifactId, businessId]) {
          const document = referenceDocument(format, id, descriptor);
          const value = JSON.stringify(document);
          let extra = '';
          if (source.table === 'workflow_input_case_payloads')
            extra =
              ',canonical_bytes=octet_length($1::text)+coalesce(octet_length(expectations),0)';
          if (source.table === 'workflow_step_samples')
            extra =
              ',retained_bytes=octet_length(binding)+octet_length($1::text)';
          await client.query(
            `update app.${source.table} set ${slot}=$1${extra} where workspace_id=$2`,
            [value, workspaceId],
          );
          expect(
            await stored(client),
            `${source.table}.${slot} -> ${id}`,
          ).toEqual(
            [
              ...otherOwners,
              ...expectedSlot.map((reference) =>
                reference.replace('/' + artifactId + '/', '/' + id + '/'),
              ),
            ].sort(),
          );
          expect(await stored(client)).toEqual(await recompute(client));
        }
        await client.query(
          `update app.${source.table} set ${assignments.join(',')} where workspace_id=$1`,
          [workspaceId],
        );
        expect(await stored(client)).toEqual(otherOwners);
      }
    }
    const client = await admin.connect();
    try {
      for (const source of ARTIFACT_OWNER_SOURCES) {
        await client.query('begin');
        try {
          const assignments = Object.entries(source.values).map(
            ([slot, format]) => {
              const empty =
                format.startsWith('authored') ||
                format === 'event' ||
                format === 'checkpoint'
                  ? '{}'
                  : '{"kind":"inline","value":null}';
              return `${slot}='${empty}'`;
            },
          );
          if (source.table === 'workflow_input_case_payloads')
            assignments.push(
              'canonical_bytes=2+coalesce(octet_length(expectations),0)',
            );
          if (source.table === 'workflow_step_samples')
            assignments.push(
              'retained_bytes=octet_length(binding)+octet_length(\'{"kind":"inline","value":null}\')',
            );
          await client.query(
            `update app.${source.table} set ${assignments.join(',')} where workspace_id=$1`,
            [workspaceId],
          );
          const remaining = (
            await client.query<{ reference: string }>(
              `select concat_ws('/',workspace_id,artifact_id,owner_family,owner_id,owner_sub_id,owner_slot) reference
             from app.artifact_owner_references where workspace_id=$1 order by reference`,
              [workspaceId],
            )
          ).rows.map((row) => row.reference);
          expect(remaining).toEqual(
            expected.filter(
              (reference) => !reference.includes('/' + source.table + '/'),
            ),
          );
          await exerciseSlotTransitions(source, client, remaining, assignments);
        } finally {
          await client.query('rollback');
        }
        expect(await stored()).toEqual(await recompute());
      }
    } finally {
      client.release();
    }
  });
}, 60_000);

function referenceDocument(
  format: string,
  id: string,
  descriptor: Record<string, unknown>,
) {
  const full = { ...descriptor, artifactId: id };
  if (format === 'value-text') return { kind: 'inline', value: full };
  if (format.startsWith('authored')) return full;
  // Execution roots intentionally include legacy descriptors without metadata.
  const legacy = { kind: 'artifact', artifactId: id };
  if (format === 'event') return { output: legacy };
  if (format === 'checkpoint') return { invocations: [{ output: legacy }] };
  return legacy;
}
