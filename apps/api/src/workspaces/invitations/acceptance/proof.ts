import { z } from 'zod';

const TOKEN_PATTERN =
  /^wi1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u;

const tokenSchema = z.string().regex(TOKEN_PATTERN);

const bindingSchema = z
  .string()
  .regex(
    /^wb1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/u,
  );

export function parseToken(value: string) {
  const match = tokenSchema.safeParse(value);
  if (!match.success) return null;
  const [, workspaceId, invitationId, secret] = TOKEN_PATTERN.exec(value) ?? [];
  return workspaceId === undefined ||
    invitationId === undefined ||
    secret === undefined
    ? null
    : { workspaceId, invitationId, secret };
}

export function parseBinding(value: string | undefined) {
  if (value === undefined || !bindingSchema.safeParse(value).success)
    return null;
  const match = /^wb1\.([^.]+)\.([^.]+)\.([^.]+)\.([^.]+)$/u.exec(value);
  if (match === null) return null;
  const [, workspaceId, intentId, bindingSecret, csrfToken] = match;
  const incompleteAcceptanceProof =
    workspaceId === undefined ||
    intentId === undefined ||
    bindingSecret === undefined ||
    csrfToken === undefined;
  if (incompleteAcceptanceProof) return null;
  return {
    workspaceId,
    intentId,
    bindingSecret,
    csrfToken,
  };
}
