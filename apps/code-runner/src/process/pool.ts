import { setTimeout as delay } from 'node:timers/promises';
import type { RunnerConfig } from '../config/runner-config.js';
import { resolveCodePackages } from './packages.js';
import { startTaskSlot, type TaskSlot } from './slot.js';
import { TaskReservationUsedError } from './task-process.errors.js';

/** How long the pool waits before replacing a task process that failed to start. */
const RESPAWN_DELAY_MILLIS = 500;
/** Tasks that may wait for a slot at once; a task beyond them is told the runner is busy. */
export const MAXIMUM_WAITING_TASKS = 64;

export type TaskReservation = Readonly<{
  run: TaskSlot['run'];
  release: () => Promise<void>;
}>;
type SlotWaiter = Readonly<{
  hand: (reservation: TaskReservation | undefined) => void;
}>;

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
  // First come, first served: a freed slot goes to the task that waited longest.
  const waiting: SlotWaiter[] = [];
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
        handOut();
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
        await delay(RESPAWN_DELAY_MILLIS, undefined, {
          signal: lifetime.signal,
        }).catch(() => undefined);
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
    for (const waiter of waiting.splice(0)) waiter.hand(undefined);
    await Promise.allSettled([...owned].map((slot) => slot.stop()));
    await Promise.allSettled([...preparing]);
    owned.clear();
  };
  const reserveFree = (): TaskReservation | undefined => {
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
          throw new TaskReservationUsedError(
            'Code reservations are single-use',
          );
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
  };
  function handOut(): void {
    while (waiting.length > 0) {
      const reservation = reserveFree();
      if (reservation === undefined) return;
      waiting.shift()?.hand(reservation);
    }
  }
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
    /** A free slot now, unless none is free or earlier tasks are still waiting. */
    reserve: (): TaskReservation | undefined =>
      closed || waiting.length > 0 ? undefined : reserveFree(),
    /**
     * Joins the queue for the next free slot. Resolves without one when the
     * caller gives up or the pool closes; undefined when the queue is full.
     */
    waitForSlot: (
      signal: AbortSignal,
    ): Promise<TaskReservation | undefined> | undefined =>
      closed || waiting.length >= MAXIMUM_WAITING_TASKS
        ? undefined
        : joinQueue(waiting, signal),
    close,
  };
}

/** Resolves with the slot handed to this place in line, or without one if the caller leaves. */
function joinQueue(
  waiting: SlotWaiter[],
  signal: AbortSignal,
): Promise<TaskReservation | undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(undefined);
      return;
    }
    const leave = () => {
      waiting.splice(waiting.indexOf(waiter), 1);
      resolve(undefined);
    };
    const waiter: SlotWaiter = {
      hand: (reservation) => {
        signal.removeEventListener('abort', leave);
        resolve(reservation);
      },
    };
    signal.addEventListener('abort', leave, { once: true });
    waiting.push(waiter);
  });
}
