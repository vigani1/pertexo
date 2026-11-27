export type { ConnectionMutationScope } from './data/connections.mutations';
export { useConnectionResultScope } from './data/connections.mutations';
export {
  describeTestOutcome,
  needsReconnecting,
  type TestPhase,
} from './model/connection-health';
export {
  fitsRequirement,
  isUsableConnection,
} from './model/connection-selection';
