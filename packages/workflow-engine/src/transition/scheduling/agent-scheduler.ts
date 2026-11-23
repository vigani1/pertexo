import type { JsonValue } from '@pertexo/workflow-model';
import type { pinAgentTools } from '../../compilation/agent-tools.js';
import {
  executableAgentTools,
  executionNodes,
} from '../../compilation/verified-executable.js';
import type { CompiledWorkflowExecutable } from '../../compilation/workflow-executable.js';
import { isAgentWorkInvocationKey } from '../../invocations/agent-invocation.js';
import { parseCompletedOutputItems } from '../../observation/coordinator-output.js';
import type { AgentModelRates } from '../../control-nodes/agent-continuation.js';
import { isJsonRecord } from '../../input-checks/engine-values.js';
import type { PendingTaskOutcome } from '../../workflow-execution.js';

export type AgentTool = ReturnType<typeof pinAgentTools>[number];
export type AgentScheduler = Readonly<{
  tools: ReadonlyMap<string, readonly AgentTool[]>;
  rates: (model: string) => AgentModelRates | undefined;
  outputs: readonly JsonValue[];
  decisions: ReadonlyMap<string, PendingTaskOutcome['status']>;
}>;
export function agentSchedulerFor({
  executable,
  agentModelRates,
  completedOutputs,
  agentDecisions,
}: Readonly<{
  executable: CompiledWorkflowExecutable;
  agentModelRates?: AgentScheduler['rates'];
  completedOutputs?: unknown;
  agentDecisions: AgentScheduler['decisions'];
}>): AgentScheduler | undefined {
  const tools = new Map(
    executionNodes(executable).flatMap(({ id }) => {
      const tools = executableAgentTools(executable, id);
      return tools.length === 0 ? [] : [[id, tools] as const];
    }),
  );
  return tools.size === 0
    ? undefined
    : {
        tools,
        rates: agentModelRates ?? (() => undefined),
        outputs: parseCompletedOutputItems(completedOutputs),
        decisions: agentDecisions,
      };
}
export function graphStepOutputs(
  items: readonly JsonValue[],
): readonly JsonValue[] {
  return items.filter(
    (item) =>
      !isJsonRecord(item) ||
      typeof item.invocationKey !== 'string' ||
      !isAgentWorkInvocationKey(item.invocationKey),
  );
}
