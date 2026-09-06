import { WORKFLOW_GRAPH_CONTRACT_LIMITS } from '../graph-contract.js';

export interface WorkflowGraphLimits {
  readonly nodes: number;
  readonly edges: number;
  readonly graphBytes: number;
  readonly maxLoopIterations: number;
  readonly maxLoopConcurrency: number;
  readonly maxTotalLoopIterations: number;
  readonly maxExpandedInvocations: number;
  readonly structuredDepth: number;
  readonly jsonValueDepth: number;
  readonly inputDepth: number;
}

export const WORKFLOW_GRAPH_LIMITS: WorkflowGraphLimits = Object.freeze({
  ...WORKFLOW_GRAPH_CONTRACT_LIMITS,
  maxTotalLoopIterations: 1_000,
  maxExpandedInvocations: 1_000,
  structuredDepth: 32,
  jsonValueDepth: 64,
});

export type GraphIssueCode =
  | 'duplicate_node_id'
  | 'duplicate_edge_id'
  | 'dangling_edge'
  | 'cycle'
  | 'invalid_loop_limit'
  | 'loop_iteration_limit'
  | 'invalid_structured_body'
  | 'invalid_mapping'
  | 'expansion_limit'
  | 'graph_limit'
  | 'unknown_definition'
  | 'invalid_graph';

export interface GraphValidationIssue {
  readonly code: GraphIssueCode;
  readonly path: string;
  readonly message: string;
}

export type GraphValidationResult =
  | {
      readonly ok: true;
      readonly issues: readonly [];
      readonly expandedInvocations: number;
      readonly worstCaseLoopIterations: number;
    }
  | {
      readonly ok: false;
      readonly issues: readonly GraphValidationIssue[];
      readonly expandedInvocations: number;
      readonly worstCaseLoopIterations: number;
    };

export class InvalidWorkflowGraphError extends TypeError {
  public constructor(readonly issues: readonly GraphValidationIssue[]) {
    super('workflow graph failed semantic validation');
    this.name = 'InvalidWorkflowGraphError';
  }
}

export type WorkflowGraphContractIssueCode =
  'structured_depth' | 'json_value_depth' | 'invalid_json' | 'graph_limit';

export class WorkflowGraphContractError extends TypeError {
  public constructor(
    readonly code: WorkflowGraphContractIssueCode,
    readonly path: string,
    message: string,
  ) {
    super(`${message} at ${path}`);
    this.name = 'WorkflowGraphContractError';
  }
}
