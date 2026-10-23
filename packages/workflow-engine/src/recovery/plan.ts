import { utf8ByteLength } from '@pertexo/workflow-model';
import {
  canonicalJson,
  UUID_PATTERN,
  WORKFLOW_RECOVERY_LIMITS,
  type JsonValue,
} from '@pertexo/workflow-model';
import type {
  RecoveryCandidate,
  RecoveryPlan,
  RecoveryRefused,
  RecoveryValues,
} from './contract.js';

function containsArtifact(value: JsonValue): boolean {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (
      current === undefined ||
      current === null ||
      typeof current !== 'object'
    )
      continue;
    if (Array.isArray(current))
      pending.push(...(current as readonly JsonValue[]));
    else {
      const object = current as Readonly<Record<string, JsonValue>>;
      if (
        object.kind === 'artifact' &&
        typeof object.artifactId === 'string' &&
        UUID_PATTERN.test(object.artifactId)
      )
        return true;
      pending.push(...Object.values(object));
    }
  }
  return false;
}

/** Required values are loaded only after metadata selected this candidate. */
export function planRecovery(
  candidate: RecoveryCandidate,
  values: RecoveryValues,
): RecoveryPlan | RecoveryRefused {
  if (values.input.kind === 'expired')
    return { kind: 'refused', reason: 'values_expired' };
  if (values.input.kind === 'artifact')
    return { kind: 'refused', reason: 'artifact_value' };
  if (values.outputs.size !== candidate.prefix.length)
    return { kind: 'refused', reason: 'values_missing' };
  const input = values.input.kind === 'inline' ? values.input.value : undefined;
  if (input !== undefined && containsArtifact(input))
    return { kind: 'refused', reason: 'artifact_value' };
  let bytes = input === undefined ? 0 : utf8ByteLength(canonicalJson(input));
  const outputs = new Map<string, JsonValue>();
  for (const { source, definition, invocation } of candidate.prefix) {
    const stored = values.outputs.get(source.id);
    if (stored?.node === undefined)
      return { kind: 'refused', reason: 'values_missing' };
    if (stored.node.kind === 'artifact' || stored.attempt?.kind === 'artifact')
      return { kind: 'refused', reason: 'artifact_value' };
    const json = canonicalJson(stored.node.value);
    const attemptFailure = verifyStoredAttempt(source, stored.attempt, json);
    if (attemptFailure !== undefined) return attemptFailure;
    const value = stored.node.value;
    if (containsArtifact(value))
      return { kind: 'refused', reason: 'artifact_value' };
    if (!matchesBranchSelection({ definition, invocation, value, candidate }))
      return { kind: 'refused', reason: 'branch_evidence_unavailable' };
    bytes += utf8ByteLength(json);
    if (bytes > WORKFLOW_RECOVERY_LIMITS.canonicalBytes)
      return { kind: 'refused', reason: 'reuse_bounds' };
    outputs.set(source.id, value);
  }
  if (bytes > WORKFLOW_RECOVERY_LIMITS.canonicalBytes)
    return { kind: 'refused', reason: 'reuse_bounds' };
  return { ...candidate, kind: 'eligible', input, outputs };
}

function matchesBranchSelection({
  definition,
  invocation,
  value,
  candidate,
}: Readonly<{
  definition: RecoveryCandidate['prefix'][number]['definition'];
  invocation: RecoveryCandidate['prefix'][number]['invocation'];
  value: JsonValue;
  candidate: RecoveryCandidate;
}>): boolean {
  if (definition.definition.key === 'core.condition') {
    const selection = candidate.branchSelections.find(
      (choice) => choice.invocationKey === invocation.invocationKey,
    );
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (value as Readonly<Record<string, JsonValue>>).selectedPort !==
        selection?.selectedOutputPort
    )
      return false;
  }
  return true;
}

function verifyStoredAttempt(
  source: RecoveryCandidate['prefix'][number]['source'],
  attempt: Readonly<{ kind: 'inline'; value: JsonValue }> | undefined,
  json: string,
): RecoveryRefused | undefined {
  if (source.reused !== undefined) {
    if (attempt !== undefined)
      return { kind: 'refused', reason: 'evidence_unavailable' };
  } else {
    if (attempt === undefined)
      return { kind: 'refused', reason: 'values_missing' };
    if (canonicalJson(attempt.value) !== json)
      return { kind: 'refused', reason: 'evidence_unavailable' };
  }
  return undefined;
}
