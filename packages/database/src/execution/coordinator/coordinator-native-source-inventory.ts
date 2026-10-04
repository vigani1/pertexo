import { isDeepStrictEqual } from 'node:util';
import { inspectJsonValue } from '@pertexo/workflow-model/canonical-json';
import { z } from 'zod';
import { persistedWorkflowOutputReferenceSchemaV3 } from '../../compatibility/persisted-workflow-checkpoint-v3.js';
import { WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1 } from '../artifacts/execution-value-representation.js';
import {
  nativeRunInputSourceMetadataSchema,
  nativeUpstreamOutputSourceMetadataSchema,
} from '../node-attempts/native-node-attempt-value-sources.js';
import type {
  NativeCallableSourceProjection,
  NativeCallableValueDescriptor,
  NativeCoordinatorMaterialDemand,
  NativeCoordinatorValueOwner,
} from './coordinator-native-value-read-contract.js';

export const nativeCallableValueIdentitySchema = z
  .object({
    reference: z.discriminatedUnion('kind', [
      z
        .object({ schemaVersion: z.literal(1), kind: z.literal('inline') })
        .strict(),
      z
        .object({
          schemaVersion: z.literal(1),
          kind: z.literal('artifact'),
          artifactId: z.uuid(),
        })
        .strict(),
    ]),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    byteLength: z.number().int().min(1).max(1_048_576),
    mediaType: z.literal(WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1),
  })
  .strict();
const projectionSchema = z
  .object({
    runInput: nativeRunInputSourceMetadataSchema
      .extend({ valueIdentity: nativeCallableValueIdentitySchema })
      .strict()
      .nullable(),
    outputs: z
      .array(
        z
          .object({
            invocationKey: z.string().min(1).max(256),
            output: persistedWorkflowOutputReferenceSchemaV3,
            valueSource: nativeUpstreamOutputSourceMetadataSchema
              .extend({ valueIdentity: nativeCallableValueIdentitySchema })
              .strict(),
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict();

function assertScope(
  source: NativeCallableValueDescriptor,
  owner: NativeCoordinatorValueOwner,
): void {
  const actual = source.source;
  const runId =
    actual.kind === 'workflow_call_result' ? actual.parentRunId : actual.runId;
  const versionId =
    actual.kind === 'workflow_call_result'
      ? actual.parentWorkflowVersionId
      : actual.workflowVersionId;
  if (
    actual.workspaceId !== owner.workspaceId ||
    runId !== owner.runId ||
    versionId !== owner.workflowVersionId
  )
    throw new TypeError('Coordinator source scope does not agree');
}

/** Closed bounded metadata only. Parsing never fetches or decodes original payloads. */
export function parseCoordinatorNativeSourceInventory(
  value: unknown,
  owner: NativeCoordinatorValueOwner,
  demand: NativeCoordinatorMaterialDemand,
): NativeCallableSourceProjection {
  if (
    demand.expectedRevision !== owner.expectedRevision ||
    demand.sources.length > 1_000
  )
    throw new TypeError('Coordinator source demand does not agree');
  const projection = projectionSchema.parse(value);
  if (inspectJsonValue(projection).bytes > 1_048_576)
    throw new TypeError('Coordinator source inventory exceeds identity bounds');
  if (
    (!demand.requiresRunInput && projection.runInput !== null) ||
    projection.outputs.length !== demand.sources.length
  )
    throw new TypeError('Coordinator source inventory does not agree');
  if (projection.runInput !== null) assertScope(projection.runInput, owner);
  const nodes = new Set<string>();
  const invocations = new Set<string>();
  for (let index = 0; index < projection.outputs.length; index++) {
    const actual = projection.outputs[index];
    const expected = demand.sources[index];
    if (actual === undefined || expected === undefined)
      throw new TypeError('Coordinator selected source inventory is missing');
    const source = actual.valueSource.source;
    assertScope(actual.valueSource, owner);
    if (
      actual.invocationKey !== expected.invocationKey ||
      source.invocationKey !== expected.invocationKey ||
      source.nodeId !== expected.nodeId ||
      !isDeepStrictEqual(actual.output, expected.output) ||
      nodes.has(source.nodeId) ||
      invocations.has(source.invocationKey)
    )
      throw new TypeError(
        'Coordinator selected source inventory does not agree',
      );
    nodes.add(source.nodeId);
    invocations.add(source.invocationKey);
    const reference = actual.valueSource.valueIdentity.reference;
    const output = actual.output;
    if (output.kind === 'workflow_call') {
      if (
        source.kind !== 'workflow_call_result' ||
        output.childRunId !== source.childRunId ||
        output.invocationKey !== source.invocationKey
      )
        throw new TypeError(
          'Coordinator logical source identity does not agree',
        );
    } else if (
      source.kind !== 'physical_output' ||
      (output.kind === 'inline'
        ? reference.kind !== 'inline' || output.attemptId !== source.attemptId
        : reference.kind !== 'artifact' ||
          output.artifactId !== reference.artifactId)
    )
      throw new TypeError(
        'Coordinator physical source identity does not agree',
      );
  }
  return projection;
}
