import { describe, expect, it, vi } from 'vitest';

import { createNodeCatalog } from '../../src/definitions/catalog.js';
import {
  NodeDispatchEvidenceError,
  NodeExecutionRuntimeRequiredError,
  createNodeRegistry,
  type NodeConnectionHealthObservation,
} from '../../src/server.js';
import {
  definition,
  executor,
  policy,
  manifest,
  executorRegistration,
  configSchema,
  objectSchema,
  dispatchAwareFixture,
} from '../support/registry.js';

describe('node-sdk exact server registry', () => {
  it('executes ABI 2 after one durable marker and requires its runtime', async () => {
    const { beforeDispatch, registryFor, request } = dispatchAwareFixture();
    const registry = registryFor(async (invocation) => {
      expect(invocation.connectionRefs).toEqual(request.connectionRefs);
      await invocation.runtime?.beforeDispatch();
      return { ok: true };
    });
    expect(registry.dispatchMode(request)).toBe('executor_controlled');
    await expect(registry.execute(request)).resolves.toMatchObject({
      output: { ok: true },
    });
    expect(beforeDispatch).toHaveBeenCalledOnce();

    const { runtime: _runtime, ...withoutRuntime } = request;
    await expect(registry.execute(withoutRuntime)).rejects.toBeInstanceOf(
      NodeExecutionRuntimeRequiredError,
    );
  });

  it.each([
    { kind: 'healthy' },
    {
      kind: 'reauthorization_required',
      reasonCode: 'connection.slack_token_revoked',
    },
  ] satisfies readonly NodeConnectionHealthObservation[])(
    'forwards optional synchronous health capture without changing ABI 2 results %#',
    async (observation) => {
      const { registryFor, request, runtime } = dispatchAwareFixture();
      const observeConnectionHealth =
        vi.fn<(value: NodeConnectionHealthObservation) => void>();
      const registry = registryFor(async (invocation) => {
        await invocation.runtime?.beforeDispatch();
        invocation.runtime?.observeConnectionHealth?.(observation);
        return { ok: true };
      });
      await expect(
        registry.execute({
          ...request,
          runtime: { ...runtime, observeConnectionHealth },
        }),
      ).resolves.toEqual({ kind: 'succeeded', output: { ok: true } });
      expect(observeConnectionHealth).toHaveBeenCalledExactlyOnceWith(
        observation,
      );
      await expect(registry.execute(request)).resolves.toEqual({
        kind: 'succeeded',
        output: { ok: true },
      });
      expect(observeConnectionHealth).toHaveBeenCalledOnce();
    },
  );

  it('rejects ABI 2 completion without a durable marker', async () => {
    const { registryFor, request } = dispatchAwareFixture();

    await expect(
      registryFor(() => Promise.resolve({})).execute(request),
    ).rejects.toBeInstanceOf(NodeDispatchEvidenceError);
  });

  it('rejects a second ABI 2 durable marker', async () => {
    const { beforeDispatch, registryFor, request, runtime } =
      dispatchAwareFixture();

    await expect(
      registryFor(async (invocation) => {
        await invocation.runtime?.beforeDispatch();
        await invocation.runtime?.beforeDispatch();
        return {};
      }).execute({
        ...request,
        runtime: { ...runtime, beforeDispatch },
      }),
    ).rejects.toMatchObject({ code: 'duplicate_dispatch' });
    expect(beforeDispatch).toHaveBeenCalledOnce();
  });

  it('admits only one concurrent ABI 2 durable marker', async () => {
    let releaseMarker: (() => void) | undefined;
    const deferredMarker = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseMarker = resolve;
        }),
    );
    const { registryFor, request, runtime } =
      dispatchAwareFixture(deferredMarker);
    const concurrent = registryFor(async (invocation) => {
      const attempts = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          Promise.resolve(invocation.runtime?.beforeDispatch()),
        ),
      );
      expect(
        attempts.filter(({ status }) => status === 'rejected'),
      ).toHaveLength(7);
      return {};
    }).execute({
      ...request,
      runtime: { ...runtime, beforeDispatch: deferredMarker },
    });
    await vi.waitFor(() => {
      expect(deferredMarker).toHaveBeenCalledOnce();
    });
    releaseMarker?.();
    await expect(concurrent).resolves.toMatchObject({ output: {} });
  });

  it('does not retry a rejected ABI 2 durable marker', async () => {
    const rejectedMarker = vi.fn(() =>
      Promise.reject(new Error('durable marker rejected')),
    );
    const { registryFor, request, runtime } =
      dispatchAwareFixture(rejectedMarker);
    await expect(
      registryFor(async (invocation) => {
        await expect(invocation.runtime?.beforeDispatch()).rejects.toThrow(
          'durable marker rejected',
        );
        await expect(
          invocation.runtime?.beforeDispatch(),
        ).rejects.toMatchObject({ code: 'duplicate_dispatch' });
        return {};
      }).execute({
        ...request,
        runtime: { ...runtime, beforeDispatch: rejectedMarker },
      }),
    ).rejects.toMatchObject({ code: 'dispatch_evidence_missing' });
    expect(rejectedMarker).toHaveBeenCalledOnce();
  });

  it('preserves executor rejection while an ABI 2 marker remains in flight', async () => {
    let resolveInFlight: (() => void) | undefined;
    const inFlightMarker = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveInFlight = resolve;
        }),
    );
    const { registryFor, request, runtime } =
      dispatchAwareFixture(inFlightMarker);
    const executorFailure = registryFor((invocation) => {
      void invocation.runtime?.beforeDispatch();
      return Promise.reject(new Error('executor rejected while marking'));
    }).execute({
      ...request,
      runtime: { ...runtime, beforeDispatch: inFlightMarker },
    });
    await vi.waitFor(() => {
      expect(inFlightMarker).toHaveBeenCalledOnce();
    });
    await expect(executorFailure).rejects.toThrow(
      'executor rejected while marking',
    );
    resolveInFlight?.();
  });

  it('rejects executor ABIs whose dispatch contract is unknown', () => {
    const unsupportedAbi = 3;
    expect(() =>
      createNodeRegistry({
        definitions: [
          {
            manifest: { ...manifest, executorAbi: unsupportedAbi },
            configSchema,
            inputSchema: objectSchema,
            outputSchema: objectSchema,
          },
        ],
        executors: [executorRegistration()],
        catalog: createNodeCatalog({
          definitions: [{ ...manifest, executorAbi: unsupportedAbi }],
          executors: [
            {
              abiVersion: unsupportedAbi,
              definitions: [definition],
              executor,
              policyReferences: [policy],
            },
          ],
          policies: [policy],
        }),
      }),
    ).toThrow(/unsupported ABI 3/u);
  });
});
