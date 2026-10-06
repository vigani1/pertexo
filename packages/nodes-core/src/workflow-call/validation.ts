import { boundedNodeJsonRecordSchema } from '@pertexo/node-sdk';
import {
  workflowCallPinSchemaV1,
  type WorkflowCallPinV1,
} from '@pertexo/workflow-model/workflow-call-contract';

export const CORE_WORKFLOW_CALL_CONFIG_SCHEMA = workflowCallPinSchemaV1;

// Structural bounds only. The pinned callable descriptor owns exact input/result
// validation in the coordinator; this declaration is never the child's result.
export const CORE_WORKFLOW_CALL_INPUT_SCHEMA = boundedNodeJsonRecordSchema;
export const CORE_WORKFLOW_CALL_OUTPUT_SCHEMA = boundedNodeJsonRecordSchema;

export type CoreWorkflowCallConfig = WorkflowCallPinV1;
