import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  parseCompatibilityReleaseExpectationSet,
  type CompatibilityReleaseExpectationSet,
} from '../../compatibility/compatibility-release.js';

const identity = z
  .object({ key: z.string(), version: z.number().int().positive() })
  .strict();
const catalogSchema = z
  .object({
    domain: z.literal('pertexo.node-compatibility-release'),
    schemaVersion: z.literal(1),
    policies: z.array(identity),
    definitions: z.array(
      z
        .object({
          definition: identity,
          executor: identity,
          executorAbi: z.number().nullable(),
          lifecycle: z.string(),
          policyReferences: z.array(identity),
        })
        .loose(),
    ),
    executors: z.array(
      z
        .object({
          executor: identity,
          abiVersion: z.number(),
          lifecycle: z.string(),
          definitions: z.array(identity),
          policyReferences: z.array(identity),
        })
        .strict(),
    ),
  })
  .strict();

const nativePolicies = [
  ['engine.scheduler', 2],
  ['engine.checkpoint', 2],
  ['engine.retry', 1],
  ['engine.timeout', 2],
  ['engine.cancellation', 2],
  ['workflow.call', 1],
] as const;
const call = (value: z.infer<typeof identity>) =>
  value.key === 'core.workflow_call' && value.version === 1;
const callPolicy = (value: z.infer<typeof identity>) =>
  value.key === 'workflow.call' && value.version === 1;

/**
 * Release-derived read capability, not activation or dispatch authority.
 * Staging needs the exact V3 reader for preactivation; registry lifecycle and
 * ordinary serving release selection still prohibit staged Call execution.
 */
export type CoordinatorExecutableCapability = Readonly<{
  nativeReleases: CompatibilityReleaseExpectationSet;
}>;

export function parseCoordinatorExecutableCapability(
  input: CompatibilityReleaseExpectationSet | undefined,
): CoordinatorExecutableCapability {
  const nativeReleases =
    input === undefined
      ? []
      : parseCompatibilityReleaseExpectationSet(input).filter((release) => {
          if (
            release.fingerprint !==
            `node-compat:v1:sha256:${createHash('sha256').update(release.catalogJson).digest('hex')}`
          )
            throw new TypeError(
              'Coordinator release fingerprint differs from its catalog',
            );
          const catalog = catalogSchema.parse(
            JSON.parse(release.catalogJson) as unknown,
          );
          const nativeIntent =
            catalog.policies.some(
              ({ key, version }) => key === 'engine.scheduler' && version === 2,
            ) || catalog.definitions.some(({ definition }) => call(definition));
          if (!nativeIntent) return false;
          if (
            !nativePolicies.every(([key, version]) =>
              catalog.policies.some(
                (policy) => policy.key === key && policy.version === version,
              ),
            ) ||
            !catalog.definitions.some(
              (definition) =>
                call(definition.definition) &&
                call(definition.executor) &&
                definition.executorAbi === 1 &&
                ['staged', 'active', 'retained'].includes(
                  definition.lifecycle,
                ) &&
                definition.policyReferences.some(callPolicy),
            ) ||
            !catalog.executors.some(
              (executor) =>
                call(executor.executor) &&
                executor.abiVersion === 1 &&
                ['staged', 'active', 'retained'].includes(executor.lifecycle) &&
                executor.definitions.some(call) &&
                executor.policyReferences.some(callPolicy),
            )
          )
            throw new TypeError(
              'Coordinator native release lacks actual engine policies or Call executor',
            );
          return true;
        });
  return Object.freeze({ nativeReleases: Object.freeze(nativeReleases) });
}

export function assertNativeCoordinatorPoolAdmission(
  acquisitionTimeoutMillis: number | undefined,
  controlReadTimeoutMillis: number,
): void {
  if (
    acquisitionTimeoutMillis === undefined ||
    !Number.isSafeInteger(acquisitionTimeoutMillis) ||
    acquisitionTimeoutMillis <= 0 ||
    acquisitionTimeoutMillis > controlReadTimeoutMillis
  )
    throw new RangeError(
      'Actual shared pool acquisition bound is incompatible with native coordinator capability',
    );
}
