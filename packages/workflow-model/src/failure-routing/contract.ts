/** Engine-owned alternative path, never a provider's successful output. */
export const WORKFLOW_FAILURE_PORT = '__failure';

export const WORKFLOW_FAILURE_FIELDS = [
  'nodeId',
  'invocationKey',
  'attemptNumber',
  'errorKind',
  'safeErrorCode',
] as const;
export const WORKFLOW_FAILURE_PATHS: readonly string[] = [
  '$',
  ...WORKFLOW_FAILURE_FIELDS.map((field) => `$.${field}`),
];

const excludedSources = new Set([
  'core.workflow_error',
  'core.manual',
  'core.form',
  'core.webhook',
  'core.schedule',
  'core.condition',
  'core.switch',
  'core.parallel',
  'core.merge',
  'core.foreach',
  'core.wait',
  'core.call',
  'core.terminate',
]);
export function isWorkflowFailureSource(
  definition: Readonly<{ key: string; version: number }>,
): boolean {
  return !excludedSources.has(definition.key);
}

export type WorkflowFailureRoute = Readonly<{
  sourceNodeId: string;
  entryNodeId: string;
  sinkNodeId: string;
  handlerNodeIds: readonly string[];
}>;
