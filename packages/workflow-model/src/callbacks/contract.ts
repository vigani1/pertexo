import { z } from 'zod';
import { webhookAuthenticationSchema } from '../webhooks/authentication.js';
import { isHumanTaskDefinition } from '../pending-tasks/approval.js';

export const CALLBACKS_PER_STEP = 16;
export const WAIT_MAXIMUM_SECONDS = 2_592_000;
export const callbackWaitConfigSchema = z
  .object({
    mode: z.literal('callback'),
    timeoutSeconds: z.number().int().min(1).max(WAIT_MAXIMUM_SECONDS),
    authentication: webhookAuthenticationSchema.default({
      mode: 'secret_url',
      allowedOrigins: [],
    }),
  })
  .strict();
export type CallbackWaitConfig = z.output<typeof callbackWaitConfigSchema>;
export const waitConfigSchema = z.union([
  z
    .object({
      durationSeconds: z.number().int().min(1).max(WAIT_MAXIMUM_SECONDS),
    })
    .strict(),
  callbackWaitConfigSchema,
]);
export type CallbackBinding = Readonly<{ url: string; secret?: string }>;
export type CallbackBindings = Readonly<Record<string, CallbackBinding>>;
export function isCallbackWaitNode(
  node:
    | Readonly<{
        definition?: Readonly<{ key: string; version: number }> | undefined;
        config?: Readonly<Record<string, unknown>> | undefined;
      }>
    | undefined,
): boolean {
  return (
    node?.definition?.key === 'core.wait' &&
    node.definition.version === 1 &&
    node.config?.mode === 'callback'
  );
}
export function isPendingTaskNode(
  node:
    | Readonly<{
        definition?: Readonly<{ key: string; version: number }> | undefined;
        config?: Readonly<Record<string, unknown>> | undefined;
      }>
    | undefined,
): boolean {
  return isHumanTaskDefinition(node?.definition) || isCallbackWaitNode(node);
}
