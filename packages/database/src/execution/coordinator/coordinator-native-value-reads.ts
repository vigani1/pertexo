import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { z } from 'zod';
import { callableValueWorkStopSchema } from '@pertexo/workflow-model/workflow-call-contract';
import { withTenantScopedReadClient } from '../../tenant-access/workspace.js';
import { serializeWorkflowExecutionJsonValueV3 } from '../stored-execution-value.js';
import { parseNativeNodeAttemptValueSource } from '../node-attempts/native-node-attempt-value-sources.js';
import { parseCoordinatorNativeSourceInventory } from './coordinator-native-source-inventory.js';
import type {
  InspectCoordinatorValueReadOwner,
  LoadCallableCompletionSources,
  ReadCallableCompletionSource,
  NativeCoordinatorValueOwner,
  ReadCoordinatorCallDeclaration,
  LoadCoordinatorControlSources,
  ReadCoordinatorControlSource,
} from './coordinator-native-value-read-contract.js';
import { parseCoordinatorArtifactCallDeclarationRow } from './coordinator-call-declaration-source.js';
import { parseCoordinatorControlDeclarationInventory } from './coordinator-control-declaration-source.js';

const ownerSchema = z
  .object({
    workspaceId: z.uuid(),
    runId: z.uuid(),
    workflowVersionId: z.uuid(),
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    delivery: z
      .object({
        outboxEventId: z.uuid(),
        payloadChecksum: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .strict(),
  })
  .strict();
const stoppedSchema = z
  .object({ kind: z.literal('stopped'), stop: callableValueWorkStopSchema })
  .strict();
const inspectionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('active'),
      databaseNow: z.iso.datetime({ offset: true }),
      deadlineAt: z.iso.datetime({ offset: true }).nullable(),
    })
    .strict(),
  stoppedSchema,
]);
export function parseNativeCoordinatorInspection(value: unknown) {
  return inspectionSchema.parse(value);
}
const readySchema = z
  .object({ kind: z.literal('ready'), projection: z.unknown() })
  .strict();
const sourceSchema = z
  .object({ kind: z.literal('ready'), valueSource: z.unknown() })
  .strict();

function knownReadOutage(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof AggregateError)
    return false;
  if (error.name === 'AbortError') return true;
  const code = Reflect.get(error, 'code') as unknown;
  return (
    typeof code === 'string' &&
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      '08001',
      '08006',
      '57P01',
      '53300',
      '57014',
    ].includes(code)
  );
}

/** Actual tenant read owner: one shared pool, existing bounded checkout/query/join lifecycle. */
export function parseNativeCoordinatorControlReadTimeoutMillis(
  value: number,
): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 5_000)
    throw new RangeError('Invalid native coordinator control read budget');
  return value;
}

