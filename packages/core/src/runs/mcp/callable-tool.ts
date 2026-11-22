import type { CallableType } from '@pertexo/workflow-model';
import {
  CORE_WEBHOOK_CONFIG_SCHEMA,
  isWorkflowTriggerKey,
  utf8ByteLength,
} from '@pertexo/workflow-model';
import type { PublishedWorkflow } from '../queries/execution/workflow-execution.types.js';
import {
  verifyPersistedWorkflowProjection,
  type PersistedWorkflowProjectionVerificationOptions,
} from '../queries/execution/verify-projection.js';

const MCP_INPUT_SCHEMA_MAX_BYTES = 64 * 1024;

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
  const inputSchema = jsonSchema(input);
  if (utf8ByteLength(JSON.stringify(inputSchema)) > MCP_INPUT_SCHEMA_MAX_BYTES)
    return undefined;
  return { entryId: entry.id, inputSchema };
}

function jsonSchema(type: CallableType): Record<string, unknown> {
  switch (type.type) {
    case 'object':
      return {
        type: 'object',
        properties: Object.fromEntries(
          type.properties.map(({ name, valueType }) => [
            name,
            jsonSchema(valueType),
          ]),
        ),
        required: type.properties
          .filter(({ required }) => required)
          .map(({ name }) => name),
        additionalProperties: false,
      };
    case 'array':
      return {
        type: 'array',
        maxItems: type.maxItems,
        items: jsonSchema(type.items),
      };
    case 'null':
    case 'boolean':
    case 'number':
    case 'string':
      return { type: type.type };
  }
}
