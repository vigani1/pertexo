import { describe, expect, it } from 'vitest';

import { workspaceLifecycleChangeResponseSchema } from '../../src/schemas/identity/workspaces.js';
import { identityWorkspaceOpenApiDocument } from '../../src/server.js';

const workspaceId = '0199a4a2-5c1e-7000-8000-000000000001';
const occurredAt = '2026-10-30T10:00:00.000Z';

type DocumentedOperation = Readonly<{
  post?: Readonly<{
    operationId: string;
    security: unknown;
    parameters: readonly Readonly<{ name: string }>[];
    responses: Readonly<Record<string, unknown>>;
  }>;
}>;

describe('workspace lifecycle contract', () => {
  // audit-1030 follow-up 1: the response can't name a reactivation yet.
  it.fails('answers a reactivation in the shape of a restore', () => {
    expect(
      workspaceLifecycleChangeResponseSchema.parse({
        workspaceId,
        change: 'reactivated',
        occurredAt,
      }),
    ).toEqual({ workspaceId, change: 'reactivated', occurredAt });
  });

  it('still refuses a change it does not know', () => {
    expect(
      workspaceLifecycleChangeResponseSchema.safeParse({
        workspaceId,
        change: 'resumed',
        occurredAt,
      }).success,
    ).toBe(false);
  });

  // audit-1030 follow-up 1: the route isn't documented yet.
  it.fails('documents reactivation as a session command with a key', () => {
    const paths = identityWorkspaceOpenApiDocument.paths as unknown as Readonly<
      Record<string, DocumentedOperation>
    >;
    const operation = paths['/v1/workspaces/{workspaceId}/reactivate']?.post;

    expect(operation?.operationId).toBe('reactivateWorkspace');
    expect(operation?.security).toEqual([{ cookieSession: [] }]);
    expect(operation?.parameters.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['workspaceId', 'Idempotency-Key']),
    );
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '401',
      '403',
      '409',
      '500',
    ]);
    expect(operation?.responses['200']).toMatchObject({
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/WorkspaceLifecycleChangeResponse',
          },
        },
      },
    });
  });
});
