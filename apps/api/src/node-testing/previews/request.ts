import type { NodeTestRequest } from '@pertexo/contracts';
import { createHash } from 'node:crypto';

import {
  canonicalJson,
  normalizedJson,
  utf8ByteLength,
  type JsonValue,
} from '@pertexo/workflow-model';

import { z } from 'zod';

import { NodeTestRequestError } from '../errors.js';

import type { NodeTestUseCaseInput } from '../use-case.js';

export const PREVIEW_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export const PREVIEW_EXECUTION_TIMEOUT_MS = 5 * 60 * 1_000;

const executableNodeSchema = z
  .record(z.string(), z.json())
  .refine(
    (node) => utf8ByteLength(JSON.stringify(node)) <= 1_048_576,
    'executable node must be a bounded JSON object',
  );

export function validationInputFields(
  request: NodeTestRequest,
): Readonly<{ sampleInput?: JsonValue }> | Readonly<{ deferInput: true }> {
  if (request.mode === 'validate')
    return request.sampleInput === undefined
      ? {}
      : { sampleInput: request.sampleInput as JsonValue };
  if (request.input.kind === 'manual')
    return { sampleInput: request.input.value as JsonValue };
  return { deferInput: true };
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function previewExecutionIdentity(
  input: NodeTestUseCaseInput,
  request: Extract<NodeTestRequest, Readonly<{ mode: 'test_execute' }>>,
): Readonly<{ keyHash: string; requestHash: string }> {
  if (input.idempotencyKey === undefined)
    throw new NodeTestRequestError('idempotency_required');
  return Object.freeze({
    keyHash: createHash('sha256').update(input.idempotencyKey).digest('hex'),
    requestHash: digest({
      domain: 'pertexo.preview.execute-request',
      actorId: input.actor.actorId,
      workspaceId: input.routeWorkspaceId,
      workflowId: input.workflowId,
      nodeId: input.nodeId,
      request,
    }),
  });
}

export function normalizedExecutableNode(value: unknown) {
  const parsed: unknown = JSON.parse(normalizedJson(value));
  const node = executableNodeSchema.parse(parsed);
  return {
    ...node,
    ...(node.connectionRefs === undefined
      ? {}
      : {
          connectionRefs: z
            .record(z.string(), z.string())
            .parse(node.connectionRefs),
        }),
  };
}
