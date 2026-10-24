import { useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { AccessibleWorkspace, ApiTokenMetadata } from '@pertexo/contracts';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Notice } from '@/components/ui/notice';
import type { ApiClient } from '@/lib/api/client';
import {
  apiTokenKeys,
  apiTokensQueryOptions,
} from '../data/api-tokens.queries';
import { CreateTokenDialog } from '../components/create-dialog';
import { RevokeTokenDialog } from '../components/revoke-dialog';
import { TokenResults } from '../components/results';

export function ApiTokensPage({
  apiClient,
  userId,
  workspace,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
}>) {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery(
    apiTokensQueryOptions(apiClient, userId, workspace.id),
  );
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiTokenMetadata>();
  const first = query.data?.pages[0];
  const canCreate =
    first !== undefined &&
    first.enabled &&
    first.availableScopes.length > 0 &&
    workspace.status === 'active';
  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: apiTokenKeys.list(userId, workspace.id),
    });
  };
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <PageHeader>
        <PageHeaderTitle>API tokens</PageHeaderTitle>
        <PageHeaderActions>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Refresh"
            title="Refresh"
            disabled={query.isFetching}
            onClick={refresh}
          >
            {query.isFetching ? (
              <LoadingOrb />
            ) : (
              <RefreshCwIcon aria-hidden="true" />
            )}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!canCreate}
            onClick={() => {
              setCreating(true);
            }}
          >
            Create token
          </Button>
        </PageHeaderActions>
      </PageHeader>
      <div className="flex max-w-2xl flex-col gap-2">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Personal keys for your scripts and the CLI in this workspace. Each
          grants an explicit part of your current access.
        </p>
        <Disclosure summary="How tokens work" size="xs">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-xs leading-relaxed text-muted-foreground">
            <li>Keep a token in a secrets manager; it is shown once.</li>
            <li>
              To replace one, create another, update the script, then revoke the
              old one.
            </li>
            <li>
              A change to your membership stops a token; signing out or a new
              password doesn't.
            </li>
          </ul>
        </Disclosure>
      </div>
      <div className="flex flex-col gap-4">
        {first?.enabled !== false ? null : (
          <Notice tone="warning">
            Automation tokens are disabled on this server. Ask the person
            running Pertexo to enable them. You can still list and revoke
            existing tokens.
          </Notice>
        )}
        {workspace.status === 'active' ? null : (
          <Notice tone="warning">
            New tokens need an active workspace. Existing tokens cannot
            authenticate while this workspace is inactive; you can still revoke
            them here.
          </Notice>
        )}
        <TokenResults query={query} onRevoke={setRevoking} />
      </div>
      {!creating || first === undefined ? null : (
        <CreateTokenDialog
          apiClient={apiClient}
          workspaceId={workspace.id}
          availableScopes={first.availableScopes}
          onRefresh={refresh}
          onClose={() => {
            setCreating(false);
          }}
        />
      )}
      {revoking === undefined ? null : (
        <RevokeTokenDialog
          key={revoking.id}
          apiClient={apiClient}
          userId={userId}
          workspaceId={workspace.id}
          token={revoking}
          onClose={() => {
            setRevoking(undefined);
          }}
        />
      )}
    </div>
  );
}
