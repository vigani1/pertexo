// Compatibility barrel: keep the original import path stable while the
// database and worker responsibilities live in separate modules.
export {
  createScheduleTriggerDatabase,
  type ScheduleTriggerCommandResult,
  type ScheduleTriggerDatabase,
  type ScheduleTriggerRecord,
} from './schedule-trigger-database.js';
export {
  createScheduleTriggerScanner,
  ScheduleClaimLostError,
  type ScheduleCheckpointFactory,
  type ScanDueSchedulesResult,
  type ScheduleTriggerScanner,
} from './schedule-trigger-scanner.js';
export { ScheduleTriggerError } from './schedule-trigger-errors.js';
