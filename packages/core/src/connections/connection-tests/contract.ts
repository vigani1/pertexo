import type { ConnectionStore } from '../contract.js';

/** Owns connection-test claim, dispatch, completion, and abandonment. */

export type ConnectionTestPersistence = Pick<
  ConnectionStore,
  | 'startConnectionTest'
  | 'resolveConnectionTestSecret'
  | 'markConnectionTestDispatched'
  | 'completeConnectionTest'
  | 'abandonConnectionTest'
>;
