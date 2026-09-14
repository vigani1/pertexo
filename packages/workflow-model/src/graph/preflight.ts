import { z } from 'zod';

import {
  workflowGraphStructuralSchemaV1,
  type WorkflowGraph,
} from '../graph-contract.js';
import { inspectWorkflowGraphAdmission } from './admission.js';
import { hasBoundedGraphAggregateUnsafe } from './aggregate.js';
import {
  WORKFLOW_GRAPH_LIMITS,
  WorkflowGraphContractError,
} from './validation-contract.js';

const workflowGraphAggregateAdmissionSchema = z
  .unknown()
  .transform((input, context) => {
    if (!hasBoundedGraphAggregateUnsafe(input, WORKFLOW_GRAPH_LIMITS)) {
      context.addIssue({
        code: 'custom',
        message: 'workflow graph exceeds the bounded JSON contract',
      });
      return z.NEVER;
    }
    return input;
  });

export function parseWorkflowGraphDraft(input: unknown): WorkflowGraph {
  const admitted = inspectWorkflowGraphAdmission(input, WORKFLOW_GRAPH_LIMITS);
  if (!admitted.ok)
    throw new WorkflowGraphContractError(
      admitted.code,
      admitted.path,
      admitted.message,
    );
  workflowGraphAggregateAdmissionSchema.parse(admitted.snapshot);
  return workflowGraphStructuralSchemaV1.parse(admitted.snapshot);
}

export type WorkflowGraphDraftParseResult =
  | { readonly success: true; readonly data: WorkflowGraph }
  | {
      readonly success: false;
      readonly error: WorkflowGraphContractError | z.ZodError;
    };

export function safeParseWorkflowGraphDraft(
  input: unknown,
): WorkflowGraphDraftParseResult {
  try {
    return { success: true, data: parseWorkflowGraphDraft(input) };
  } catch (error) {
    try {
      if (
        error instanceof WorkflowGraphContractError ||
        error instanceof z.ZodError
      )
        return { success: false, error };
    } catch {
      // Never inspect a hostile thrown value again at this safe boundary.
    }
    return {
      success: false,
      error: new WorkflowGraphContractError(
        'invalid_json',
        '$',
        'graph parsing failed',
      ),
    };
  }
}
