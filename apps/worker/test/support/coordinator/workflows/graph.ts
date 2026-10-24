import type { WorkflowNode } from '@pertexo/workflow-model';
export const node = (
  id: string,
  key: string,
  inputMappings: WorkflowNode['inputMappings'] = {},
  config: WorkflowNode['config'] = {},
): WorkflowNode => ({
  id,
  definition: { key, version: 1 },
  configVersion: 1,
  config,
  inputMappings,
  connectionRefs: {},
  position: { x: 0, y: 0 },
});
export const literal = (value: unknown) => ({
  kind: 'literal' as const,
  value: value as WorkflowNode['config'][string],
});
