import { describe, expect, it, vi } from 'vitest';
import {
  createEditorBrowserWorkerLifetime,
  type EditorBrowserRuntimeConstruction,
} from './lifetime.js';

function resource() {
  return { close: vi.fn().mockResolvedValue(undefined) };
}

describe('owned editor worker runtime restart lifetime', () => {
  it('retains the namespace and constructs fresh runtime owners/drain after restart', async () => {
    const namespace = resource();
    const runtimes = [resource(), resource()];
    const drains: unknown[] = [];
    const construct = vi.fn((resources: EditorBrowserRuntimeConstruction) => {
      drains.push(resources.drain);
      resources.coordinator = runtimes[drains.length - 1];
      return Promise.resolve();
    });
    const owner = createEditorBrowserWorkerLifetime(namespace, construct);
    await owner.start();
    await owner.restart();
    expect(construct).toHaveBeenCalledTimes(2);
    expect(drains[0]).not.toBe(drains[1]);
    expect(runtimes[0]?.close).toHaveBeenCalledOnce();
    expect(namespace.close).not.toHaveBeenCalled();
    await owner.close();
    expect(runtimes[1]?.close).toHaveBeenCalledOnce();
    expect(namespace.close).toHaveBeenCalledOnce();
  });

  it('rejects restart during setup and never reconstructs after stop', async () => {
    const pending = Promise.withResolvers<undefined>();
    const namespace = resource();
    const created = resource();
    const later = vi.fn();
    const owner = createEditorBrowserWorkerLifetime(
      namespace,
      async (resources, assertActive) => {
        await pending.promise;
        resources.coordinator = created;
        assertActive();
        later();
      },
    );
    const startup = owner.start();
    const failed = expect(startup).rejects.toThrow('no longer active');
    expect(() => owner.restart()).toThrow('unavailable');
    const shutdown = owner.close();
    const poisoned = expect(shutdown).rejects.toMatchObject({
      phases: ['startup'],
    });
    pending.resolve(undefined);
    await failed;
    await poisoned;
    expect(later).not.toHaveBeenCalled();
    expect(created.close).toHaveBeenCalledOnce();
    expect(namespace.close).not.toHaveBeenCalled();
    expect(() => owner.start()).toThrow('no longer active');
  });

  it('serializes final close with restart close and forbids duplicate restart', async () => {
    const closing = Promise.withResolvers<undefined>();
    const namespace = resource();
    const first = resource();
    first.close.mockReturnValueOnce(closing.promise);
    const construct = vi.fn((resources: EditorBrowserRuntimeConstruction) => {
      resources.dispatcher = first;
      return Promise.resolve();
    });
    const owner = createEditorBrowserWorkerLifetime(namespace, construct);
    await owner.start();
    const restart = owner.restart();
    const rejected = expect(restart).rejects.toThrow('no longer active');
    expect(() => owner.restart()).toThrow('unavailable');
    const stop = owner.close();
    const poisoned = expect(stop).rejects.toMatchObject({
      phases: ['restart'],
    });
    closing.resolve(undefined);
    await rejected;
    await poisoned;
    expect(construct).toHaveBeenCalledOnce();
    expect(namespace.close).not.toHaveBeenCalled();
  });

  it('retains namespace after a failed close even if the later close succeeds', async () => {
    const namespace = resource();
    const dispatcher = resource();
    dispatcher.close.mockRejectedValueOnce(
      new Error('private runtime failure'),
    );
    const construct = vi.fn((resources: EditorBrowserRuntimeConstruction) => {
      resources.dispatcher = dispatcher;
      return Promise.resolve();
    });
    const owner = createEditorBrowserWorkerLifetime(namespace, construct);
    await owner.start();
    await expect(owner.restart()).rejects.toMatchObject({
      phases: ['dispatcher'],
    });
    await expect(owner.close()).rejects.toMatchObject({ phases: ['restart'] });
    expect(construct).toHaveBeenCalledOnce();
    expect(namespace.close).not.toHaveBeenCalled();
  });

  it.each(['startup', 'restart'] as const)(
    'retains partial construction and poisons %s final cleanup',
    async (phase) => {
      const namespace = resource();
      const created: ReturnType<typeof resource>[] = [];
      const owner = createEditorBrowserWorkerLifetime(
        namespace,
        (resources) => {
          const runtime = resource();
          created.push(runtime);
          resources.triggers = [runtime];
          if (phase === 'startup' || created.length === 2)
            return Promise.reject(
              new Error('constructor failed after resource acquisition'),
            );
          return Promise.resolve();
        },
      );
      if (phase === 'startup')
        await expect(owner.start()).rejects.toThrow('constructor failed');
      else {
        await owner.start();
        await expect(owner.restart()).rejects.toThrow('constructor failed');
      }
      await expect(owner.close()).rejects.toMatchObject({ phases: [phase] });
      expect(created.at(-1)?.close).toHaveBeenCalledOnce();
      expect(namespace.close).not.toHaveBeenCalled();
    },
  );

  it('rejects a second successful restart and final close is once-owned', async () => {
    const namespace = resource();
    const owner = createEditorBrowserWorkerLifetime(namespace, () =>
      Promise.resolve(),
    );
    await owner.start();
    await owner.restart();
    expect(() => owner.restart()).toThrow('unavailable');
    await Promise.all([owner.close(), owner.close()]);
    expect(namespace.close).toHaveBeenCalledOnce();
  });
});
