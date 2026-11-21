export type { ConnectionMutationScope } from './data/connections.mutations';
export { useConnectionResultScope } from './data/connections.mutations';
export {
  connectionPresentation,
  isConnectionChoice,
} from './model/connection-providers';
export {
  describeTestOutcome,
  needsReconnecting,
  type TestPhase,
} from './model/connection-health';
export {
  fitsRequirement,
  isUsableConnection,
} from './model/connection-selection';
