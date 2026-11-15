import { COLLABORATION_LIMITS } from '@pertexo/workflow-model';
import type { WorkflowPresence } from '@pertexo/contracts';
import type { PoolClient } from 'pg';
import type { EnterCollaboration } from './authority.repository.js';
import { WorkflowCollaborationError } from './workflow-collaboration.errors.js';
import type {
  HeartbeatInput,
  PresenceInput,
} from './workflow-collaboration.types.js';
import {
  countPresence,
  holdsPresence,
  leavePresence,
  pruneExpiredPresence,
  readPresence,
  storePresence,
} from './presence.repository.js';

export function collaborationPresence(enter: EnterCollaboration) {
  return {
    presence: (input: PresenceInput): Promise<WorkflowPresence> =>
      enter(input, { browsing: true }, async (client) => {
        return readPresence(client, input);
      }),
    heartbeat: (input: HeartbeatInput): Promise<{ accepted: boolean }> =>
      enter(
        input,
        { lock: 'update', editing: input.editing },
        async (client) => {
          return heartbeatPresence(client, input);
        },
      ),
    leave: (input: PresenceInput): Promise<void> =>
      enter(input, {}, async (client) => {
        await leavePresence(client, input);
      }),
  };
}

/** A new tab joins only while the workflow and the person have room for it. */
async function heartbeatPresence(client: PoolClient, input: HeartbeatInput) {
  await pruneExpiredPresence(client, input);
  if (!(await holdsPresence(client, input))) {
    const counts = await countPresence(client, input);
    if (counts === undefined) throw new Error('Presence counts missing');
    if (
      counts.total >= COLLABORATION_LIMITS.presence ||
      counts.own >= COLLABORATION_LIMITS.tabs
    )
      throw new WorkflowCollaborationError(
        'limit',
        'Presence is full for this workflow. You can still edit and save normally.',
      );
  }
  return { accepted: await storePresence(client, input) };
}
