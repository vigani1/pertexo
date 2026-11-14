import type { PortableIssue } from './portable-manifest.js';
import { PORTABLE_MANIFEST_FIELD_LIMITS } from './portability-limits.js';

export class PortableJsonError extends TypeError {
  public override readonly name = 'PortableJsonError';
  public constructor(
    public readonly code: 'portable_json_invalid' | 'portable_json_limit',
  ) {
    super('Portable JSON is invalid or exceeds its bounded contract');
  }
}

export class WorkflowPortabilityError extends Error {
  public override readonly name = 'WorkflowPortabilityError';
  public readonly code = 'workflow.portability_invalid';
  public readonly issues: readonly PortableIssue[];
  public constructor(code: string, path = '$') {
    super('Portable workflow violates its authoring contract');
    this.issues = Object.freeze([
      {
        code,
        path: path.slice(0, PORTABLE_MANIFEST_FIELD_LIMITS.issuePathLength),
        message:
          'Portable workflow content is not supported or safe for this operation',
      },
    ]);
  }
}
