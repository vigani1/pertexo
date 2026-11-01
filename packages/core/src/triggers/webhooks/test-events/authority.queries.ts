import { CORE_WEBHOOK_CONFIG_SCHEMA } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import { rolesForCapability } from '@pertexo/workflow-model';
import { lockWorkflowAuthoringAuthority } from '../../../authoring/workflows/authority.js';
import { sampleDraft } from '../../../authoring/step-samples/records.repository.js';
import { WebhookTestEventError } from './errors.js';
import type { TestEventScope } from './contract.js';

/**
 * For the ingress side, where the sender isn't a member: the listener only works
 * while the person who started it could still edit the workflow.
 */
export async function testEventDraftForCreator(
  client: PoolClient,
  input: TestEventScope,
) {
  await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
    actorId: input.actorId,
    roles: rolesForCapability('workflow:update'),
    resource: { workflowId: input.workflowId, capability: 'workflow:update' },
  });
  return readTestEventDraft(client, input);
}

/** The caller has already checked authority. */
export async function readTestEventDraft(
  client: PoolClient,
  input: TestEventScope,
) {
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
