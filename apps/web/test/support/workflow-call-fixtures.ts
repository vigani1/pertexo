import type {
  WorkflowCallPinV1,
  WorkflowGraphContract,
} from '@pertexo/contracts/schemas/workflow-authoring';

export const workflowCallPin = {
  workflowId: '11111111-1111-4111-8111-111111111111',
  versionId: '22222222-2222-4222-8222-222222222222',
  checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
  callableContractIdentity: `callable:v1:sha256:${'b'.repeat(64)}`,
} satisfies WorkflowCallPinV1;

export function nativeCallGraph(
  config: WorkflowGraphContract['nodes'][number]['config'] = workflowCallPin,
): WorkflowGraphContract {
  return {
    schemaVersion: 2,
    nodes: [
      {
        id: 'call',
        label: 'Call child',
        definition: { key: 'core.workflow_call', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config,
        inputMappings: { name: { kind: 'run_input', path: '$.name' } },
        connectionRefs: {},
      },
    ],
    edges: [],
    settings: {},
  };
}
