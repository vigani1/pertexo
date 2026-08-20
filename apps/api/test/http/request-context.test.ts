import { describe, expect, it } from 'vitest';

import {
  RequestContextMiddleware,
  RequestContextStore,
  createRequestContext,
} from '../../src/platform/http/index.js';

const workspaceA = '11111111-1111-4111-8111-111111111111';
const workspaceB = '22222222-2222-4222-8222-222222222222';

describe('request context', () => {
  it('keeps immutable request state isolated across concurrent async work', async () => {
    const store = new RequestContextStore();

    const readContext = async (
      requestId: string,
      workspaceId: string,
      actorId: string,
    ) =>
      store.run(createRequestContext(requestId), async () => {
        store.setWorkspace(workspaceId);
        store.setActor({ actorId, kind: 'user' });
        await Promise.resolve();
        return store.get();
      });

    const [contextA, contextB] = await Promise.all([
      readContext('request-a', workspaceA, 'actor-a'),
      readContext('request-b', workspaceB, 'actor-b'),
    ]);

    expect(contextA).toMatchObject({
      requestId: 'request-a',
      workspaceId: workspaceA,
      actor: { actorId: 'actor-a', kind: 'user' },
    });
    expect(contextB).toMatchObject({
      requestId: 'request-b',
      workspaceId: workspaceB,
      actor: { actorId: 'actor-b', kind: 'user' },
    });
    expect(Object.isFrozen(contextA)).toBe(true);
    expect(Object.isFrozen(contextA.actor)).toBe(true);
  });

  it('does not allow actor or workspace context outside a request scope', () => {
    const store = new RequestContextStore();

    expect(() => store.get()).toThrow('request context is unavailable');
    expect(() => store.setWorkspace(workspaceA)).toThrow(
      'request context is unavailable',
    );
    expect(() => store.setActor({ actorId: 'actor-a', kind: 'user' })).toThrow(
      'request context is unavailable',
    );
  });

  it('echoes a valid request id and ignores untrusted actor/workspace headers', async () => {
    const store = new RequestContextStore();
    const middleware = new RequestContextMiddleware(store);
    const response = { header: (): void => undefined };
    let context: ReturnType<RequestContextStore['get']> | undefined;

    await middleware.use(
      {
        headers: {
          'x-request-id': 'client-request-42',
          'x-actor-id': 'attacker-controlled',
          'x-workspace-id': workspaceB,
        },
      },
      response,
      () => {
        context = store.get();
      },
    );

    expect(context).toMatchObject({ requestId: 'client-request-42' });
    expect(context?.requestId).toBe('client-request-42');
    expect(context?.actor).toBeUndefined();
    expect(context?.workspaceId).toBeUndefined();
  });

  it('generates and echoes a safe request id when the incoming value is invalid', async () => {
    const store = new RequestContextStore();
    const middleware = new RequestContextMiddleware(store);
    let echoedId: string | undefined;
    let contextId: string | undefined;

    const request: {
      headers: { 'x-request-id': string };
      requestId?: string;
    } = {
      headers: { 'x-request-id': 'bad request\r\nforged-header: true' },
    };
    await middleware.use(
      request,
      {
        header: (_name: string, value: string): void => {
          echoedId = value;
        },
      },
      () => {
        contextId = store.get().requestId;
      },
    );

    expect(contextId).toBeDefined();
    expect(contextId).not.toBe('bad request\r\nforged-header: true');
    expect(contextId).not.toMatch(/[\r\n]/u);
    expect(echoedId).toBe(contextId);
    expect(request.requestId).toBe(contextId);
    expect(contextId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  });
});
