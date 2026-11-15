import { decodeStoredValue } from '../../../shared/stored-values.js';
import {
  approvalConfigSchema,
  inputRequestConfigSchema,
  taskContextSchema,
  taskExpiryChoice,
  timedOutTaskOutput,
} from '@pertexo/workflow-model';

export type ExpiredTask = Readonly<{
  kind: string;
  config: unknown;
  context: unknown;
  created_at: Date;
  expires_at: Date;
}>;

/**
 * The output an expired task leaves when its step continues on Timed out, or
 * undefined when the step fails its Wait instead.
 */
export function timedOutOutput(row: ExpiredTask) {
  const setup = timeoutSetup(row);
  if (setup === undefined || taskExpiryChoice(setup) !== 'continue')
    return undefined;
  return timedOutTaskOutput({
    openedAt: row.created_at,
    expiredAt: row.expires_at,
    audience: setup.audience,
    context: decodeStoredValue(() => taskContextSchema.parse(row.context)),
  });
}

/** Callbacks have no Timed out path; they always fail their Wait on expiry. */
function timeoutSetup(row: Readonly<{ kind: string; config: unknown }>) {
  if (row.kind === 'approval')
    return decodeStoredValue(() => approvalConfigSchema.parse(row.config));
  if (row.kind === 'input_request')
    return decodeStoredValue(() => inputRequestConfigSchema.parse(row.config));
  return undefined;
}
