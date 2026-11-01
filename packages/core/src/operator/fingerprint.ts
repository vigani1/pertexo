import { createHash } from 'node:crypto';

import { serializeBoundedPlainJson } from '@pertexo/database/primitives';

import type { CommandRequest } from './contract.js';

/** Request material is bounded by the largest field, a 64 KiB replay input. */
const MATERIAL_BYTES = 131_072;

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
