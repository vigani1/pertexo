import { useId } from 'react';
import type { WebhookDeliveryResponse } from '@pertexo/contracts/schemas/webhooks';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, RotateCcwIcon } from 'lucide-react';
import { LoadMore } from '@/components/patterns/load-more';
import { StaleLine } from '@/components/patterns/stale-line';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { SkeletonRows } from '@/components/ui/skeleton';
import { StatusGlyph } from '@/components/ui/status';
import { statusToneText } from '@/components/ui/status-tone';
import { describeReadError } from '@/lib/api/api-error-copy';
import type { ApiClient } from '@/lib/api/client';
import { formatByteLength } from '@/lib/format-bytes';
import { formatDateTime, formatRelativeTime } from '@/lib/format-time';
import { cn } from '@/lib/utils';
import { describeDelivery } from '../../model/delivery-outcome';
import { webhookDeliveriesInfiniteQueryOptions } from '../../workflow-settings.queries';

function DeliveryRow({
  delivery,
  workspaceId,
}: Readonly<{ delivery: WebhookDeliveryResponse; workspaceId: string }>) {
  const outcome = describeDelivery(delivery);
  const size =
    delivery.byteLength === null
      ? ''
      : ` · ${formatByteLength(delivery.byteLength)}`;
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-t border-border py-2.5 first:border-t-0">
      <StatusGlyph
        tone={outcome.tone}
        className={cn('mt-0.5', statusToneText[outcome.tone])}
      />
      <div className="min-w-0">
        <p className="text-sm font-medium">{outcome.label}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {outcome.detail}
        </p>
        {delivery.runId === null ? null : (
          <Link
            to="/w/$workspaceId/runs/$runId"
            params={{ workspaceId, runId: delivery.runId }}
            className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            Open run
            <ArrowRightIcon aria-hidden="true" className="size-3" />
          </Link>
        )}
      </div>
      <p className="flex flex-col items-end gap-0.5 text-right font-mono text-[0.72rem] text-subtle-foreground">
        <time
          dateTime={delivery.receivedAt}
          title={formatDateTime(delivery.receivedAt)}
        >
          {formatRelativeTime(delivery.receivedAt)}
        </time>
        <span>{`HTTP ${String(delivery.httpStatus)}${size}`}</span>
      </p>
    </li>
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
  const headingId = useId();
  const deliveries = useInfiniteQuery(
    webhookDeliveriesInfiniteQueryOptions(
      apiClient,
      userId,
      workspaceId,
      workflowId,
      triggerId,
    ),
  );
  const items = deliveries.data?.pages.flatMap(({ items: page }) => page);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h4 id={headingId} className="text-sm font-semibold">
          Recent deliveries
        </h4>
        <span className="font-mono text-[0.72rem] text-subtle-foreground">
          Kept for 90 days
        </span>
      </div>
      {deliveries.isPending ? (
        <SkeletonRows label="Loading recent deliveries" rows={2} />
      ) : null}
      {deliveries.isError && items === undefined ? (
        <Notice
          tone="destructive"
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={deliveries.isFetching}
              onClick={() => void deliveries.refetch()}
            >
              <RotateCcwIcon aria-hidden="true" data-icon="inline-start" />
              Retry
            </Button>
          }
        >
          {describeReadError(deliveries.error, 'Recent deliveries')}
        </Notice>
      ) : null}
      {deliveries.isError &&
      items !== undefined &&
      !deliveries.isFetchNextPageError ? (
        <StaleLine
          updatedAt={deliveries.dataUpdatedAt}
          retrying={deliveries.isRefetching}
          onRetry={() => void deliveries.refetch()}
        />
      ) : null}
      {items?.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {endpointReady
            ? 'Nothing has arrived yet. Each request a sender posts to this endpoint shows up here with what happened to it.'
            : 'Nothing has arrived. Create an endpoint, and each request a sender posts to it shows up here.'}
        </p>
      ) : null}
      {items === undefined || items.length === 0 ? null : (
        <ul aria-labelledby={headingId} className="flex flex-col">
          {items.map((delivery) => (
            <DeliveryRow
              key={delivery.id}
              delivery={delivery}
              workspaceId={workspaceId}
            />
          ))}
        </ul>
      )}
      <LoadMore
        subject="deliveries"
        label="Load older deliveries"
        hasNextPage={deliveries.hasNextPage}
        loading={deliveries.isFetchingNextPage}
        failed={deliveries.isFetchNextPageError}
        onLoadMore={() => void deliveries.fetchNextPage()}
      />
    </section>
  );
}
