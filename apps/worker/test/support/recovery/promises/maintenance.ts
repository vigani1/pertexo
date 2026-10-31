import { QUEUE_NAME } from '@pertexo/queue';

import { RECOVERY_LIMIT_MS } from '../environment.js';
import { delay, waitForRunsToEnd } from '../facts.js';
import { failingStep, nextStep, startFlow } from '../flows.js';
import { httpChain, slackMessage, triggeredChain } from '../graphs.js';
import { pauseQueue, waitForPublished } from '../queues.js';
import { startStack, type Stack } from '../stack.js';
import { startMailbox, type Mailbox } from '../stand-ins/smtp.js';

const RUN_LIMIT_MS = 60_000;
// Past the 60 s a delivery has to be confirmed, so a replacement sent for a job
// that was not lost after all, or sent twice, would be seen.
export const QUIET_MS = 75_000;
const ALERT_CHANNEL = 'C0ALERTS';
const INVITED = 'promised-invitation@example.test';

export type MaintenancePromises = Readonly<{
  close: () => Promise<void>;
  stack: Stack;
  /** Waits until every promise is kept or the recovery limit passes, then stays. */
  settle: () => Promise<KeptPromises>;
}>;

/** What a user or operator can see of each promise, as stored and as delivered. */
export type KeptPromises = Readonly<{
  alert: string | undefined;
  alertsSent: number;
  errorWorkflowRuns: number;
  errorWorkflowSteps: number;
  connection: string | undefined;
  invitation: string | undefined;
  invitationsSent: number;
  replay: string | undefined;
  replayedSteps: number;
}>;

const allKept = (seen: KeptPromises): boolean =>
  seen.alert === 'delivered' &&
  seen.errorWorkflowRuns === 1 &&
  seen.connection === 'reauthorization_required' &&
  seen.invitation === 'submitted' &&
  seen.replay === 'completed';

/**
 * One workspace in which, with the maintenance queue paused, each job kind on
 * that queue gets published: a run that alerts, a run with an error workflow, an
 * operator replay, an invitation and a provider's answer about a connection.
 */
