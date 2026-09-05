import { createHash } from 'node:crypto';
import {
  NODE_JSON_LIMITS_V1,
  type DefinitionIdentity,
  type ExecutorIdentity,
  type PolicyReference,
  type RegistryRelease,
} from '@pertexo/node-sdk';
import {
  canonicalJson,
  type JsonValue,
} from '@pertexo/workflow-model/canonical-json';
import type {
  ValueSource,
  WorkflowEdge,
  WorkflowGraph,
} from '@pertexo/workflow-model/graph';
import { WorkflowEngineError } from './errors.js';
import type { SideEffectClass } from './types.js';
export { compareOrdinal } from './ordering.js';

export const BASELINE_RUNTIME_POLICIES_V1 = Object.freeze({
  scheduler: Object.freeze({ key: 'engine.scheduler', version: 1 }),
  checkpoint: Object.freeze({ key: 'engine.checkpoint', version: 1 }),
  retry: Object.freeze({ key: 'engine.retry', version: 1 }),
  timeout: Object.freeze({ key: 'engine.timeout', version: 1 }),
  cancellation: Object.freeze({ key: 'engine.cancellation', version: 1 }),
});
/**
 * @deprecated Use BASELINE_RUNTIME_POLICIES_V1. Retained for source compatibility.
 */
export const PHASE3_RUNTIME_POLICIES_V1 = BASELINE_RUNTIME_POLICIES_V1;
export const WORKFLOW_EXECUTABLE_LIMITS_V2 = Object.freeze({
  bytes: NODE_JSON_LIMITS_V1.bytes,
  depth: NODE_JSON_LIMITS_V1.depth,
  members: NODE_JSON_LIMITS_V1.members,
});

export interface ExecutableRuntimePoliciesV1 {
  readonly scheduler: PolicyReference;
  readonly checkpoint: PolicyReference;
  readonly retry: PolicyReference;
  readonly timeout: PolicyReference;
  readonly cancellation: PolicyReference;
}

export interface WorkflowExecutableNodeV2 {
  readonly id: string;
  readonly definition: DefinitionIdentity;
  readonly configVersion: number;
  readonly config: Readonly<Record<string, JsonValue>>;
  readonly inputMappings: Readonly<Record<string, ValueSource>>;
  readonly connectionRefs: Readonly<Record<string, string>>;
  readonly disabled: boolean;
  readonly sideEffectClass: SideEffectClass;
  readonly executor: ExecutorIdentity;
  readonly executorAbi: number;
  readonly policyReferences: readonly PolicyReference[];
  readonly structured?: WorkflowExecutableForEachV2 | undefined;
}

export interface WorkflowExecutableGraphV2 {
  readonly settings: WorkflowGraph['settings'];
  readonly nodes: readonly WorkflowExecutableNodeV2[];
  readonly edges: readonly WorkflowEdge[];
}

interface WorkflowExecutableStructuredBodyV2 extends WorkflowExecutableGraphV2 {
  readonly inputPorts: readonly string[];
  readonly outputPorts: readonly string[];
}

export interface WorkflowExecutableForEachV2 {
  readonly kind: 'for_each';
  readonly maxIterations: number;
  readonly maxConcurrency: number;
  readonly body: WorkflowExecutableStructuredBodyV2;
}

export interface WorkflowExecutableV2 {
  readonly schemaVersion: 2;
  readonly sourceGraphSchemaVersion: 1;
  readonly graph: WorkflowExecutableGraphV2;
  readonly runtimePolicies: ExecutableRuntimePoliciesV1;
  readonly configMigrations: readonly [];
  readonly compatibilitySelectionFingerprint: string;
  readonly compatibilityReleaseEpoch: number;
  readonly compatibilityReleaseFingerprint: string;
}

declare const verifiedExecutableV2: unique symbol;
export type VerifiedWorkflowExecutableV2 = WorkflowExecutableV2 & {
  readonly [verifiedExecutableV2]: true;
};

export interface CompiledWorkflowExecutableV2 {
  readonly envelope: VerifiedWorkflowExecutableV2;
  readonly checksum: `wf:v2:sha256:${string}`;
}
const authenticExecutableIdentities = new WeakSet<object>();

export function registerExecutableIdentity(
  value: CompiledWorkflowExecutableV2,
): CompiledWorkflowExecutableV2 {
  authenticExecutableIdentities.add(value);
  return value;
}

export function assertAuthenticExecutableIdentity(
  value: CompiledWorkflowExecutableV2,
): void {
  if (!authenticExecutableIdentities.has(value))
    fail('workflow executable identity was not verified in this process');
}

export const token = (
  value: DefinitionIdentity | ExecutorIdentity | PolicyReference,
): string => `${value.key}\u0000${String(value.version)}`;
export const compareIdentity = (
  left: DefinitionIdentity | ExecutorIdentity | PolicyReference,
  right: DefinitionIdentity | ExecutorIdentity | PolicyReference,
): number =>
  left.key < right.key
    ? -1
    : left.key > right.key
      ? 1
      : left.version - right.version;
export const sameIdentity = (
  left: DefinitionIdentity | ExecutorIdentity | PolicyReference,
  right: DefinitionIdentity | ExecutorIdentity | PolicyReference,
): boolean => left.key === right.key && left.version === right.version;
export function fail(message: string): never {
  throw new WorkflowEngineError('executable_invalid', message);
}

export function normalizeError(error: unknown): never {
  if (error instanceof WorkflowEngineError) throw error;
  fail(error instanceof Error ? error.message : 'executable processing failed');
}

export function freezeExecutable<T extends object>(value: T): T {
  const pending: object[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const children = Object.values(current) as unknown[];
    for (const child of children)
      if (child !== null && typeof child === 'object') pending.push(child);
    Object.freeze(current);
  }
  return value;
}

export function digest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson({ domain, value }))
    .digest('hex');
}

export function globalPolicies(
  policies: ExecutableRuntimePoliciesV1,
): readonly PolicyReference[] {
  return [
    policies.scheduler,
    policies.checkpoint,
    policies.retry,
    policies.timeout,
    policies.cancellation,
  ];
}

export function validateGlobals(
  policies: ExecutableRuntimePoliciesV1,
  release: RegistryRelease,
): void {
  const selected = globalPolicies(policies);
  const expected = globalPolicies(BASELINE_RUNTIME_POLICIES_V1);
  if (
    !selected.every((value, index) => {
      const expectedValue = expected[index];
      return expectedValue !== undefined && sameIdentity(value, expectedValue);
    }) ||
    new Set(selected.map(token)).size !== selected.length
  )
    fail('runtime policy selection is not baseline policy v1');
  const available = new Set(release.policies.map(token));
  if (!selected.every((value) => available.has(token(value))))
    fail('compatibility release is missing a runtime policy');
}
