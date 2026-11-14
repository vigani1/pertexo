import {
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
  WORKFLOW_GRAPH_JSON_VALUE_DEPTH,
} from '../workflow-graph.schemas.js';

export interface WorkflowGraphLimits {
  readonly nodes: number;
  readonly edges: number;
  readonly graphBytes: number;
  readonly maxLoopIterations: number;
  readonly maxLoopConcurrency: number;
  readonly maxTotalLoopIterations: number;
  readonly maxExpandedInvocations: number;
  readonly maxConcurrentInvocations: number;
  readonly structuredDepth: number;
  readonly jsonValueDepth: number;
  readonly inputDepth: number;
}

export const WORKFLOW_GRAPH_LIMITS: WorkflowGraphLimits = Object.freeze({
  ...WORKFLOW_GRAPH_CONTRACT_LIMITS,
  jsonValueDepth: WORKFLOW_GRAPH_JSON_VALUE_DEPTH,
});

export const GRAPH_ISSUE_CODES = [
  'duplicate_node_id',
  'duplicate_edge_id',
  'dangling_edge',
  'cycle',
  'invalid_loop_limit',
  'loop_iteration_limit',
  'invalid_structured_body',
  'invalid_mapping',
  'invalid_failure_route',
  'invalid_expression',
  'expansion_limit',
  'graph_limit',
  'unknown_definition',
  'invalid_step_settings',
  'invalid_graph',
] as const;

export type GraphIssueCode = (typeof GRAPH_ISSUE_CODES)[number];

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
