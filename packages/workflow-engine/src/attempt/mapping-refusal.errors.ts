import type { ValueSource } from '@pertexo/workflow-model';
import type {
  ExpressionLimit,
  ExpressionResult,
} from '@pertexo/workflow-model/server';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import {
  WorkflowEngineError,
  type EngineErrorCode,
} from '../workflow-engine.errors.js';

type Variable = Extract<
  ExpressionResult,
  { code: 'variable_missing' }
>['variable'];
type MappingField = Readonly<{
  mappingKey: string;
  sourceKind: ValueSource['kind'];
}>;
type TemporaryReason =
  | Readonly<{ kind: 'expression_timeout'; maximumMs: number }>
  | Readonly<{ kind: 'expression_unavailable' }>
  | Readonly<{ kind: 'pool_capacity'; maximumQueued: number }>;
export type MappingRefusal = MappingField &
  (
    | Readonly<{ kind: 'variable_missing'; variable: Variable }>
    | Readonly<{ kind: 'invalid_path'; path: string }>
    | Readonly<{
        kind: 'expression_limit';
        limit: ExpressionLimit;
        maximum: number;
      }>
    | Readonly<{ kind: 'expression_failed' }>
    | Readonly<{ kind: 'nonfinite_result' }>
    | TemporaryReason
  );

/** Safe facts only: expression source, evaluated values and host errors stay private. */
export class MappingRefusalError extends WorkflowEngineError {
  constructor(
    code: EngineErrorCode,
    readonly diagnostic: MappingRefusal,
  ) {
    super(code, 'A mapping could not resolve.');
    this.name = 'MappingRefusalError';
  }
}

/** Preserve the existing retry/definite-failure contract for evaluator process outcomes. */
export class MappingExecutorFailure extends NodeExecutorFailure {
  constructor(
    readonly diagnostic: MappingField &
      (TemporaryReason | Readonly<{ kind: 'nonfinite_result' }>),
  ) {
    let safeErrorCode = 'execution.expression_unavailable';
    if (diagnostic.kind === 'nonfinite_result')
      safeErrorCode = 'execution.expression_failed';
    else if (diagnostic.kind === 'expression_timeout')
      safeErrorCode = 'execution.expression_timed_out';
    super({
      kind: diagnostic.kind === 'nonfinite_result' ? 'failed' : 'retry',
      errorKind:
        diagnostic.kind === 'nonfinite_result' ? 'configuration' : 'timeout',
      possiblyDispatched: false,
      safeErrorCode,
    });
  }
}
