const MIB = 1_024 * 1_024;

/**
 * What an operator may set for the API's and the worker's memory, in MiB.
 * The defaults are what the minimum server (4 GiB, 2 vCPUs) is qualified
 * with; less than the minimum was never measured to hold.
 */
export const SERVICE_MEMORY_SETTINGS = Object.freeze({
  API_MEMORY_MB: { default: 512, minimum: 512 },
  WORKER_MEMORY_MB: { default: 768, minimum: 512 },
});

// The API's heap may take half its memory; the rest is native memory and
// buffers (S9 measured about 0.38 MiB per request held).
const API_HEAP_SHARE = 1 / 2;
// The worker's heap peaked at 140-200 MiB beside about 165 MiB of live native
// allocations at its busiest (S10), so a third goes to the heap.
const WORKER_HEAP_SHARE = 1 / 3;
// The worker drains and restarts itself this far below its container cap,
// so the kernel never kills it mid-step.
const WORKER_DRAIN_HEADROOM_SHARE = 1 / 6;
const WORKER_DRAIN_HEADROOM_MINIMUM_MIB = 128;

/**
 * Turns the two operator settings into every value Compose needs, so a heap,
 * a container cap and a drain budget can never disagree.
 */
export function serviceMemoryLimits(environment) {
  const apiMiB = memorySetting(environment, 'API_MEMORY_MB');
  const workerMiB = memorySetting(environment, 'WORKER_MEMORY_MB');
  const headroomMiB = Math.max(
    WORKER_DRAIN_HEADROOM_MINIMUM_MIB,
    Math.floor(workerMiB * WORKER_DRAIN_HEADROOM_SHARE),
  );
  return {
    api: {
      memoryMiB: apiMiB,
      heapMiB: Math.floor(apiMiB * API_HEAP_SHARE),
    },
    worker: {
      memoryMiB: workerMiB,
      heapMiB: Math.floor(workerMiB * WORKER_HEAP_SHARE),
      maximumRssBytes: (workerMiB - headroomMiB) * MIB,
    },
  };
}

function memorySetting(environment, name) {
  const { default: fallback, minimum } = SERVICE_MEMORY_SETTINGS[name];
  const raw = environment[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/u.test(raw))
    throw new Error(`${name} must be a whole number of MiB`);
  const value = Number(raw);
  if (value < minimum)
    throw new Error(`${name} must be at least ${String(minimum)}`);
  return value;
}