export async function publishMaintenancePromises(
  name: string,
): Promise<MaintenancePromises> {
  const mailbox: Mailbox = await startMailbox();
  const stack = await startStack(name, {
    slackFromSink: true,
    environment: {
      INVITATION_TOKEN_KEY: Buffer.alloc(32, 0x5a).toString('base64'),
      INVITATION_TOKEN_KEY_VERSION: 'recovery-v1',
    },
    workerEnvironment: {
      AUTH_MAIL_KEY: Buffer.alloc(32, 0x4b).toString('base64'),
      AUTH_MAIL_KEY_VERSION: 'recovery-v1',
      INVITATION_EMAIL_FROM: 'invites@example.test',
      SYSTEM_MAIL_SMTP_HOST: '127.0.0.1',
      SYSTEM_MAIL_SMTP_PORT: String(mailbox.port),
      SYSTEM_MAIL_SMTP_TLS: 'none',
      SYSTEM_MAIL_TRANSPORT: 'smtp',
    },
  });
  const workspace = await stack.api.createWorkspace(`recovery-${name}`);
  const slack = await stack.api.createSlackConnection(
    workspace,
    'xoxb-recovery-healthy-1',
  );
  const revoked = await stack.api.createSlackConnection(
    workspace,
    'xoxb-recovery-revoked-1',
  );

  const alerting = await stack.api.publish(
    workspace,
    'alerting',
    httpChain([failingStep(stack, 'alerting')]),
  );
  await stack.api.alertToSlack(workspace, alerting, slack, ALERT_CHANNEL);
  const handler = await stack.api.publish(
    workspace,
    'handler',
    triggeredChain({ key: 'core.workflow_error' }, [
      nextStep(stack, 'error-handled'),
    ]),
  );
  const erroring = await stack.api.publish(
    workspace,
    'erroring',
    httpChain([failingStep(stack, 'erroring')]),
  );
  await stack.api.setErrorWorkflow(workspace, erroring, handler);
  const source = await startFlow(stack, workspace, 'source', [
    nextStep(stack, 'replayed'),
  ]);
  await waitForRunEnd(stack, source);
  const [sourceRun] = await stack.sql<{ workflow_version_id: string }>(
    `select workflow_version_id from app.workflow_runs where id=$1`,
    [source],
  );
  const health = await stack.api.publish(
    workspace,
    'health',
    slackMessage(revoked, 'health check'),
  );

  await pauseQueue(stack, QUEUE_NAME.maintenance);

  const alertingRun = await stack.api.startRun(workspace, alerting);
  const erroringRun = await stack.api.startRun(workspace, erroring);
  const healthRun = await stack.api.startRun(workspace, health);
  await stack.api.invite(workspace, INVITED);
  const operator = stack.operator({
    OPERATOR_COMMAND_TYPE: 'run.replay',
    OPERATOR_DRY_RUN: 'false',
    OPERATOR_RUN_ID: source,
    OPERATOR_RUN_INPUT: '{}',
    OPERATOR_WORKFLOW_VERSION_ID: sourceRun?.workflow_version_id ?? '',
    OPERATOR_WORKSPACE_ID: workspace,
  });
  operator.startOnce();
  while (operator.exits.length === 0) await delay(100);
  if (operator.exits[0]?.code !== 0)
    throw new Error(`Replay refused: ${JSON.stringify(operator.logs)}`);
  const [command] = await stack.sql<{ command_id: string }>(
    `select command_id from app.operator_run_replay_requests where source_run_id=$1`,
    [source],
  );

  for (const run of [alertingRun, erroringRun, healthRun])
    await waitForRunEnd(stack, run);
  await waitForPublished(stack, {
    'apply-connection-health-observation': 1,
    'deliver-run-failure-notification': 1,
    'deliver-workspace-invitation': 1,
    'replay-workflow-run': 1,
    'start-error-workflow': 1,
  });

  const read = async (): Promise<KeptPromises> => ({
    alert: (
      await stack.sql<{ status: string }>(
        `select status from app.run_failure_notification_intents where workflow_run_id=$1`,
        [alertingRun],
      )
    )[0]?.status,
    alertsSent: stack.sink
      .calls('chat.postMessage')
      .filter(({ body }) => body.includes(ALERT_CHANNEL)).length,
    connection: (
      await stack.sql<{ status: string }>(
        `select status from app.connections where id=$1`,
        [revoked],
      )
    )[0]?.status,
    errorWorkflowRuns:
      (
        await stack.sql<{ count: number }>(
          `select count(*)::int as count from app.run_error_workflow_intents
            where source_run_id=$1 and status='accepted'`,
          [erroringRun],
        )
      )[0]?.count ?? 0,
    errorWorkflowSteps: stack.sink.calls('error-handled').length,
    invitation: (
      await stack.sql<{ delivery_status: string }>(
        `select delivery_status from app.workspace_invitations where workspace_id=$1`,
        [workspace],
      )
    )[0]?.delivery_status,
    invitationsSent: mailbox.messages().filter((to) => to === INVITED).length,
    replay: (
      await stack.sql<{ status: string }>(
        `select status from app.operator_run_replay_requests where command_id=$1`,
        [command?.command_id],
      )
    )[0]?.status,
    replayedSteps: stack.sink.calls('replayed').length,
  });

  return Object.freeze({
    stack,
    async settle() {
      const deadline = Date.now() + RECOVERY_LIMIT_MS;
      let seen = await read();
      while (!allKept(seen) && Date.now() < deadline) {
        await delay(1_000);
        seen = await read();
      }
      if (allKept(seen)) await delay(QUIET_MS);
      return read();
    },
    async close() {
      await stack.close();
      await mailbox.close();
    },
  });
}

async function waitForRunEnd(stack: Stack, runId: string): Promise<void> {
  const ended = await waitForRunsToEnd(stack, [runId], RUN_LIMIT_MS);
  if (['running', 'queued'].includes(ended[runId]?.status ?? 'queued'))
    throw new Error(`Run ${runId} never ended`);
}
