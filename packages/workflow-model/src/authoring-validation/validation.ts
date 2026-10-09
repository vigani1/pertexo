import {
  WORKFLOW_VALIDATION_MAX_ISSUES,
  type WorkflowGraph,
} from '../graph/contract.js';
import { validateWorkflowGraph } from '../graph/validation.js';
import type {
  GraphValidationIssue,
  GraphValidationResult,
} from '../graph/validation-contract.js';
import {
  validateExpression,
  EXPRESSION_POLICY,
  type ExpressionValidation,
} from '../expressions/policy.js';
import {
  AUTHORING_VALIDATION_BUDGET,
  AuthoringValidationUnavailableError,
  type WorkflowExpressionPolicyProjection,
} from './contracts.js';

function safeExpressionMessage(result: ExpressionValidation): string {
  if (result.kind === 'valid') return '';
  if (result.code === 'disallowed_construct')
    return 'This expression uses a construct unavailable in the pinned policy.';
  if (result.code === 'limit_exceeded') {
    if (result.limit === 'expression_bytes')
      return 'This expression exceeds the 16 KiB source limit.';
    if (result.limit === 'ast_depth')
      return 'This expression exceeds the parsed depth limit of 64.';
    if (result.limit === 'ast_nodes')
      return 'This expression exceeds the parsed node limit of 2,048.';
  }
  return 'This expression is not valid restricted JSONata.';
}

export function assertReportBudget(report: GraphValidationResult): void {
  if (
    Buffer.byteLength(JSON.stringify(report)) >
      AUTHORING_VALIDATION_BUDGET.reportBytes ||
    report.issues.some(
      ({ message }) =>
        Buffer.byteLength(message) > AUTHORING_VALIDATION_BUDGET.messageBytes,
    )
  )
    throw new AuthoringValidationUnavailableError('report_limit');
}

/** Worker-local pure admission; no evaluation, host bindings, or persistent cache. */
export function validateAuthoringBatch(
  graph: WorkflowGraph,
  policies: WorkflowExpressionPolicyProjection,
): GraphValidationResult {
  let issueBytes = 0;
  const admitIssue = (issue: GraphValidationIssue): void => {
    if (
      Buffer.byteLength(issue.message) >
        AUTHORING_VALIDATION_BUDGET.messageBytes ||
      Buffer.byteLength(issue.path) + Buffer.byteLength(issue.message) >
        AUTHORING_VALIDATION_BUDGET.reportBytes
    )
      throw new AuthoringValidationUnavailableError('report_limit');
    issueBytes += Buffer.byteLength(JSON.stringify(issue));
    if (issueBytes > AUTHORING_VALIDATION_BUDGET.reportBytes)
      throw new AuthoringValidationUnavailableError('report_limit');
  };
  const structural = validateWorkflowGraph(graph, {}, admitIssue);
  if (!structural.ok) {
    assertReportBudget(structural);
    return structural;
  }
  const policyVersions = new Map(
    policies.definitions.map(({ definition, policyReferences }) => [
      `${definition.key}\u0000${String(definition.version)}`,
      new Set(
        policyReferences
          .filter(({ key }) => key === 'jsonata.restricted')
          .map(({ version }) => version),
      ),
    ]),
  );
  const cache = new Map<number, Map<string, ExpressionValidation>>();
  const issues: GraphValidationIssue[] = [];
  const pending: { graph: WorkflowGraph; path: string }[] = [
    { graph, path: '$' },
  ];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) continue;
    for (const node of entry.graph.nodes) {
      const nodePath = `${entry.path}.nodes.${node.id}`;
      if (node.structured !== undefined)
        pending.push({
          graph: node.structured.body,
          path: `${nodePath}.structured.body`,
        });
      const pins = policyVersions.get(
        `${node.definition.key}\u0000${String(node.definition.version)}`,
      );
      for (const [key, source] of Object.entries(node.inputMappings)) {
        if (source.kind !== 'expression') continue;
        let message: string;
        if (
          pins?.has(source.policyVersion) !== true ||
          source.policyVersion !== EXPRESSION_POLICY.policyVersion
        ) {
          message =
            'The expression policy is not available for this step definition.';
        } else {
          let sources = cache.get(source.policyVersion);
          if (sources === undefined) {
            sources = new Map();
            cache.set(source.policyVersion, sources);
          }
          let validation = sources.get(source.expression);
          if (validation === undefined) {
            validation = validateExpression(
              source.expression,
              source.policyVersion,
            );
            // Retain only safe policy facts; parser messages can echo private source.
            validation =
              validation.kind === 'valid'
                ? validation
                : {
                    kind: 'error',
                    code: validation.code,
                    message: safeExpressionMessage(validation),
                    ...(validation.limit === undefined
                      ? {}
                      : { limit: validation.limit }),
                  };
            sources.set(source.expression, validation);
          }
          message = safeExpressionMessage(validation);
        }
        if (message === '') continue;
        const issue: GraphValidationIssue = {
          code: 'invalid_expression',
          path: `${nodePath}.inputMappings.${key}`,
          message,
        };
        admitIssue(issue);
        issues.push(issue);
        if (issues.length === WORKFLOW_VALIDATION_MAX_ISSUES) break;
      }
      if (issues.length === WORKFLOW_VALIDATION_MAX_ISSUES) break;
    }
    if (issues.length === WORKFLOW_VALIDATION_MAX_ISSUES) break;
  }
  const report: GraphValidationResult =
    issues.length === 0
      ? structural
      : {
          ok: false,
          issues,
          expandedInvocations: structural.expandedInvocations,
          worstCaseLoopIterations: structural.worstCaseLoopIterations,
        };
  assertReportBudget(report);
  return report;
}
