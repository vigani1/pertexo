import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useIsMutating, useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useState, type ComponentProps } from 'react';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import {
  HowItWorks,
  type HowItWorksStep,
} from '@/components/patterns/how-it-works';
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
import type { FailureNotificationDestinationList } from './failure-notifications.api';
import { destinationChannels } from './model/channel-names';
import { useSlackChannelNames } from './use-slack-channel-names';
import { roleLimitSentence } from '@/features/workspaces/roles.public';

type Lens = Readonly<{
  open: boolean;
  destinationId: string | undefined;
  session: number;
}>;

type ListRefresh = ComponentProps<typeof DestinationForm>['listRefresh'];

function isHidden(error: unknown): boolean {
  return (
    isNotFound(error) ||
    isForbidden(error) ||
    (isApiError(error) && error.status === 401)
  );
}

const HOW_ALERTS_WORK: readonly HowItWorksStep[] = [
  {
    title: 'A run goes wrong',
    body: 'It fails, times out or ends with an unknown outcome. Runs that succeed stay quiet.',
  },
  {
    title: 'Pertexo posts it',
    body: 'To the Slack channel or email address chosen in that workflow’s Settings, through one of this workspace’s connections.',
  },
  {
    title: 'Someone finds the run',
    body: 'The alert names the run, its workflow and version, what started it and the error code.',
  },
];

/**
 * The lens that adds (no destination) or edits one destination. Each opening
 * is a new session, so the form starts from the destination as it is now;
 * it can't be closed while a save is in flight.
 */
function useDestinationLens(saving: boolean) {
  const [lens, setLens] = useState<Lens>({
    open: false,
    destinationId: undefined,
    session: 0,
  });
  return {
    lens,
    open: (destinationId?: string) => {
      setLens((current) => ({
        open: true,
        destinationId,
        session: current.session + 1,
      }));
    },
    close: () => {
      if (!saving) setLens((current) => ({ ...current, open: false }));
    },
    done: () => {
      setLens((current) => ({ ...current, open: false }));
    },
  };
}

/** The title, how many destinations there are and how many are on. */
function AlertsHeader({
  items,
  canManage,
  onAdd,
}: Readonly<{
  items: readonly FailureNotificationDestinationList['items'][number][];
  canManage: boolean;
  onAdd: () => void;
}>) {
  const enabledCount = items.filter((item) => item.status === 'enabled').length;
  return (
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
          <Button type="button" variant="primary" onClick={onAdd}>
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            Add destination
          </Button>
        </PageHeaderActions>
      ) : null}
    </PageHeader>
  );
}

/** The side sheet holding the add or edit form for the lens's destination. */
function DestinationSheet({
  lens,
  scope,
  items,
  connections,
  channelNames,
  listRefresh,
  onDone,
  onClose,
}: Readonly<
  Pick<
    ComponentProps<typeof DestinationForm>,
    'scope' | 'connections' | 'channelNames' | 'listRefresh'
  > & {
    lens: Lens;
    items: readonly FailureNotificationDestinationList['items'][number][];
    onDone: () => void;
    onClose: () => void;
  }
>) {
  return (
    <Sheet
      open={lens.open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent className="w-[min(28rem,calc(100vw-1.5rem))]">
        <DestinationForm
          key={lens.session}
          scope={scope}
          destination={items.find((item) => item.id === lens.destinationId)}
          connections={connections}
          channelNames={channelNames}
          listRefresh={listRefresh}
          onDone={onDone}
          onCancel={onClose}
        />
      </SheetContent>
    </Sheet>
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
  const can = (capability: AccessibleWorkspace['capabilities'][number]) =>
    workspace.capabilities.includes(capability);
  const canRead = can('workflow:update');
  const canManage = can('connection:manage');
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
    enabled: canRead && can('connection:read'),
  });
  const saving =
    useIsMutating({ mutationKey: destinationEditMutationKey(scope) }) > 0;
  const channelNames = useSlackChannelNames({
    apiClient,
    userId: user.id,
    workspaceId: workspace.id,
    channels: destinationChannels(destinations.data?.items ?? []),
    enabled: canRead && can('connection:use'),
  });
  const lens = useDestinationLens(saving);

  if (!canRead)
    return (
      <UnavailablePage
        heading="Alerts"
        title="Alerts are unavailable"
        description={roleLimitSentence(
          workspace.role,
          'workflow:update',
          'manage alerts',
        )}
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
  const listRefresh: ListRefresh = {
    failed: destinations.isError,
    pending: destinations.isRefetching,
    updatedAt: destinations.dataUpdatedAt,
    reload: async () => (await destinations.refetch()).data?.items ?? [],
  };

  return (
    <div className="flex flex-col gap-8">
      <AlertsHeader
        items={items}
        canManage={canManage}
        onAdd={() => {
          lens.open();
        }}
      />
      <p className="-mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Pertexo sends an alert when a run fails, times out or ends with an
        unknown outcome. Add where it goes here, then choose it in a workflow’s
        settings.
      </p>

      <DestinationCollection
        query={destinations}
        items={items}
        connections={connections.data?.items ?? []}
        channelNames={channelNames}
        scope={scope}
        canManage={canManage}
        onAdd={() => {
          lens.open();
        }}
        onEdit={lens.open}
      />
      <HowItWorks
        title="How alerts work"
        className="border-t border-border pt-8"
        steps={HOW_ALERTS_WORK}
      />
      {canManage && connections.isError ? (
        <Notice role="alert" tone="warning">
          Connections couldn’t be loaded, so destinations can’t be added or
          edited right now. Alerts keep being sent.
        </Notice>
      ) : null}

      <DestinationSheet
        lens={lens.lens}
        scope={scope}
        items={items}
        connections={connections.data?.items ?? []}
        channelNames={channelNames}
        listRefresh={listRefresh}
        onDone={lens.done}
        onClose={lens.close}
      />
    </div>
  );
}
