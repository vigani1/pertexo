import './server-only.js';

/**
 * Stable public facade for restricted JSONata policy and evaluation.
 *
 * Policy/AST validation and worker supervision have separate owners so a
 * language-policy change does not require navigating lifecycle machinery.
 * These implementation files remain private; this subpath remains the only
 * supported expressions interface.
 */
export {
  EXPRESSION_POLICY_V1,
  JSONATA_EVALUATOR_DIAGNOSTICS,
  validateExpression,
  type ExpressionContextV1,
  type ExpressionEvaluator,
  type ExpressionLimit,
  type ExpressionRequest,
  type ExpressionResult,
  type ExpressionValidation,
  type ExpressionWorkerFactory,
} from './expressions/policy.js';
export { JsonataEvaluator } from './expressions/evaluator.js';
