import type { WorkflowCheckpoint } from '@pertexo/workflow-engine';
import type { AgentAttemptInput } from '@pertexo/workflow-engine/server';
import type { JsonValue } from '@pertexo/workflow-model';
import type {
  LoadInputsInput,
  NodeAttemptRunStore,
} from '../attempts/node-attempt.js';
import { NodeAttemptStateCorruptError } from '../attempts/node-attempt.errors.js';

export async function loadAgentAttemptInput(
  store: Pick<NodeAttemptRunStore, 'readAttemptOutputs'>,
  {
    request,
    checkpoint,
    runDeadlineAt,
  }: Readonly<{
    request: LoadInputsInput;
    checkpoint: WorkflowCheckpoint;
    runDeadlineAt: Date | undefined;
  }>,
): Promise<Readonly<{ agent?: AgentAttemptInput; deadlineAt?: Date }>> {
  const invocation = checkpoint.invocations.find(
    ({ invocationKey }) => invocationKey === request.lease.invocationKey,
  );
  if (invocation?.agentWork === undefined) return {};
  const identity = invocation.agentWork;
  const agent = checkpoint.agents?.find(
    ({ parentInvocationKey }) =>
      parentInvocationKey === identity.parentInvocationKey,
  );
  if (
    agent?.turn !== identity.turn ||
    invocation.status !== 'running' ||
    invocation.attemptNumber !== request.lease.attemptNumber
  )
    throw new NodeAttemptStateCorruptError();
  const work = identity.work;
  const proposal =
    work.kind === 'tool_call' &&
    agent.phase.kind === 'running_tool' &&
    work.ordinal === agent.phase.ordinal
      ? agent.phase.proposal
      : undefined;
  if (
    work.kind === 'tool_call'
      ? proposal === undefined
      : agent.phase.kind !== 'model_turn'
  )
    throw new NodeAttemptStateCorruptError();
  const history = work.kind === 'model_turn' ? (agent.history ?? []) : [];
  const attemptIds = [
    ...history.flatMap((entry) => [
      entry.proposal.attemptId,
      entry.output.attemptId,
    ]),
    ...(proposal === undefined ? [] : [proposal.attemptId]),
  ];
  const values = new Map(
    (
      await store.readAttemptOutputs({
        lease: request.lease,
        attemptIds,
        signal: request.signal,
      })
    ).map(({ attemptId, output }) => [attemptId, output]),
  );
  if (values.size !== attemptIds.length)
    throw new NodeAttemptStateCorruptError();
  const input: AgentAttemptInput = {
    identity,
    history: history.map(({ proposal: saved, output }) => {
      const result = values.get(output.attemptId);
      if (result === undefined) throw new NodeAttemptStateCorruptError();
      // The run-data codec has already validated the stored JSON value.
      return {
        proposal: values.get(saved.attemptId),
        result: result as JsonValue,
      };
    }),
    ...(proposal === undefined
      ? {}
      : { proposal: values.get(proposal.attemptId) }),
  };
  return {
    agent: input,
    deadlineAt: new Date(
      Math.min(
        Date.parse(agent.deadlineAt),
        runDeadlineAt?.getTime() ?? Infinity,
      ),
    ),
  };
}
