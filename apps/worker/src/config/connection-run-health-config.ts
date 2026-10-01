import { z } from 'zod';

export type ConnectionRunHealthMode = 'off' | 'observe' | 'enforce';

const modeSchema = z.enum(['off', 'observe', 'enforce']).default('off');

export function parseConnectionRunHealthMode(
  value: unknown,
): ConnectionRunHealthMode {
  return modeSchema.parse(value);
}

export function parseConnectionRunHealthConfig(
  environment: Readonly<Record<string, unknown>>,
) {
  return {
    connectionRunHealthMode: parseConnectionRunHealthMode(
      environment.CONNECTION_RUN_HEALTH_MODE,
    ),
  };
}
