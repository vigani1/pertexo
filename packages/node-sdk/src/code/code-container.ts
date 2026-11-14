import type { CodeSettings } from './code-settings.js';

// Container sizing around the settings: the manager's base and per-slot memory,
// each task's memory beyond its heap, and process and CPU allowances.
const CODE_CONTAINER_SIZING = Object.freeze({
  managerBaseMiB: 192,
  managerPerSlotMiB: 16,
  taskOverheadMiB: 768,
  managerHeapBaseMiB: 64,
  managerHeapPerSlotMiB: 8,
  taskRssOverheadMiB: 64,
  maximumCpus: 2,
  basePids: 16,
  pidsPerSlot: 16,
});
export function codeContainerLimits(settings: CodeSettings) {
  const sizing = CODE_CONTAINER_SIZING;
  const managerMiB =
    sizing.managerBaseMiB + settings.concurrency * sizing.managerPerSlotMiB;
  const taskMiB = settings.memoryMiB + sizing.taskOverheadMiB;
  return Object.freeze({
    memoryMiB: managerMiB + (settings.concurrency + 1) * taskMiB,
    managerHeapMiB:
      sizing.managerHeapBaseMiB +
      settings.concurrency * sizing.managerHeapPerSlotMiB,
    taskRssMiB: settings.memoryMiB + sizing.taskRssOverheadMiB,
    cpus: Math.min(settings.concurrency + 1, sizing.maximumCpus),
    pids: sizing.basePids + settings.concurrency * sizing.pidsPerSlot,
  });
}
