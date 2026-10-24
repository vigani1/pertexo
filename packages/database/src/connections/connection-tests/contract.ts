import type { ConnectionDatabase } from '../contract.js';

/** Owns connection-test claim, dispatch, completion, and abandonment. */

export type ConnectionTestPersistence = Pick<
  ConnectionDatabase,
  | 'startConnectionTest'
  | 'resolveConnectionTestSecret'
  | 'markConnectionTestDispatched'
  | 'completeConnectionTest'
  | 'abandonConnectionTest'
>;
