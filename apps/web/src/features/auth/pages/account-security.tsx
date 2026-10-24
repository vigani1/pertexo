import { AccountAppearanceSection } from '../components/account/appearance';
import { AccountTwoFactorSection } from '../components/two-factor/section';
import type { UserProfileResponse } from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { accountSecurityQueryOptions } from '../data/account-security.queries';
import { AccountEmailSection } from '../components/account/email-section';
import { AccountFactsSection } from '../components/account/facts-section';
import { AccountMethodsSection } from '../components/account/methods-section';
import { AccountPasswordSection } from '../components/account/password-section';
import { AccountProfileSection } from '../components/account/profile/section';
import { AccountSessionsSection } from '../components/account/sessions-section';
import { Notice } from '@/components/ui/notice';
import { QueryView } from '@/components/patterns/states/query-view';
import { describeReadError } from '@/lib/api/error-copy';

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
/** A signed-out or refused answer hides sign-in methods loaded earlier. */
function signInMethodsHidden(error: unknown) {
  if (!isApiError(error) || (error.status !== 401 && error.status !== 403))
    return undefined;
  return (
    <Notice tone="destructive">
      {describeReadError(error, 'Your sign-in methods')}
    </Notice>
  );
}

function twoFactorReadState(
  security: Readonly<{ isFetching: boolean; isError: boolean }>,
) {
  if (security.isFetching) return 'refreshing';
  if (security.isError) return 'unavailable';
  return 'ready';
}

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
          <AccountAppearanceSection />
          <AccountProfileSection
            apiClient={apiClient}
            user={user}
            security={security.data}
            onProfileChanged={onProfileChanged}
          />
          <QueryView query={security} resource="Your sign-in methods">
            {(snapshot) => (
              <AccountEmailSection apiClient={apiClient} security={snapshot} />
            )}
          </QueryView>
          {workspaces}
          <AccountFactsSection user={user} />
        </TabsContent>
        <TabsContent value="security" className="flex flex-col gap-4 pt-6">
          {linkOutcome === undefined ? null : (
            <LinkOutcomeLine outcome={linkOutcome} />
          )}
          <QueryView
            query={security}
            resource="Your sign-in methods"
            loading={
              <SkeletonRows label="Loading your sign-in methods" rows={2} />
            }
            failure={signInMethodsHidden}
          >
            {(snapshot) => (
              <>
                <AccountMethodsSection
                  apiClient={apiClient}
                  userId={user.id}
                  security={snapshot}
                />
                <AccountPasswordSection
                  apiClient={apiClient}
                  userId={user.id}
                  security={snapshot}
                />
                <AccountTwoFactorSection
                  readState={twoFactorReadState(security)}
                  apiClient={apiClient}
                  userId={user.id}
                  security={snapshot}
                />
              </>
            )}
          </QueryView>
        </TabsContent>
        <TabsContent value="sessions" className="pt-6">
          <AccountSessionsSection apiClient={apiClient} userId={user.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
