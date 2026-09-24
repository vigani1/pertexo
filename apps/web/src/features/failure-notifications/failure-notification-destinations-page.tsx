import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useIsMutating, useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { UnavailablePage } from '@/components/patterns/unavailable-page';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { connectionDiscoveryQueryOptions } from '@/features/connections/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { isForbidden, isNotFound } from '@/lib/api/api-error-copy';
import { isApiError } from '@/lib/api/api-error';
import { DestinationCollection } from './components/destination-collection';
import { DestinationForm } from './components/destination-lens';
import { destinationEditMutationKey } from './failure-notifications.mutations';
import { failureNotificationDestinationsQueryOptions } from './failure-notifications.queries';

type Lens = Readonly<{
  open: boolean;
  destinationId: string | undefined;
  session: number;
}>;

function isHidden(error: unknown): boolean {
  return (
    isNotFound(error) ||
    isForbidden(error) ||
    (isApiError(error) && error.status === 401)
  );
}

/** Decide where Pertexo speaks up when a run fails. */
export function FailureNotificationDestinationsPage({
  apiClient,
  user,
  workspace,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
}>) {
  const canRead = workspace.capabilities.includes('workflow:update');
  const canManage = workspace.capabilities.includes('connection:manage');
  const canReadConnections = workspace.capabilities.includes('connection:read');
  const scope = { apiClient, userId: user.id, workspaceId: workspace.id };
  const destinations = useQuery({
    ...failureNotificationDestinationsQueryOptions(
      apiClient,
      user.id,
      workspace.id,
    ),
    enabled: canRead,
  });
  const connections = useQuery({
    ...connectionDiscoveryQueryOptions(apiClient, user.id, workspace.id),
    enabled: canRead && canReadConnections,
  });
  const saving =
    useIsMutating({ mutationKey: destinationEditMutationKey(scope) }) > 0;
  const [lens, setLens] = useState<Lens>({
    open: false,
    destinationId: undefined,
    session: 0,
  });

  if (!canRead)
    return (
      <UnavailablePage
        heading="Alerts"
        title="Alerts are unavailable"
        description="Your role can’t manage alerts. Builders, admins and owners can."
      />
    );
  if (destinations.isError && isHidden(destinations.error))
    return (
      <UnavailablePage
        heading="Alerts"
        title="Alerts are unavailable"
        description="This workspace’s alert destinations don’t exist, or you don’t have access to them."
      />
    );

  const items = destinations.data?.items ?? [];
  const enabledCount = items.filter((item) => item.status === 'enabled').length;
  const open = (destinationId?: string) => {
    setLens((current) => ({
      open: true,
      destinationId,
      session: current.session + 1,
    }));
  };
  const close = () => {
    if (!saving) setLens((current) => ({ ...current, open: false }));
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader>
        <div>
          <PageHeaderTitle>Alerts</PageHeaderTitle>
          {items.length > 0 ? (
            <PageHeaderMeta>
              <span>
                <b className="text-foreground">{items.length}</b>{' '}
                {items.length === 1 ? 'destination' : 'destinations'}
              </span>
              <span>
                <b className="text-foreground">{enabledCount}</b> on
              </span>
            </PageHeaderMeta>
          ) : null}
        </div>
        {canManage && items.length > 0 ? (
          <PageHeaderActions>
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                open();
              }}
            >
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              Add destination
            </Button>
          </PageHeaderActions>
        ) : null}
      </PageHeader>
      <p className="-mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Pertexo sends an alert when a run fails, times out or ends with an
        unknown outcome. Add where it goes here, then choose it in a workflow’s
        settings.
      </p>

      <DestinationCollection
        query={destinations}
        items={items}
        connections={connections.data?.items ?? []}
        scope={scope}
        canManage={canManage}
        onAdd={() => {
          open();
        }}
        onEdit={open}
      />
      {canManage && connections.isError ? (
        <Notice role="alert" tone="warning">
          Connections couldn’t be loaded, so destinations can’t be added or
          edited right now. Alerts keep being sent.
        </Notice>
      ) : null}

      <Sheet
        open={lens.open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <SheetContent className="w-[min(28rem,calc(100vw-1.5rem))]">
          <DestinationForm
            key={lens.session}
            scope={scope}
            destination={items.find((item) => item.id === lens.destinationId)}
            connections={connections.data?.items ?? []}
            listRefresh={{
              failed: destinations.isError,
              pending: destinations.isRefetching,
              updatedAt: destinations.dataUpdatedAt,
              reload: async () =>
                (await destinations.refetch()).data?.items ?? [],
            }}
            onDone={() => {
              setLens((current) => ({ ...current, open: false }));
            }}
            onCancel={close}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}
