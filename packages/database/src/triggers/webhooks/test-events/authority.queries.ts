import { CORE_WEBHOOK_CONFIG_SCHEMA } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import { rolesForCapability } from '@pertexo/workflow-model';
import { lockWorkflowAuthoringAuthority } from '../../../authoring/workflows/authority.js';
import { sampleDraft } from '../../../authoring/step-samples/records.js';
import { WebhookTestEventError } from './errors.js';
import type { TestEventScope } from './contract.js';

export async function testEventDraft(
  client: PoolClient,
  input: TestEventScope,
) {
  await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
    actorId: input.actorId,
    roles: rolesForCapability('workflow:update'),
    resource: { workflowId: input.workflowId, capability: 'workflow:update' },
  });
  const draft = await sampleDraft(client, input, { write: true });
  const node = draft.graph.nodes.find((node) => node.id === input.nodeId);
  if (node?.definition.key !== 'core.webhook' || node.definition.version !== 1)
    throw new WebhookTestEventError('unavailable');
  const binding = draft.bindings.get(input.nodeId);
  if (binding === undefined) throw new WebhookTestEventError('unavailable');
  return {
    revision: draft.revision,
    binding,
    config: CORE_WEBHOOK_CONFIG_SCHEMA.parse(node.config),
  };
}
