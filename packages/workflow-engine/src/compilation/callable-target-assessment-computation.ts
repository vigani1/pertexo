import { parseRegistryRelease } from '@pertexo/node-sdk';
import { AuthoringValidationUnavailableError } from '@pertexo/workflow-model/authoring-validation';
import { workflowCallableContractIdentityV1 } from '@pertexo/workflow-model/workflow-call-closure';
import { WorkflowEngineError } from '../errors.js';
import {
  CALLABLE_TARGET_ASSESSMENT_LIMITS,
  parseCallableTargetAssessmentSnapshot,
  type CallableTargetAssessmentFact,
  type CallableTargetAssessmentReport,
} from './callable-target-assessment-contracts.js';
import {
  buildWorkflowExecutableV3,
  verifyWorkflowExecutableV3,
  WORKFLOW_CALL_RUNTIME_POLICIES_V1,
} from './executable-v3.js';

/** Worker only: bounded admission precedes all owner parsers and compiler work. */
export function computeCallableTargetAssessment(
  input: unknown,
): CallableTargetAssessmentReport {
  let phase:
    | 'stored_data_invalid'
    | 'immutable_identity_mismatch'
    | 'unexpected_verification_failure' = 'stored_data_invalid';
  try {
    const snapshot = parseCallableTargetAssessmentSnapshot(input);
    let members = 0;
    let nodeVisits = 0;
    function admit(value: unknown): void {
      const pending = [{ value, depth: 0 }];
      while (pending.length > 0) {
        const next = pending.pop();
        if (next === undefined) break;
        if (next.depth > 64)
          throw new AuthoringValidationUnavailableError('payload_limit');
        if (next.value !== null && typeof next.value === 'object') {
          for (const child of Object.values(next.value)) {
            members += 1;
            if (members > CALLABLE_TARGET_ASSESSMENT_LIMITS.members)
              throw new AuthoringValidationUnavailableError('payload_limit');
            pending.push({ value: child, depth: next.depth + 1 });
          }
        }
      }
    }
    function json(text: string): unknown {
      const value: unknown = JSON.parse(text);
      admit(value);
      return value;
    }
    function nodeCount(value: unknown): number {
      if (value === null || typeof value !== 'object') return 0;
      const graph = value as Record<string, unknown>;
      if (!Array.isArray(graph.nodes)) return 0;
      let count = graph.nodes.length;
      for (const node of graph.nodes) {
        if (node !== null && typeof node === 'object') {
          const structured: unknown = (node as Record<string, unknown>)
            .structured;
          if (structured !== null && typeof structured === 'object')
            count += nodeCount((structured as Record<string, unknown>).body);
        }
      }
      return count;
    }
    // Include the framing/descriptions as well as their decoded JSON; copies do
    // not replenish admission. Each build includes its internal verification.
    admit(snapshot);
    const current = parseRegistryRelease(
      json(snapshot.currentRelease.releaseJson),
    );
    if (
      current.epoch !== snapshot.currentRelease.epoch ||
      current.fingerprint !== snapshot.currentRelease.fingerprint
    )
      return {
        status: 'operational_failure',
        reason: 'immutable_identity_mismatch',
      };
    const prepared = snapshot.entries.map((entry) => {
      const source = json(entry.sourceJson);
      const envelope = json(entry.executableJson);
      const admission = parseRegistryRelease(
        json(entry.admissionRelease.releaseJson),
      );
      if (
        admission.epoch !== entry.admissionRelease.epoch ||
        admission.fingerprint !== entry.admissionRelease.fingerprint
      )
        throw new WorkflowEngineError(
          'executable_invalid',
          'Callable target release identity changed.',
        );
      const executableGraph: unknown =
        envelope !== null && typeof envelope === 'object'
          ? (envelope as Record<string, unknown>).graph
          : undefined;
      nodeVisits += 2 * nodeCount(source) + nodeCount(executableGraph);
      if (nodeVisits > CALLABLE_TARGET_ASSESSMENT_LIMITS.nodeVisits)
        throw new AuthoringValidationUnavailableError('payload_limit');
      return { entry, source, envelope, admission };
    });
    const currentPolicies = new Set(
      current.policies.map(({ key, version }) => `${key}:${String(version)}`),
    );
    const currentHasNativePolicies = Object.values(
      WORKFLOW_CALL_RUNTIME_POLICIES_V1,
    ).every(({ key, version }) =>
      currentPolicies.has(`${key}:${String(version)}`),
    );
    const needsCallableExpression = prepared.some(({ source }) => {
      if (source === null || typeof source !== 'object') return false;
      const callable: unknown = (source as Record<string, unknown>).callable;
      if (callable === null || typeof callable !== 'object') return false;
      const selector: unknown = (callable as Record<string, unknown>)
        .resultSelector;
      return (
        selector !== null &&
        typeof selector === 'object' &&
        (selector as Record<string, unknown>).kind === 'expression'
      );
    });
    const currentSupportAvailable =
      currentHasNativePolicies &&
      (!needsCallableExpression || currentPolicies.has('jsonata.restricted:1'));
    const entries: CallableTargetAssessmentFact[] = [];
    for (const { entry, source, envelope, admission } of prepared) {
      phase = 'stored_data_invalid';
      const rebuilt = buildWorkflowExecutableV3({
        graph: source,
        release: admission,
      });
      phase = 'immutable_identity_mismatch';
      if (rebuilt.checksum !== entry.checksum)
        return { status: 'operational_failure', reason: phase };
      phase = 'unexpected_verification_failure';
      const verified = verifyWorkflowExecutableV3({
        envelope,
        checksum: entry.checksum,
        admissionRelease: admission,
        currentRelease: currentSupportAvailable ? current : admission,
        execution: { alreadyAdmitted: false },
      });
      const callable = verified.envelope.graph.callable;
      const identity =
        callable === undefined
          ? null
          : workflowCallableContractIdentityV1(callable);
      if (identity !== entry.callableContractIdentity)
        return {
          status: 'operational_failure',
          reason: 'immutable_identity_mismatch',
        };
      entries.push({
        workflowId: entry.workflowId,
        versionId: entry.versionId,
        checksum: verified.checksum,
        pin:
          identity === null
            ? null
            : {
                workflowId: entry.workflowId,
                versionId: entry.versionId,
                checksum: verified.checksum,
                callableContractIdentity: identity,
              },
        contract:
          callable === undefined
            ? null
            : { input: callable.input, result: callable.result },
      });
    }
    // Lack of current artifact policy support cannot turn retained corruption
    // into a normal refusal: immutable admission verification above still ran.
    if (!currentSupportAvailable)
      return {
        status: 'unavailable',
        reason: 'compatibility_support_unavailable',
      };
    return {
      status: 'verified',
      workspaceId: snapshot.workspaceId,
      entries,
      counters: {
        uniqueVersions: entries.length,
        sourceBytes: snapshot.entries.reduce(
          (sum, row) => sum + Buffer.byteLength(row.sourceJson),
          0,
        ),
        executableBytes: snapshot.entries.reduce(
          (sum, row) => sum + Buffer.byteLength(row.executableJson),
          0,
        ),
        envelopeBytes: Buffer.byteLength(JSON.stringify(snapshot)),
        members,
        nodeVisits,
      },
    };
  } catch (error: unknown) {
    if (error instanceof AuthoringValidationUnavailableError) throw error;
    // No arbitrary exception text, original object, source or stack crosses the
    // worker boundary. This closed fact is still an operational failure.
    return { status: 'operational_failure', reason: phase };
  }
}
