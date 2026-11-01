import { createHash } from 'node:crypto';

import { serializeBoundedPlainJson } from '@pertexo/database/primitives';

import type { CommandRequest } from './contract.js';

export const REPLAY_INPUT_BYTES = 65_536;
/** Request material is bounded by its largest field, a replay input, with room for the rest. */
const MATERIAL_BYTES = REPLAY_INPUT_BYTES * 2;

export function requestFingerprint(request: CommandRequest): string {
  const material = serializeBoundedPlainJson(
    {
      ...request.material,
      actorRef: request.actorRef,
      commandType: request.commandType,
      dryRun: request.dryRun,
      reason: request.reason,
      workspaceId: request.workspaceId,
    },
    MATERIAL_BYTES,
    'Operator command request',
  );
  return createHash('sha256').update(material).digest('hex');
}
