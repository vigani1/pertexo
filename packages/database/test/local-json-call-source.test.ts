import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseInitialWorkflowCheckpointV3 } from '../src/compatibility/persisted-workflow-checkpoint-v3.js';

const candidate = readFileSync(
  new URL(
    '../src/execution/workflow-calls/0137-native-execution-values.candidate.sql',
    import.meta.url,
  ),
  'utf8',
);
describe('local JSON Call SQL regressions', () => {
  it('binds the real initial V3 iteration budget without removing the installation abort', () => {
    const identity = {
      engineVersion: 'phase3-engine-v1',
      workflowVersionId: '11111111-1111-4111-8111-111111111111',
    };
    const checkpoint = parseInitialWorkflowCheckpointV3(
      {
        ...identity,
        schemaVersion: 3,
        revision: 0,
        runStatus: 'queued',
        nextEventSequence: 2,
        readySet: [],
        admittedInvocationKeys: [],
        invocations: [],
        joins: [],
        loops: [],
        branchSelections: [],
        calls: [],
        initialIterationBudget: 1000,
        remainingIterationBudget: 1000,
        cancelRequested: false,
        deadlineExpired: false,
      },
      identity,
    );
    expect(checkpoint.initialIterationBudget).toBe(
      checkpoint.remainingIterationBudget,
    );
    expect(candidate).toContain(
      "v_checkpoint.scheduler_state->'initialIterationBudget'=v_checkpoint.scheduler_state->'remainingIterationBudget'",
    );
    expect(candidate).toContain(
      "'calls','initialIterationBudget','remainingIterationBudget'",
    );
    expect(candidate).toContain(
      "RAISE EXCEPTION 'Unregistered F08 0137 review candidate: installation is not authorized'",
    );
  });
  it('admits Call waiting only as a no-timer barrier and retains exact physical-source ownership', () => {
    expect(candidate).toContain(
      "control_kind IN ('for_each_barrier','workflow_call')",
    );
    expect(candidate).toContain(
      'AND wait_kind IS NULL AND resume_at IS NULL AND retry_due_at IS NULL',
    );
    expect(candidate).toContain(
      "attempt.attempt_number=(v_invocation->>'attemptNumber')::integer",
    );
    expect(candidate).toContain(
      "entry#>>'{definition,key}'='core.workflow_call'",
    );
    expect(candidate).toContain(
      'source.original_reference::text=attempt.output_ref::text AND source.original_reference::text=node.output_ref::text',
    );
    expect(candidate).toContain(
      'CREATE CONSTRAINT TRIGGER native_node_logical_projection_owned',
    );
  });
});
