import { createNodeAttemptRuntime } from '../../src/attempts/delivery/runtime.js';
import { createMaintenanceRuntime } from '../../src/maintenance/runtime.js';
import { createCoordinatorRuntime } from '../../src/runs/runtime.js';
import { createTriggerRuntime } from '../../src/triggers/runtime.js';

export const testCoordinatorRuntime = createCoordinatorRuntime;
export const testTriggerRuntime = createTriggerRuntime;
export const testMaintenanceRuntime = createMaintenanceRuntime;
export const testNodeAttemptRuntime = createNodeAttemptRuntime;
