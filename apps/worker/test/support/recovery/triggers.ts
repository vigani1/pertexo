import type { WebhookKeys } from './api.js';
import { delay } from './facts.js';
import type { Stack } from './stack.js';

const READY_LIMIT_MS = 60_000;
const NOT_YET_RECONCILED = new Set(['desired', 'pending']);

/** What is stored about a workflow's trigger: its page lists only webhooks. */
export async function triggerStatus(
  stack: Stack,
  workflowId: string,
): Promise<string | undefined> {
  const [row] = await stack.sql<{ status: string }>(
    `select status from app.workflow_triggers where workflow_id=$1`,
    [workflowId],
  );
  return row?.status;
}

/** Waits until the published schedule has been turned on and has a next time. */
export async function waitForScheduleReady(
  stack: Stack,
  workflowId: string,
): Promise<void> {
  const deadline = Date.now() + READY_LIMIT_MS;
  while ((await triggerStatus(stack, workflowId)) !== 'active') {
    if (Date.now() > deadline)
      throw new Error(`The schedule of ${workflowId} was never turned on`);
    await delay(100);
  }
}

/**
 * Waits until the published webhook has been turned on, then takes the step an
 * owner takes on the settings page, which is what creates its URL and keys.
 */
export async function waitForWebhookKeys(
  stack: Stack,
  workspaceId: string,
  workflowId: string,
): Promise<WebhookKeys> {
  const deadline = Date.now() + READY_LIMIT_MS;
  for (;;) {
    const trigger = await stack.api.readTrigger(workspaceId, workflowId);
    if (!NOT_YET_RECONCILED.has(trigger.status)) {
      const provisioned = await stack.api.provisionWebhook(
        workspaceId,
        workflowId,
        trigger.id,
      );
      if (provisioned.status !== 200)
        throw new Error(`Provision answered ${String(provisioned.status)}`);
      return provisioned.json as WebhookKeys;
    }
    if (Date.now() > deadline)
      throw new Error(`Trigger of ${workflowId} stayed ${trigger.status}`);
    await delay(100);
  }
}
