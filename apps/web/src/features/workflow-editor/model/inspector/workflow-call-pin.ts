import {
  workflowCallPinSchemaV1,
  type WorkflowCallPinV1,
} from '@pertexo/contracts/schemas/workflow-authoring';
import type { FieldParseResult, NodeConfig } from './inspector-draft';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';

export function isWorkflowCallPinNode(
  node: WorkflowGraphContract['nodes'][number],
): boolean {
  return (
    node.definition.key === 'core.workflow_call' &&
    node.definition.version === 1 &&
    node.configVersion === 1
  );
}

export type CallPinText = Readonly<Record<keyof WorkflowCallPinV1, string>>;
export const CALL_PIN_FIELDS = [
  {
    key: 'workflowId',
    label: 'Child workflow ID',
    hint: 'The workflow in this workspace, identified by its UUID.',
    problem: 'Enter a workflow UUID.',
  },
  {
    key: 'versionId',
    label: 'Pinned version ID',
    hint: 'An exact published version UUID, never “latest” or a version number.',
    problem: 'Enter an immutable version UUID.',
  },
  {
    key: 'checksum',
    label: 'Pinned version checksum',
    hint: 'The published native version’s exact wf:v3:sha256 checksum.',
    problem:
      'Enter wf:v3:sha256: followed by 64 lowercase hexadecimal characters.',
  },
  {
    key: 'callableContractIdentity',
    label: 'Callable contract identity',
    hint: 'The exact callable:v1:sha256 identity associated with that version.',
    problem:
      'Enter callable:v1:sha256: followed by 64 lowercase hexadecimal characters.',
  },
] as const;

/** Unknown fields or incompatible formats stay in the lossless JSON editor. */
export function readCallPinText(config: NodeConfig): CallPinText | undefined {
  if (
    Object.keys(config).some(
      (key) => !CALL_PIN_FIELDS.some((field) => field.key === key),
    )
  )
    return undefined;
  if (
    CALL_PIN_FIELDS.some(
      ({ key }) => config[key] !== undefined && typeof config[key] !== 'string',
    )
  )
    return undefined;
  return {
    workflowId: typeof config.workflowId === 'string' ? config.workflowId : '',
    versionId: typeof config.versionId === 'string' ? config.versionId : '',
    checksum: typeof config.checksum === 'string' ? config.checksum : '',
    callableContractIdentity:
      typeof config.callableContractIdentity === 'string'
        ? config.callableContractIdentity
        : '',
  };
}

export function callPinFieldErrors(
  text: CallPinText,
): Readonly<Partial<Record<keyof WorkflowCallPinV1, string>>> {
  const result = workflowCallPinSchemaV1.safeParse(text);
  if (result.success) return {};
  const errors: Partial<Record<keyof WorkflowCallPinV1, string>> = {};
  for (const issue of result.error.issues) {
    const field = CALL_PIN_FIELDS.find(({ key }) => key === issue.path[0]);
    if (field !== undefined) errors[field.key] = field.problem;
  }
  return errors;
}

/** Format admission only; workspace/version/contract agreement belongs to publication. */
export function parseCallPinText(
  text: CallPinText,
): FieldParseResult<NodeConfig> {
  const parsed = workflowCallPinSchemaV1.safeParse(text);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        error:
          'Complete all four exact pin fields. Check the UUIDs and identity formats.',
      };
}
