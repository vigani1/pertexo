export type { ConnectionMutationScope } from './data/connections.mutations';
export { providerForCredential } from './model/connection-providers';
export { useConnectionResultScope } from './data/connections.mutations';
export { PROVIDERS } from './model/connection-providers';
export {
  describeTestOutcome,
  needsReconnecting,
  type TestPhase,
} from './model/connection-health';
export {
  fitsRequirement,
  isUsableConnection,
} from './model/connection-selection';
