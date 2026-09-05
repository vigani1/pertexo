import './server-only.js';

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { canonicalJson } from './canonical-json.js';
import type { NodeId } from './graph-contract.js';

export type InvocationScopePart =
  | { readonly kind: 'branch'; readonly branchId: string }
  | {
      readonly kind: 'iteration';
      readonly loopNodeId: string;
      readonly ordinal: number;
    };

export interface InvocationIdentityInput {
  readonly workflowRunId: string;
  readonly workflowVersionId: string;
  readonly nodeId: NodeId;
  readonly scope: readonly InvocationScopePart[];
}

export class InvalidInvocationScopeError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInvocationScopeError';
  }
}

const invocationIdentityInputSchema = z
  .object({
    workflowRunId: z.string().min(1),
    workflowVersionId: z.string().min(1),
    nodeId: z.string().min(1),
    scope: z.array(
      z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('branch'),
            branchId: z.string().min(1),
          })
          .strict(),
        z
          .object({
            kind: z.literal('iteration'),
            loopNodeId: z.string().min(1),
            ordinal: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      ]),
    ),
  })
  .strict();

export function invocationIdentity(input: InvocationIdentityInput): {
  readonly workflowRunId: string;
  readonly canonicalScope: string;
  readonly invocationKey: string;
} {
  const parsed = invocationIdentityInputSchema.safeParse(input);
  if (!parsed.success)
    throw new InvalidInvocationScopeError(
      'invocation scope must use exact branch or loop fields with non-empty identifiers and zero-based safe ordinals',
    );
  const identity = parsed.data;
  const canonicalScope = identity.scope
    .map((part) =>
      part.kind === 'branch'
        ? `branch:${encodeURIComponent(part.branchId)}`
        : `loop:${encodeURIComponent(part.loopNodeId)}[${String(part.ordinal)}]`,
    )
    .join('/');
  const invocationKey = createHash('sha256')
    .update(
      canonicalJson({
        version: identity.workflowVersionId,
        node: identity.nodeId,
        scope: identity.scope,
      }),
    )
    .digest('hex');
  return {
    workflowRunId: identity.workflowRunId,
    canonicalScope,
    invocationKey,
  };
}
