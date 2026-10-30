import type { StructuredLogger } from '@pertexo/observability';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import { API_RESPONSE_SECURITY_HEADERS } from '../../platform/http/response-security.js';
import type { WebhookResponseWaiter } from './wait.js';
import type { WebhookIngressTelemetry } from '../ingress/telemetry.js';
import { record } from '../ingress/reply.js';

type Acceptance = Readonly<{
  runId: string;
  replayed: boolean;
  responseWaitSeconds?: number;
}>;
export async function replyToAcceptedWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  {
    workspaceId,
    accepted,
    waiter,
    telemetry,
    logger,
  }: Readonly<{
    workspaceId: string;
    accepted: Acceptance;
    waiter: WebhookResponseWaiter;
    telemetry: WebhookIngressTelemetry;
    logger: StructuredLogger;
  }>,
): Promise<void> {
  const receipt = { runId: accepted.runId, replayed: accepted.replayed };
  const seconds = accepted.responseWaitSeconds;
  if (seconds !== undefined) {
    try {
      const snapshot = await withRequestOperationSignal(request, (signal) =>
        waiter.wait({ workspaceId, runId: accepted.runId, seconds, signal }),
      );
      if (request.raw.socket.destroyed) return;
      if (snapshot?.state === 'responded') {
        const response = snapshot.response;
        for (const [name, value] of Object.entries(response.headers))
          reply.header(name, value);
        // After the workflow's headers: a row stored as XML before the step
        // stopped offering it is still a page a browser would run, so this
        // policy is what makes it safe.
        reply
          .headers(API_RESPONSE_SECURITY_HEADERS)
          .header('cache-control', 'no-store')
          .type(`${response.contentType}; charset=utf-8`)
          .code(response.statusCode);
        await reply.send(response.body);
        return;
      }
      if (snapshot?.state === 'failed') {
        await reply
          .header('cache-control', 'no-store')
          .code(500)
          .send({ code: 'webhook.workflow_failed' });
        return;
      }
    } catch (error: unknown) {
      // Admission already committed. A failed wait must not report rejection or retry execution.
      record(() => {
        telemetry.health('degraded');
      });
      // A sender that hung up ended its own wait; that is not a failure.
      if (!request.raw.socket.destroyed)
        record(() => {
          logger.error(
            'webhook.response_wait_failed',
            { workspaceId, runId: accepted.runId },
            error,
          );
        });
    }
  }
  if (!request.raw.socket.destroyed) await reply.code(202).send(receipt);
}
