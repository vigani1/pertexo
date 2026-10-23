import { setTimeout as delay } from 'node:timers/promises';
import type { RunnerConfig } from '../config.js';
import { resolveCodePackages } from './packages.js';
import { startTaskSlot, type TaskSlot } from './slot.js';

/** Only unused processes are pooled. Every reservation consumes one process. */
export async function createTaskProcessPool(config: RunnerConfig) {
  const lifetime = new AbortController();
  const policy = await resolveCodePackages(config.settings);
  if (config.settings.enabled && config.settings.pythonPackages.length > 0) {
    const checked = await startTaskSlot(config, policy, {
      ordinal: 0,
      lifetime: lifetime.signal,
      language: 'python',
    });
    await checked.stop();
  }
  const slots: (TaskSlot | undefined)[] = Array.from({
    length: config.settings.enabled ? config.settings.concurrency : 0,
  });
  const owned = new Set<TaskSlot>();
  const preparing = new Set<Promise<void>>();
  let closed = false;
  const prepare = async (
    index: number,
    { initial }: Readonly<{ initial: boolean }>,
  ): Promise<void> => {
    while (!closed) {
      try {
        const slot = await startTaskSlot(config, policy, {
          ordinal: index,
          lifetime: lifetime.signal,
        });
        if (lifetime.signal.aborted) {
          await slot.stop();
          return;
        }
        owned.add(slot);
        slots[index] = slot;
        void slot.exited.then(() => {
          if (closed || slots[index] !== slot) return;
          slots[index] = undefined;
          owned.delete(slot);
          replenish(index);
        });
        return;
      } catch (error: unknown) {
        if (lifetime.signal.aborted) return;
        if (initial) throw error;
        await delay(500, undefined, { signal: lifetime.signal }).catch(
          () => undefined,
        );
      }
    }
  };
  const replenish = (index: number) => {
    const pending = prepare(index, { initial: false });
    preparing.add(pending);
    void pending.finally(() => preparing.delete(pending));
  };
  const close = async () => {
    closed = true;
    lifetime.abort();
    await Promise.allSettled([...owned].map((slot) => slot.stop()));
    await Promise.allSettled([...preparing]);
    owned.clear();
  };
  const started = await Promise.allSettled(
    slots.map((_slot, index) => prepare(index, { initial: true })),
  );
  const errors = started
    .filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    .map((result) => result.reason as unknown);
  if (errors.length > 0) {
    await close();
    throw new AggregateError(errors, 'Code process pool could not start');
  }
  return {
    reserve: () => {
      if (closed) return undefined;
      const index = slots.findIndex((slot) => slot !== undefined);
      const slot = slots[index];
      if (slot === undefined) return undefined;
      slots[index] = undefined;
      let released = false;
      let current = slot;
      let used = false;
      return {
        run: async (...args: Parameters<TaskSlot['run']>) => {
          if (used || released || closed)
            throw new Error('Code reservations are single-use');
          used = true;
          if (args[0].language === 'python') {
            await current.stop();
            owned.delete(current);
            lifetime.signal.throwIfAborted();
            args[1].throwIfAborted();
            current = await startTaskSlot(config, policy, {
              ordinal: index,
              lifetime: AbortSignal.any([lifetime.signal, args[1]]),
              language: 'python',
            });
            owned.add(current);
          }
          return current.run(...args);
        },
        release: async () => {
          if (released) return;
          released = true;
          await current.stop();
          owned.delete(current);
          if (!closed) {
            replenish(index);
          }
        },
      };
    },
    close,
  };
}
