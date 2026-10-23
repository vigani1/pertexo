import { utf8ByteLength } from '../../values/text.js';
import { supportsExpressionMappings } from '../../values/mapping/policy.js';
import { callbackReferenceIssue } from '../../flow/callbacks/validation.js';
import {
  eventCoordinationPolicySchema,
  isEventCoordinationTrigger,
} from '../../triggers/event-coordination/contract.js';
import { inspectEventCoordinationExpression } from '../../triggers/event-coordination/key.js';
import { workspaceVariableNameSchema } from '../../values/variables/contract.js';
import {
  WORKFLOW_VALIDATION_MAX_ISSUES,
  type WorkflowGraph,
  type ValueSource,
} from '../../graph/contract.js';
import { validateWorkflowGraph } from '../../graph/validation/index.js';
import type {
  GraphValidationIssue,
  GraphValidationResult,
} from '../../graph/validation/contract.js';
import {
  inspectExpression,
  type ExpressionValidation,
} from '../../values/expressions/policy.js';
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
    utf8ByteLength(JSON.stringify(report)) >
      AUTHORING_VALIDATION_BUDGET.reportBytes ||
    report.issues.some(
      ({ message }) =>
        utf8ByteLength(message) > AUTHORING_VALIDATION_BUDGET.messageBytes,
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
      utf8ByteLength(issue.message) >
        AUTHORING_VALIDATION_BUDGET.messageBytes ||
      utf8ByteLength(issue.path) + utf8ByteLength(issue.message) >
        AUTHORING_VALIDATION_BUDGET.reportBytes
    )
      throw new AuthoringValidationUnavailableError('report_limit');
    issueBytes += utf8ByteLength(JSON.stringify(issue));
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
  const inspectMapping = mappingInspector(workspaceVariableNames);
  const issues: GraphValidationIssue[] = [];
  if (graph.callable !== undefined) {
    const issue = inspectMapping(graph.callable.result, '$.callable.result', {
      supportsExpressions: true,
    });
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
      const coordinationIssue = inspectCoordination(node, nodePath);
      if (coordinationIssue !== undefined) {
        admitIssue(coordinationIssue);
        issues.push(coordinationIssue);
        if (issues.length === WORKFLOW_VALIDATION_MAX_ISSUES) break;
      }
      const supportsExpressions = expressionDefinitions.has(
        `${node.definition.key}\u0000${String(node.definition.version)}`,
      );
      for (const [key, source] of Object.entries(node.inputMappings)) {
        const issue = inspectMapping(
          source,
          `${nodePath}.inputMappings.${key}`,
          {
            supportsExpressions: supportsExpressions,
            localGraph: entry.graph,
            nodeId: node.id,
            externalHttp:
              policies.definitions
                .find(
                  (definition) =>
                    definition.definition.key === node.definition.key &&
                    definition.definition.version === node.definition.version,
                )
                ?.capabilities?.includes('external_http') ?? false,
          },
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

function mappingInspector(
  workspaceVariableNames: readonly string[] | undefined,
) {
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
    {
      supportsExpressions,
      localGraph,
      nodeId,
      externalHttp = false,
    }: Readonly<{
      supportsExpressions: boolean;
      localGraph?: WorkflowGraph;
      nodeId?: string;
      externalHttp?: boolean;
    }>,
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
            callbackReferenceIssue(validation.callbacks, localGraph, nodeId, {
              externalHttp: externalHttp,
            }) ?? '';
        }
      }
    }
    return message === '' ? undefined : { code, path, message };
  }
  return inspectMapping;
}

function coordinationMessage(
  coordination: ReturnType<typeof eventCoordinationPolicySchema.safeParse>,
): string | undefined {
  if (!coordination.success) return 'Correct the event coordination settings.';
  if (coordination.data.key.kind === 'expression')
    return inspectEventCoordinationExpression(coordination.data.key.expression);
  return undefined;
}

function inspectCoordination(
  node: WorkflowGraph['nodes'][number],
  nodePath: string,
): GraphValidationIssue | undefined {
  if (
    !isEventCoordinationTrigger(node.definition) ||
    node.config.coordination === undefined
  )
    return undefined;
  const coordination = eventCoordinationPolicySchema.safeParse(
    node.config.coordination,
  );
  const message = coordinationMessage(coordination);
  if (message === undefined) return undefined;
  return {
    code: 'invalid_expression',
    path: `${nodePath}.config.coordination.key`,
    message,
  };
}
