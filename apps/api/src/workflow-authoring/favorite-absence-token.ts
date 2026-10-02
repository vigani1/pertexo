import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { workflowFavoriteAbsenceRevisionSchema } from '@pertexo/contracts/schemas/workflow-authoring';

const TTL_SECONDS = 86_400;
const MAX_UNIX_SECONDS = 253_402_300_799;
const SUBKEY_LABEL = 'pertexo.workflow.favorite.absence-key.v1';
const uuidSchema = z
  .uuid()
  .length(36)
  .regex(/^[0-9a-f-]+(?![\s\S])/u);
const scopeSchema = z
  .object({
    workspaceId: uuidSchema,
    actorId: uuidSchema,
    workflowId: uuidSchema,
  })
  .strict();
const preconditionSchema = z
  .object({
    generation: uuidSchema,
    issuedAtSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_UNIX_SECONDS - TTL_SECONDS),
  })
  .strict();

export type WorkflowFavoriteAbsenceScope = Readonly<
  z.output<typeof scopeSchema>
>;
export type WorkflowFavoriteAbsencePrecondition = Readonly<
  z.output<typeof preconditionSchema>
>;
export type WorkflowFavoriteAbsenceProof = WorkflowFavoriteAbsencePrecondition &
  Readonly<{ expiresAtSeconds: number }>;
export type WorkflowFavoriteAbsenceTokenCodec = Readonly<{
  issue(
    scope: WorkflowFavoriteAbsenceScope,
    precondition: WorkflowFavoriteAbsencePrecondition,
  ): string;
  verify(
    value: string,
    scope: WorkflowFavoriteAbsenceScope,
    generation: string,
  ): WorkflowFavoriteAbsenceProof;
}>;

export class InvalidWorkflowFavoriteAbsenceTokenError extends TypeError {
  public override readonly name = 'InvalidWorkflowFavoriteAbsenceTokenError';
  public constructor() {
    super('workflow favorite absence token is invalid');
  }
}

function canonicalPayload(
  scope: WorkflowFavoriteAbsenceScope,
  proof: WorkflowFavoriteAbsenceProof,
): string {
  return JSON.stringify({
    v: 1,
    w: scope.workspaceId,
    a: scope.actorId,
    id: scope.workflowId,
    g: proof.generation,
    i: proof.issuedAtSeconds,
    e: proof.expiresAtSeconds,
  });
}

/** Time policy belongs to SQL for NEW commands; completed receipts bypass this codec. */
export function createWorkflowFavoriteAbsenceTokenCodec(
  key: Uint8Array,
): WorkflowFavoriteAbsenceTokenCodec {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32)
    throw new TypeError(
      'Workflow favorite absence token key must contain 32 bytes.',
    );
  const ownedRoot = Buffer.from(key);
  let subkey: Buffer;
  try {
    subkey = createHmac('sha256', ownedRoot)
      .update(SUBKEY_LABEL, 'utf8')
      .digest();
  } finally {
    ownedRoot.fill(0);
  }
  const sign = (
    scope: WorkflowFavoriteAbsenceScope,
    proof: WorkflowFavoriteAbsenceProof,
  ): Buffer =>
    createHmac('sha256', subkey)
      .update(canonicalPayload(scope, proof), 'utf8')
      .digest();
  return Object.freeze({
    issue(scope, precondition): string {
      try {
        const currentScope = scopeSchema.parse(scope);
        const checked = preconditionSchema.parse(precondition);
        const proof = {
          ...checked,
          expiresAtSeconds: checked.issuedAtSeconds + TTL_SECONDS,
        };
        return workflowFavoriteAbsenceRevisionSchema.parse(
          `absent.v1.${String(proof.issuedAtSeconds)}.${String(proof.expiresAtSeconds)}.${sign(currentScope, proof).toString('base64url')}`,
        );
      } catch {
        throw new InvalidWorkflowFavoriteAbsenceTokenError();
      }
    },
    verify(value, scope, generation): WorkflowFavoriteAbsenceProof {
      try {
        const currentScope = scopeSchema.parse(scope);
        const currentGeneration = uuidSchema.parse(generation);
        const wire = workflowFavoriteAbsenceRevisionSchema.parse(value);
        const parts = wire.split('.');
        const mac = parts[4];
        if (mac === undefined)
          throw new InvalidWorkflowFavoriteAbsenceTokenError();
        const supplied = Buffer.from(mac, 'base64url');
        if (
          supplied.byteLength !== 32 ||
          supplied.toString('base64url') !== mac
        )
          throw new InvalidWorkflowFavoriteAbsenceTokenError();
        const proof = Object.freeze({
          generation: currentGeneration,
          issuedAtSeconds: Number(parts[2]),
          expiresAtSeconds: Number(parts[3]),
        });
        if (!timingSafeEqual(sign(currentScope, proof), supplied))
          throw new InvalidWorkflowFavoriteAbsenceTokenError();
        return proof;
      } catch {
        throw new InvalidWorkflowFavoriteAbsenceTokenError();
      }
    },
  });
}
