import { supportsExpressionMappings } from '../mapping/policy.js';
import { callbackReferenceIssue } from '../callbacks/validation.js';
import {
  eventCoordinationPolicySchema,
  isEventCoordinationTrigger,
} from '../event-coordination/contract.js';
import { inspectEventCoordinationExpression } from '../event-coordination/key.js';
import { workspaceVariableNameSchema } from '../variables/contract.js';
import {
  WORKFLOW_VALIDATION_MAX_ISSUES,
  type WorkflowGraph,
  type ValueSource,
} from '../graph/contract.js';
import { validateWorkflowGraph } from '../graph/validation/index.js';
import type {
  GraphValidationIssue,
  GraphValidationResult,
} from '../graph/validation/contract.js';
import {
  inspectExpression,
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
    return 'This expression uses a construct unavailable in the expression policy.';
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
  workspaceVariableNames?: readonly string[],
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
  const expressionDefinitions = new Set(
    policies.definitions
      .filter(({ policyReferences, capabilities }) =>
        supportsExpressionMappings(policyReferences, capabilities),
      )
      .map(
        ({ definition }) =>
          `${definition.key}\u0000${String(definition.version)}`,
      ),
  );
  const names =
    workspaceVariableNames === undefined
      ? undefined
      : new Set(workspaceVariableNames);
  const sources = new Map<string, ReturnType<typeof inspectExpression>>();
  function missingVariableMessage(required: readonly string[]): string {
    if (names === undefined) return '';
    const missing = required.find((name) => !names.has(name));
    if (missing === undefined) return '';
    return workspaceVariableNameSchema.safeParse(missing).success
      ? `Workspace variable ${missing} does not exist. Add it in Settings → Variables.`
      : 'This mapping requires an unavailable workspace variable. Use an uppercase variable name from Settings → Variables.';
  }
  function inspectSource(expression: string) {
    let validation = sources.get(expression);
    if (validation === undefined) {
      validation = inspectExpression(expression);
      // Retain only policy/reference facts; parser messages may echo private source.
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
      sources.set(expression, validation);
    }
    return validation;
  }
  function inspectMapping(
    source: ValueSource,
    path: string,
    supportsExpressions: boolean,
    localGraph?: WorkflowGraph,
    nodeId?: string,
    externalHttp = false,
  ): GraphValidationIssue | undefined {
    let message = '';
    let code: GraphValidationIssue['code'] = 'invalid_mapping';
    if (source.kind === 'workspace_variable') {
      message = missingVariableMessage([source.name]);
    } else if (source.kind === 'expression') {
      code = 'invalid_expression';
      if (!supportsExpressions) {
        message =
          'The expression policy is not available for this step definition.';
      } else {
        const validation = inspectSource(source.expression);
        message = safeExpressionMessage(validation);
        if (validation.kind === 'valid') {
          code = 'invalid_mapping';
          message = missingVariableMessage(validation.references.requiredNames);
          message ||=
            callbackReferenceIssue(
              validation.callbacks,
              localGraph,
              nodeId,
              externalHttp,
            ) ?? '';
        }
      }
    }
    return message === '' ? undefined : { code, path, message };
  }
  const issues: GraphValidationIssue[] = [];
  if (graph.callable !== undefined) {
    const issue = inspectMapping(
      graph.callable.result,
      '$.callable.result',
      true,
    );
    if (issue !== undefined) {
      admitIssue(issue);
      issues.push(issue);
    }
  }
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
      if (
        isEventCoordinationTrigger(node.definition) &&
        node.config.coordination !== undefined
      ) {
        const coordination = eventCoordinationPolicySchema.safeParse(
          node.config.coordination,
        );
        const message = !coordination.success
          ? 'Correct the event coordination settings.'
          : coordination.data.key.kind === 'expression'
            ? inspectEventCoordinationExpression(
                coordination.data.key.expression,
              )
            : undefined;
        if (message !== undefined) {
          const issue = {
            code: 'invalid_expression' as const,
            path: `${nodePath}.config.coordination.key`,
            message,
          };
          admitIssue(issue);
          issues.push(issue);
          if (issues.length === WORKFLOW_VALIDATION_MAX_ISSUES) break;
        }
      }
      const supportsExpressions = expressionDefinitions.has(
        `${node.definition.key}\u0000${String(node.definition.version)}`,
      );
      for (const [key, source] of Object.entries(node.inputMappings)) {
        const issue = inspectMapping(
          source,
          `${nodePath}.inputMappings.${key}`,
          supportsExpressions,
          entry.graph,
          node.id,
          policies.definitions
            .find(
              (definition) =>
                definition.definition.key === node.definition.key &&
                definition.definition.version === node.definition.version,
            )
            ?.capabilities?.includes('external_http') === true,
        );
        if (issue === undefined) continue;
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
