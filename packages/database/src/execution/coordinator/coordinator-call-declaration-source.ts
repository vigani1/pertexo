import { z } from 'zod';
import { parseWorkflowExecutionValueSnapshot } from '../node-attempts/node-attempt-call-input-record.js';

const rowSchema = z
  .object({
    invocation_key: z.string().min(1).max(256),
    node_id: z.string().min(1).max(128),
    attempt_id: z.uuid(),
    callee_version_id: z.uuid(),
    snapshot: z.unknown(),
  })
  .strict();

/** Immutable selected declaration identity; never grants artifact consumption. */
export type NativeCoordinatorCallDeclarationSource = Readonly<{
  invocationKey: string;
  nodeId: string;
  declarationAttemptId: string;
  calleeVersionId: string;
  snapshot: Readonly<{
    reference: Extract<
      ReturnType<typeof parseWorkflowExecutionValueSnapshot>['reference'],
      { kind: 'artifact' }
    >;
    sha256: string;
    byteLength: number;
  }>;
}>;

export function parseCoordinatorCallDeclarationRow(value: unknown) {
  const row = rowSchema.parse(value);
  return Object.freeze({
    invocationKey: row.invocation_key,
    nodeId: row.node_id,
    declarationAttemptId: row.attempt_id,
    calleeVersionId: row.callee_version_id,
    snapshot: parseWorkflowExecutionValueSnapshot(row.snapshot),
  });
}

export function parseCoordinatorArtifactCallDeclarationRow(
  value: unknown,
): NativeCoordinatorCallDeclarationSource {
  const source = parseCoordinatorCallDeclarationRow(value);
  if (source.snapshot.reference.kind !== 'artifact')
    throw new TypeError(
      'Native coordinator Call artifact declaration is missing',
    );
  return Object.freeze({
    ...source,
    snapshot: Object.freeze({
      reference: source.snapshot.reference,
      sha256: source.snapshot.sha256,
      byteLength: source.snapshot.byteLength,
    }),
  });
}
