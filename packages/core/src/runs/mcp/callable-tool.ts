import {
  CORE_WEBHOOK_CONFIG_SCHEMA,
  isWorkflowTriggerKey,
  callableObjectInputSchema,
} from '@pertexo/workflow-model';
import type { PublishedWorkflow } from '../queries/execution/workflow-execution.types.js';
import {
  verifyPersistedWorkflowProjection,
  type PersistedWorkflowProjectionVerificationOptions,
} from '../queries/execution/verify-projection.js';

/** Publication already proves that a callable has one supported, enabled entry. */
export function callableTool(
  version: PublishedWorkflow,
  options: PersistedWorkflowProjectionVerificationOptions,
) {
  const { graph } = verifyPersistedWorkflowProjection(
    version,
    options,
  ).envelope;
  const entry = graph.nodes.find(({ definition }) =>
    isWorkflowTriggerKey(definition.key),
  );
  const input = graph.callable?.input;
  if (entry === undefined || input?.type !== 'object') return undefined;
  if (entry.definition.key === 'core.webhook') {
    const config = CORE_WEBHOOK_CONFIG_SCHEMA.parse(entry.config);
    if (config.runInput === 'request' || config.responseMode === 'workflow')
      return undefined;
  }
  const inputSchema = callableObjectInputSchema(input);
  if (inputSchema === undefined) return undefined;
  return { entryId: entry.id, inputSchema };
}
