import { v7 as uuidv7 } from 'uuid';

/** Generate an application-owned, time-ordered identifier for persisted rows. */
export function generatePersistedId(): string {
  return uuidv7();
}
