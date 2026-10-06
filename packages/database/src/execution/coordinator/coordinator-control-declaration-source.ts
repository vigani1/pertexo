import { isDeepStrictEqual } from 'node:util';
import { inspectJsonValue } from '@pertexo/workflow-model/canonical-json';
import { WORKFLOW_OBSERVATION_WINDOW_LIMITS_V1 } from '@pertexo/workflow-model/observation-window';
import { z } from 'zod';
import { nativePhysicalOutputSourceMetadataSchema } from '../node-attempts/native-node-attempt-value-sources.js';
import { nativeCallableValueIdentitySchema } from './coordinator-native-source-inventory.js';
import type { NativeCoordinatorValueOwner } from './coordinator-native-value-read-contract.js';
import { PERSISTED_WORKFLOW_CHECKPOINT_LIMITS } from '../../compatibility/persisted-workflow-checkpoint.js';
import { persistedWorkflowPhysicalOutputReferenceSchemaV3 } from '../../compatibility/persisted-workflow-checkpoint-v3.js';

const identitySchema = z
  .object({
    sequence: z.number().int().min(1).max(2_147_483_647),
    invocationKey: z.string().min(1).max(256),
    nodeId: z.string().min(1).max(128),
    attemptId: z.uuid(),
    output: persistedWorkflowPhysicalOutputReferenceSchemaV3,
    controlKind: z.enum(['for_each', 'branch', 'parallel']),
    branchPath: z
      .array(
        z
          .object({
            nodeId: z.string().min(1).max(128),
            outputPort: z.string().min(1).max(128),
          })
          .strict(),
      )
      .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.scopeParts),
    iterationPath: z
      .array(
        z
          .object({
            loopNodeId: z.string().min(1).max(128),
            ordinal: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.scopeParts),
  })
  .strict();
const sourceSchema = identitySchema
  .extend({
    valueSource: z
      .object({
        slot: z.literal('upstream_output'),
        source: nativePhysicalOutputSourceMetadataSchema,
        valueIdentity: nativeCallableValueIdentitySchema,
      })
      .strict(),
  })
  .strict();

export type NativeCoordinatorControlDeclarationIdentity = Readonly<
  z.output<typeof identitySchema>
>;
export type NativeCoordinatorControlDeclarationSource = Readonly<
  z.output<typeof sourceSchema>
>;

/** Metadata only. Every needed fact is reconciled in deterministic cursor order. */
export function parseCoordinatorControlDeclarationInventory(
  value: unknown,
  owner: NativeCoordinatorValueOwner,
  expected: readonly NativeCoordinatorControlDeclarationIdentity[],
): readonly NativeCoordinatorControlDeclarationSource[] {
  const sources = z
    .array(sourceSchema)
    .max(WORKFLOW_OBSERVATION_WINDOW_LIMITS_V1.facts)
    .parse(value);
  if (
    sources.length !== expected.length ||
    inspectJsonValue(sources).bytes >
      WORKFLOW_OBSERVATION_WINDOW_LIMITS_V1.canonicalWindowBytes
  )
    throw new TypeError('Coordinator control inventory does not agree');
  let sequence = 0;
  const invocations = new Set<string>();
  const attempts = new Set<string>();
  for (const [index, declaration] of sources.entries()) {
    const { valueSource, ...identity } = declaration;
    const physical = valueSource.source;
    const reference = valueSource.valueIdentity.reference;
    if (
      !isDeepStrictEqual(identity, expected[index]) ||
      declaration.sequence <= sequence ||
      invocations.has(declaration.invocationKey) ||
      attempts.has(declaration.attemptId) ||
      physical.workspaceId !== owner.workspaceId ||
      physical.runId !== owner.runId ||
      physical.workflowVersionId !== owner.workflowVersionId ||
      physical.nodeId !== declaration.nodeId ||
      physical.invocationKey !== declaration.invocationKey ||
      physical.attemptId !== declaration.attemptId ||
      (declaration.output.kind === 'inline'
        ? reference.kind !== 'inline' ||
          declaration.output.attemptId !== declaration.attemptId
        : reference.kind !== 'artifact' ||
          declaration.output.artifactId !== reference.artifactId) ||
      (declaration.controlKind === 'parallel' &&
        valueSource.valueIdentity.reference.kind !== 'inline')
    )
      throw new TypeError('Coordinator control declaration identity differs');
    sequence = declaration.sequence;
    invocations.add(declaration.invocationKey);
    attempts.add(declaration.attemptId);
  }
  return sources;
}
