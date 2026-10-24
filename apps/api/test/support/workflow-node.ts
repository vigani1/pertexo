import type { WorkflowNode } from '@pertexo/workflow-model';
export function workflowNode(id: string, key: string, overrides: Partial<Omit<WorkflowNode, 'id' | 'definition'>> = {}): WorkflowNode { return {id, definition: { key, version: 1 }, position: {x: 0, y: 0}, configVersion: 1, config: {}, inputMappings: {}, connectionRefs: {}, ...overrides}; }
