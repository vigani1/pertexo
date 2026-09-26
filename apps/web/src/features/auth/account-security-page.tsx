import type { UserProfileResponse } from '@pertexo/contracts/schemas/identity-workspace';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ApiClient } from '@/lib/api/client';
import { accountSecurityQueryOptions } from './account-security.queries';
import { AccountEmailSection } from './components/account/account-email-section';
import { AccountFactsSection } from './components/account/account-facts-section';
import { AccountMethodsSection } from './components/account/account-methods-section';
import { AccountPasswordSection } from './components/account/account-password-section';
import { AccountProfileSection } from './components/account/account-profile-section';
import {
  AccountReadFailure,
  AccountRowsPending,
} from './components/account/account-section';
import { AccountSessionsSection } from './components/account/account-sessions-section';
import { accountReadFailure } from './model/account-failure';
import { Notice } from '@/components/ui/notice';

type LinkOutcome = 'returned' | 'failed';

function LinkOutcomeLine({ outcome }: Readonly<{ outcome: LinkOutcome }>) {
  return outcome === 'returned' ? (
    <Notice tone="info" glyph="live">
      You’re back from the provider. If it connected, it’s listed below.
    </Notice>
  ) : (
    <Notice tone="destructive">
      Connecting didn’t finish. Your existing sign-in methods still work.
    </Notice>
  );
}

/**
 * Your identity across workspaces: profile, how you sign in, and where you
 * are signed in. Rendered in the workspace shell and on its own page.
 */
export function AccountSecurityPage({
  apiClient,
  user,
  linkOutcome,
  workspaces,
  onProfileChanged,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  linkOutcome?: LinkOutcome;
  /** The person's workspaces, composed in by the route. */
  workspaces?: ReactNode;
  /** The profile changed: reload whatever shows the person. */
  onProfileChanged: () => void;
}>) {
  const security = useQuery(accountSecurityQueryOptions(apiClient, user.id));
  const securityFailure = security.isError ? (
    <AccountReadFailure
      message={accountReadFailure(security.error, 'sign-in methods')}
      retrying={security.isFetching}
      onRetry={() => void security.refetch()}
    />
  ) : null;

  return (
    <div className="flex w-full max-w-5xl flex-col gap-6">
      <PageHeader>
        <PageHeaderTitle>Account &amp; security</PageHeaderTitle>
      </PageHeader>
      <Tabs defaultValue={linkOutcome === undefined ? 'profile' : 'security'}>
        <TabsList aria-label="Account sections">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="security">Sign-in &amp; security</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
        </TabsList>
        <TabsContent value="profile" className="flex flex-col pt-6">
          <AccountProfileSection
            apiClient={apiClient}
            user={user}
            security={security.data}
            onProfileChanged={onProfileChanged}
          />
          {securityFailure}
          {security.data === undefined ? null : (
            <AccountEmailSection
              apiClient={apiClient}
              security={security.data}
            />
          )}
          {workspaces}
          <AccountFactsSection user={user} />
        </TabsContent>
        <TabsContent value="security" className="flex flex-col gap-4 pt-6">
          {linkOutcome === undefined ? null : (
            <LinkOutcomeLine outcome={linkOutcome} />
          )}
          {security.isPending ? (
            <AccountRowsPending label="Loading your sign-in methods…" />
          ) : security.isError ? (
            securityFailure
          ) : (
            <>
              <AccountMethodsSection
                apiClient={apiClient}
                userId={user.id}
                security={security.data}
              />
              <AccountPasswordSection
                apiClient={apiClient}
                userId={user.id}
                security={security.data}
              />
            </>
          )}
        </TabsContent>
        <TabsContent value="sessions" className="pt-6">
          <AccountSessionsSection apiClient={apiClient} userId={user.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
