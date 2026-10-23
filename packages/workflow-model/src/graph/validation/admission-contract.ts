export interface WorkflowGraphAdmissionLimits {
  readonly graphBytes: number;
  readonly inputDepth: number;
  readonly jsonValueDepth: number;
  readonly structuredDepth: number;
}

export interface WorkflowGraphAdmissionOptions {
  /** Let the structural Zod schema retain its browser-facing number diagnostic. */
  readonly allowNonFiniteNumbers?: boolean;
}

export type WorkflowGraphAdmissionFailure = Readonly<{
  ok: false;
  code:
    'structured_depth' | 'json_value_depth' | 'invalid_json' | 'graph_limit';
  path: string;
  message: string;
}>;

export type WorkflowGraphAdmission =
  | Readonly<{ ok: true; snapshot: unknown; bytes: number }>
  | WorkflowGraphAdmissionFailure;

export function failure(
  code: WorkflowGraphAdmissionFailure['code'],
  path: string,
  message: string,
): WorkflowGraphAdmissionFailure {
  return { ok: false, code, path, message };
}