export function createNativeCoordinatorValueReads(
  pool: Pool,
  controlReadTimeoutMillis: number,
): Readonly<{
  inspectCoordinatorValueReadOwner: InspectCoordinatorValueReadOwner;
  loadCallableCompletionSources: LoadCallableCompletionSources;
  readCallableCompletionSource: ReadCallableCompletionSource;
  readCoordinatorCallDeclaration: ReadCoordinatorCallDeclaration;
  loadCoordinatorControlSources: LoadCoordinatorControlSources;
  readCoordinatorControlSource: ReadCoordinatorControlSource;
}> {
  parseNativeCoordinatorControlReadTimeoutMillis(controlReadTimeoutMillis);

  async function read(
    input: Readonly<{
      owner: NativeCoordinatorValueOwner;
      signal: AbortSignal;
      readTimeoutMillis: number;
    }>,
    statement: string,
    extra: readonly string[],
    reason: 'control_read_failed' | 'source_read_failed',
  ): Promise<unknown> {
    const owner = ownerSchema.parse(
      JSON.parse(serializeWorkflowExecutionJsonValueV3(input.owner)) as unknown,
    );
    if (!(input.signal instanceof AbortSignal))
      throw new TypeError('Native coordinator read signal is invalid');
    if (input.signal.aborted)
      return { kind: 'stopped', stop: { kind: 'context_aborted' } };
    try {
      return await withTenantScopedReadClient(
        pool,
        { workspaceId: owner.workspaceId },
        async (client) => {
          const result = await client.query<{ result: unknown }>(statement, [
            serializeWorkflowExecutionJsonValueV3(owner),
            ...extra,
          ]);
          if (result.rows.length !== 1 || result.rows[0]?.result === undefined)
            throw new TypeError(
              'Native coordinator protected read omitted its result',
            );
          return result.rows[0].result;
        },
        {
          signal: input.signal,
          nativeReadBudget: {
            readTimeoutMillis: input.readTimeoutMillis,
            controlReadTimeoutMillis,
          },
        },
      );
    } catch (error: unknown) {
      if (!knownReadOutage(error)) throw error;
      return {
        kind: 'stopped',
        // The context may be canceled during checkout, query, or joined disposal.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        stop: input.signal.aborted
          ? { kind: 'context_aborted' }
          : { kind: 'unavailable', reason },
      };
    }
  }

  return Object.freeze({
    loadCoordinatorControlSources: async (input) => {
      const response = await read(
        input,
        'select app.load_native_coordinator_control_sources($1::jsonb,$2::integer) as result',
        [String(input.lastSequence)],
        'source_read_failed',
      );
      const stopped = stoppedSchema.safeParse(response);
      if (stopped.success) return stopped.data;
      return Object.freeze({
        kind: 'ready',
        sources: parseCoordinatorControlDeclarationInventory(
          readySchema.parse(response).projection,
          input.owner,
          input.expected,
        ),
      });
    },
    readCoordinatorControlSource: async (input) => {
      const response = await read(
        input,
        'select app.read_native_coordinator_control_source($1::jsonb,$2::jsonb) as result',
        [serializeWorkflowExecutionJsonValueV3(input.source)],
        'source_read_failed',
      );
      const stopped = stoppedSchema.safeParse(response);
      if (stopped.success) return stopped.data;
      const valueSource = parseNativeNodeAttemptValueSource(
        sourceSchema.parse(response).valueSource,
      );
      const expected = input.source.valueSource;
      const snapshot = valueSource.snapshot;
      const reference =
        snapshot.reference.kind === 'inline'
          ? { schemaVersion: 1, kind: 'inline' }
          : snapshot.reference;
      if (
        valueSource.slot !== expected.slot ||
        !isDeepStrictEqual(valueSource.source, expected.source) ||
        !isDeepStrictEqual(reference, expected.valueIdentity.reference) ||
        snapshot.sha256 !== expected.valueIdentity.sha256 ||
        snapshot.byteLength !== expected.valueIdentity.byteLength
      )
        throw new TypeError('Native control accepted source identity differs');
      return Object.freeze({ kind: 'ready', valueSource });
    },
    readCoordinatorCallDeclaration: async (input) => {
      const response = await read(
        input,
        `select jsonb_build_object('kind','ready','projection',to_jsonb(material)) as result
         from app.read_workflow_call_declaration_materials(($1::jsonb->>'runId')::uuid,
           array[$2::text],$1::jsonb) material`,
        [input.source.invocationKey],
        'source_read_failed',
      );
      const stopped = stoppedSchema.safeParse(response);
      if (stopped.success) return stopped.data;
      const source = parseCoordinatorArtifactCallDeclarationRow(
        readySchema.parse(response).projection,
      );
      if (!isDeepStrictEqual(source, input.source))
        throw new TypeError(
          'Native coordinator Call declaration identity differs',
        );
      return Object.freeze({ kind: 'ready', source });
    },
    inspectCoordinatorValueReadOwner: async (input) =>
      parseNativeCoordinatorInspection(
        await read(
          input,
          `select app.inspect_native_coordinator_value_owner($1::jsonb) as result`,
          [],
          'control_read_failed',
        ),
      ),
    loadCallableCompletionSources: async (input) => {
      const response = await read(
        input,
        `select app.load_native_coordinator_value_sources($1::jsonb,$2::jsonb) as result`,
        [serializeWorkflowExecutionJsonValueV3(input.demand)],
        'source_read_failed',
      );
      const stopped = stoppedSchema.safeParse(response);
      if (stopped.success) return stopped.data;
      const ready = readySchema.parse(response);
      return Object.freeze({
        kind: 'ready',
        projection: parseCoordinatorNativeSourceInventory(
          ready.projection,
          input.owner,
          input.demand,
        ),
      });
    },
    readCallableCompletionSource: async (input) => {
      const response = await read(
        input,
        `select app.read_native_coordinator_value_source($1::jsonb,$2::jsonb) as result`,
        [serializeWorkflowExecutionJsonValueV3(input.source)],
        'source_read_failed',
      );
      const stopped = stoppedSchema.safeParse(response);
      if (stopped.success) return stopped.data;
      const ready = sourceSchema.parse(response);
      const valueSource = parseNativeNodeAttemptValueSource(ready.valueSource);
      if (
        valueSource.slot !== input.source.slot ||
        !isDeepStrictEqual(valueSource.source, input.source.source) ||
        valueSource.snapshot.sha256 !== input.source.valueIdentity.sha256 ||
        valueSource.snapshot.byteLength !==
          input.source.valueIdentity.byteLength ||
        valueSource.snapshot.reference.kind !==
          input.source.valueIdentity.reference.kind ||
        (valueSource.snapshot.reference.kind === 'artifact' &&
          (input.source.valueIdentity.reference.kind !== 'artifact' ||
            valueSource.snapshot.reference.artifactId !==
              input.source.valueIdentity.reference.artifactId))
      )
        throw new TypeError(
          'Native coordinator accepted source identity differs',
        );
      return Object.freeze({ kind: 'ready', valueSource });
    },
  });
}
