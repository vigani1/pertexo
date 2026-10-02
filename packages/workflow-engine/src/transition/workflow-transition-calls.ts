import { canonicalJson } from '@pertexo/workflow-model/canonical-json';
import { WorkflowEngineError } from '../errors.js';
import type { WorkflowCallControlDecisionV1 } from '../workflow-call-control.js';
import { assertNodeTransition } from './transitions.js';
import {
  nodeEventName,
  transitionEvent,
  type MutableWorkflowTransition,
} from './workflow-transition-state.js';

/** Apply dedicated controls after source facts, before readiness and run stops. */
export function applyWorkflowCallControls(
  state: MutableWorkflowTransition,
  controls: readonly WorkflowCallControlDecisionV1[],
  occurredAt: string,
): void {
  if (state.current.schemaVersion !== 3) {
    if (controls.length > 0)
      throw new WorkflowEngineError(
        'observation_invalid',
        'Call controls require checkpoint V3',
      );
    return;
  }
  const seen = new Set<string>();
  for (const control of controls) {
    const key = control.call.invocationKey;
    const previous = state.invocations.get(key);
    if (
      seen.has(key) ||
      previous === undefined ||
      control.invocation.invocationKey !== key ||
      control.call.nodeId !== previous.nodeId ||
      control.invocation.nodeId !== previous.nodeId ||
      control.invocation.attemptNumber !== previous.attemptNumber ||
      canonicalJson(control.invocation.branchPath ?? []) !==
        canonicalJson(previous.branchPath ?? []) ||
      canonicalJson(control.invocation.iterationPath ?? []) !==
        canonicalJson(previous.iterationPath ?? [])
    )
      throw new WorkflowEngineError(
        'observation_invalid',
        'Call control does not match its invocation',
      );
    seen.add(key);
    if (control.declarationIntent) {
      if (
        state.calls.has(key) ||
        (control.call.status !== 'awaiting_admission' &&
          control.call.status !== 'aborted') ||
        control.admissionIntent !==
          (control.call.status === 'awaiting_admission')
      )
        throw new WorkflowEngineError(
          'observation_invalid',
          'Call declaration intent is invalid',
        );
      state.workflowCallDeclarations.push(control.call);
    } else if (control.admissionIntent || !state.calls.has(key))
      throw new WorkflowEngineError(
        'observation_invalid',
        'Call control has no retained declaration',
      );
    if (control.cancelChild !== undefined) {
      if (
        control.call.status !== 'admitted' ||
        control.call.childRunId !== control.cancelChild.childRunId ||
        !(state.cancelRequested || state.deadlineExpired)
      )
        throw new WorkflowEngineError(
          'observation_invalid',
          'Call cancellation intent is invalid',
        );
      state.workflowCallCancellations.push(control.cancelChild);
    }
    if (previous.status !== control.invocation.status) {
      assertNodeTransition(previous.status, control.invocation.status);
      const name = nodeEventName[control.invocation.status];
      if (name === undefined)
        throw new WorkflowEngineError(
          'observation_invalid',
          'Call control status is invalid',
        );
      state.eventDrafts.push(
        transitionEvent(
          name,
          occurredAt,
          control.invocation,
          control.reasonCode,
        ),
      );
    }
    state.calls.set(key, control.call);
    state.invocations.set(key, control.invocation);
  }
}
