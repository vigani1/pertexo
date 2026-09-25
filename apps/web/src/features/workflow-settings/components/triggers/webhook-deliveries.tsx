import type { WebhookDeliveryResponse } from '@pertexo/contracts/schemas/webhooks';
import { useInfiniteQuery } from '@tanstack/react-query';
import { RecentLog, RecentLogEntry } from '@/components/patterns/recent-log';
import type { ApiClient } from '@/lib/api/client';
import { formatByteLength } from '@/lib/format-bytes';
import { describeDelivery } from '../../model/delivery-outcome';
import { webhookDeliveriesInfiniteQueryOptions } from '../../workflow-settings.queries';
import { RunLink } from './run-link';

function DeliveryEntry({
  delivery,
  workspaceId,
}: Readonly<{ delivery: WebhookDeliveryResponse; workspaceId: string }>) {
  const outcome = describeDelivery(delivery);
  const size =
    delivery.byteLength === null
      ? ''
      : ` · ${formatByteLength(delivery.byteLength)}`;
  return (
    <RecentLogEntry
      tone={outcome.tone}
      label={outcome.label}
      detail={outcome.detail}
      action={
        delivery.runId === null ? undefined : (
          <RunLink workspaceId={workspaceId} runId={delivery.runId} />
        )
      }
      at={delivery.receivedAt}
      meta={`HTTP ${String(delivery.httpStatus)}${size}`}
    />
  );
}

/**
 * What happened to each request a sender posted to one webhook, newest
 * first. Metadata only: bodies, headers and signatures are never kept.
 */
export function WebhookDeliveries({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  triggerId,
  endpointReady,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  triggerId: string;
  endpointReady: boolean;
}>) {
  const deliveries = useInfiniteQuery(
    webhookDeliveriesInfiniteQueryOptions(
      apiClient,
      userId,
      workspaceId,
      workflowId,
      triggerId,
    ),
  );
  return (
    <RecentLog
      title="Recent deliveries"
      note="Kept for 90 days"
      subject="deliveries"
      loadMoreLabel="Load older deliveries"
      empty={
        endpointReady
          ? 'Nothing has arrived yet. Each request a sender posts to this endpoint shows up here with what happened to it.'
          : 'Nothing has arrived. Create an endpoint, and each request a sender posts to it shows up here.'
      }
      query={deliveries}
      items={deliveries.data?.pages.flatMap(({ items }) => items)}
      itemKey={(delivery) => delivery.id}
      renderItem={(delivery) => (
        <DeliveryEntry delivery={delivery} workspaceId={workspaceId} />
      )}
    />
  );
}
