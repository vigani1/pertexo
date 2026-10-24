import {
  createCheckpoint,
  type WorkflowTransitionPlan,
} from '../../../../workflow-engine/dist/index.js';
import { canonicalOutboxPayloadChecksum } from '../../../src/outbox/events.repository.js';
import {
  admin,
  checksum,
  createFamily,
  inline,
  insertHint,
} from '../../lifecycle/calls/fixtures.js';
import { randomUUID } from '../../lifecycle/retention.support.js';

export async function declarationFixture(value: unknown = { declared: true }) {
  const family = await createFamily({
    executableJson: { graph: { nodes: [] } },
  });
  await admin.query('delete from app.workflow_calls where id=$1', [
    family.callId,
  ]);
  const attemptId = randomUUID();
  const nodeRunId = randomUUID();
  const key = `${family.parentVersionId}|call|b:|i:`;
  const previous = {
    ...createCheckpoint({
      workflowVersionId: family.parentVersionId,
      iterationBudget: 200,
      nextEventSequence: 1,
    }),
    runStatus: 'running' as const,
    invocations: [
      {
        nodeId: 'call',
        invocationKey: key,
        status: 'running' as const,
        attemptNumber: 1,
      },
    ],
    admittedInvocationKeys: [key],
  };
  await admin.query('begin');
  try {
    await admin.query(
      "update app.workflow_runs set status='running',deadline_at=clock_timestamp()+interval '1 hour' where id=$1",
      [family.parentRunId],
    );
    await admin.query(
      `insert into app.run_checkpoints(workspace_id,workflow_run_id,workflow_version_id,revision,scheduler_state)
       values($1,$2,$3,0,$4::jsonb)`,
      [
        family.workspaceId,
        family.parentRunId,
        family.parentVersionId,
        JSON.stringify(previous),
      ],
    );
    await admin.query(
      `insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
       status,side_effect_class,current_attempt_id,current_attempt_number,output_ref)
       values($1,$2,$3,'call',$4,'{}','succeeded','safe',$5,1,$6::jsonb)`,
      [
        nodeRunId,
        family.workspaceId,
        family.parentRunId,
        key,
        attemptId,
        inline(value),
      ],
    );
    await admin.query(
      `insert into app.node_attempts(id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref)
       values($1,$2,$3,1,'succeeded','safe',$4::jsonb)`,
      [attemptId, family.workspaceId, nodeRunId, inline(value)],
    );
    await admin.query('commit');
  } catch (error) {
    await admin.query('rollback');
    throw error;
  }
  const occurredAt = new Date().toISOString();
  const checkpoint = {
    ...previous,
    revision: 1,
    runStatus: 'waiting' as const,
    nextEventSequence: 3,
    invocations: [
      {
        ...{
          nodeId: 'call',
          invocationKey: key,
          status: 'running' as const,
          attemptNumber: 1,
        },
        status: 'waiting' as const,
        waitKind: 'workflow_call' as const,
      },
    ],
  };
  const plan: WorkflowTransitionPlan = {
    expectedRevision: 0,
    expectedNextEventSequence: 1,
    consumedThroughEventSequence: 0,
    checkpoint,
    events: [
      {
        sequence: 1,
        name: 'node.waiting',
        occurredAt,
        nodeId: 'call',
        invocationKey: key,
        attemptNumber: 1,
      },
      { sequence: 2, name: 'run.waiting', occurredAt },
    ],
    nodeRunAdmissions: [],
    attempts: [],
    callIntents: [
      {
        invocationKey: key,
        target: {
          workflowId: family.childWorkflowId,
          workflowVersionId: family.childVersionId,
          executableChecksum: checksum,
        },
        input: { kind: 'inline', attemptId },
      },
    ],
  };
  const outboxEventId = await insertHint(
    family.workspaceId,
    family.parentRunId,
  );
  return {
    ...family,
    plan,
    previous,
    nodeRunId,
    attemptId,
    key,
    delivery: {
      outboxEventId,
      payloadChecksum: canonicalOutboxPayloadChecksum({
        workspaceId: family.workspaceId,
        runId: family.parentRunId,
        outboxEventId,
      }),
    },
  };
}
