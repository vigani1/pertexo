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
  let bytes = input === undefined ? 0 : Buffer.byteLength(canonicalJson(input));
  const outputs = new Map<string, JsonValue>();
  for (const { source, definition, invocation } of candidate.prefix) {
    const stored = values.outputs.get(source.id);
    if (stored?.node === undefined)
      return { kind: 'refused', reason: 'values_missing' };
    if (stored.node.kind === 'artifact' || stored.attempt?.kind === 'artifact')
      return { kind: 'refused', reason: 'artifact_value' };
    const json = canonicalJson(stored.node.value);
    if (source.reused !== undefined) {
      if (stored.attempt !== undefined)
        return { kind: 'refused', reason: 'evidence_unavailable' };
    } else {
      if (stored.attempt === undefined)
        return { kind: 'refused', reason: 'values_missing' };
      if (canonicalJson(stored.attempt.value) !== json)
        return { kind: 'refused', reason: 'evidence_unavailable' };
    }
    const value = stored.node.value;
    if (containsArtifact(value))
      return { kind: 'refused', reason: 'artifact_value' };
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
        return { kind: 'refused', reason: 'branch_evidence_unavailable' };
    }
    bytes += Buffer.byteLength(json);
    if (bytes > WORKFLOW_RECOVERY_LIMITS.canonicalBytes)
      return { kind: 'refused', reason: 'reuse_bounds' };
    outputs.set(source.id, value);
  }
  if (bytes > WORKFLOW_RECOVERY_LIMITS.canonicalBytes)
    return { kind: 'refused', reason: 'reuse_bounds' };
  return { ...candidate, kind: 'eligible', input, outputs };
}
