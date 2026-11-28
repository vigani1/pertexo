import {
  autoPauseThresholdSchema,
  triggerPauseSnapshotSchema,
  STORED_INTEGER_MAX,
  STORED_TIMESTAMP_FRACTION_DIGITS,
} from '@pertexo/workflow-model';
import { z } from 'zod';

const revision = z.number().int().positive().max(STORED_INTEGER_MAX);

/** What an exact retry replays; a settings command writes these whole. */
export const workflowSettings = triggerPauseSnapshotSchema(
  revision,
  z.iso.datetime({ precision: STORED_TIMESTAMP_FRACTION_DIGITS }),
);

export const workspaceSettings = z
  .object({ threshold: autoPauseThresholdSchema, revision })
  .strict();
