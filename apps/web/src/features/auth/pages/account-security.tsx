import { AccountAppearanceSection } from '../components/account/appearance';
import {
  AccountRecoveryAttention,
  AccountTwoFactorSection,
  type TwoFactorReadState,
} from '../components/two-factor/section';
import type {
  AccountSecurityResponse,
  UserProfileResponse,
} from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { TwoFactorAction } from '../data/two-factor/two-factor.mutations';
import { SkeletonRows } from '@/components/patterns/states/loading';
import { Link } from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button-variants';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import type { ApiClient } from '@/lib/api/client';
import { accountSecurityQueryOptions } from '../data/account-security/account-security.queries';
import { AccountFactsSection } from '../components/account/facts-section';
import { AccountMethodsSection } from '../components/account/methods-section';
import { AccountPasswordSection } from '../components/account/password-section';
import { AccountProfileSection } from '../components/account/profile/section';
import { AccountSessionsSection } from '../components/account/sessions-section';
import { Notice } from '@/components/patterns/notices/inline-notice';
import { QueryView } from '@/components/patterns/states/query-view';

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
    <div className="flex w-full max-w-190 flex-col gap-8">
      <AccountProfileSection
        apiClient={apiClient}
        user={user}
        security={security.data}
        onProfileChanged={onProfileChanged}
      />
      {linkOutcome === undefined ? null : (
        <LinkOutcomeLine outcome={linkOutcome} />
      )}
      <QueryView
        query={security}
        resource="Your sign-in methods"
        loading={<SkeletonRows label="Loading your sign-in methods" rows={2} />}
      >
        {(snapshot) => (
          <AccountSignInSettings
            apiClient={apiClient}
            userId={user.id}
            readState={twoFactorReadState(security)}
            snapshot={snapshot}
          />
        )}
      </QueryView>
      <AccountSessionsSection apiClient={apiClient} userId={user.id} />
      <AccountAppearanceSection />
      {workspaces}
      <AccountFactsSection user={user} />
      <div>
        <Link to="/logout" className={buttonVariants({ variant: 'outline' })}>
          Sign out
        </Link>
      </div>
    </div>
  );
}

function AccountSignInSettings({
  apiClient,
  userId,
  snapshot,
  readState,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  snapshot: AccountSecurityResponse;
  readState: TwoFactorReadState;
}>) {
  const [action, setAction] = useState<TwoFactorAction>();
  return (
    <>
      <AccountRecoveryAttention
        security={snapshot}
        readState={readState}
        onRegenerate={() => {
          setAction('regenerate');
        }}
      />
      <section aria-labelledby="account-methods">
        <RuleHeading id="account-methods">How you sign in</RuleHeading>
        <AccountPasswordSection
          apiClient={apiClient}
          userId={userId}
          security={snapshot}
        />
        <AccountTwoFactorSection
          apiClient={apiClient}
          userId={userId}
          security={snapshot}
          readState={readState}
          action={action}
          onAction={setAction}
        />
        <AccountMethodsSection
          apiClient={apiClient}
          userId={userId}
          security={snapshot}
        />
      </section>
    </>
  );
}
