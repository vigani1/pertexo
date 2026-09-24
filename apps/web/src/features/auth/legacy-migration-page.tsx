import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import { authenticationCapabilitiesQueryOptions } from './auth.queries';
import { MigrationSteps } from './components/migration/migration-steps';
import { SocialProviderGrid } from './components/social/social-provider-grid';
import {
  providerName,
  type SocialProvider,
} from './components/social/social-provider';
import {
  AuthLens,
  AuthLensDescription,
  AuthLensFooter,
  AuthLensTitle,
  AuthStatusLine,
} from './components/stage/auth-lens';
import { AuthStage } from './components/stage/auth-stage';
import { LensLoading } from './components/stage/lens-states';
import {
  startLegacyMethodMigration,
  type LegacyMigrationStart,
} from './legacy-migration.api';
import { formatCountdown } from '@/lib/format-time';
import { useCountdown } from '@/lib/use-countdown';
import { useLatestRequest } from './use-latest-request';

const WINDOW_MS = 5 * 60_000;

type Started = LegacyMigrationStart & Readonly<{ provider: SocialProvider }>;

export function LegacyMigrationPage({
  apiClient,
  navigateToProvider = (url) => {
    window.location.assign(url);
  },
}: Readonly<{
  apiClient: ApiClient;
  navigateToProvider?: (url: string) => void;
}>) {
  const capabilities = useQuery(
    authenticationCapabilitiesQueryOptions(apiClient),
  );
  const requests = useLatestRequest();
  const timeWindow = useCountdown();
  const [pending, setPending] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [started, setStarted] = useState<Started>();
  const windowOpen = started !== undefined && timeWindow.remainingSeconds > 0;
  const windowClosed = started !== undefined && !windowOpen;

  async function start(provider: SocialProvider) {
    const request = requests.begin();
    setPending(true);
    setFailure(undefined);
    setStarted(undefined);
    try {
      const result = await startLegacyMethodMigration(
        apiClient,
        provider,
        request.signal,
      );
      if (!request.isCurrent()) return;
      timeWindow.startUntil(
        Math.min(Date.parse(result.expiresAt), Date.now() + WINDOW_MS),
      );
      setStarted({ ...result, provider });
    } catch {
      if (request.isCurrent())
        setFailure(
          'Recovery couldn’t start. Your existing account was not changed. If your old sign-in no longer works, ask your Pertexo operator for help.',
        );
    } finally {
      if (request.finish()) setPending(false);
    }
  }

  if (capabilities.isPending)
    return (
      <AuthStage>
        <LensLoading
          title="Move your sign-in"
          label="Checking account recovery…"
        />
      </AuthStage>
    );
  const providers = capabilities.data?.socialProviders ?? [];
  const available =
    capabilities.data?.legacyMigrationAvailable === true &&
    providers.length > 0;

  return (
    <AuthStage>
      <AuthLens pending={pending || leaving} aria-labelledby="migrate-title">
        <AuthLensTitle id="migrate-title">Move your sign-in</AuthLensTitle>
        <AuthLensDescription>
          Keep your workspaces: prove the old account is yours, then choose how
          you’ll sign in from now on. A matching email alone can’t move them.
        </AuthLensDescription>
        <MigrationSteps current={windowOpen ? 'confirm' : 'choose'} />
        {!available ? (
          <AuthStatusLine tone="attention" className="mt-6">
            Automatic recovery isn’t available here. Ask your Pertexo operator
            to review your account.
          </AuthStatusLine>
        ) : windowOpen ? (
          <div className="mt-6 flex flex-col gap-3">
            <AuthStatusLine tone="waiting">
              You have{' '}
              <span className="font-mono tabular-nums">
                {formatCountdown(timeWindow.remainingSeconds)}
              </span>{' '}
              to confirm your old account. Then {providerName(started.provider)}{' '}
              confirms your new sign-in.
            </AuthStatusLine>
            <Button
              type="button"
              variant="primary"
              size="lg"
              className="w-full"
              disabled={leaving}
              onClick={() => {
                setLeaving(true);
                navigateToProvider(started.authorizationUrl);
              }}
            >
              Continue to your old sign-in
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-center"
              disabled={leaving}
              onClick={() => {
                timeWindow.clear();
                setStarted(undefined);
              }}
            >
              Choose a different method
            </Button>
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-3">
            {windowClosed ? (
              <AuthStatusLine tone="timeout">
                The 5-minute window closed. Choose your new sign-in again.
              </AuthStatusLine>
            ) : null}
            <SocialProviderGrid
              label="Choose your new sign-in"
              providers={providers}
              disabled={pending}
              onSelect={(provider) => void start(provider)}
            />
          </div>
        )}
        {failure === undefined ? null : (
          <AuthStatusLine tone="failure" className="mt-4">
            {failure}
          </AuthStatusLine>
        )}
        <AuthLensFooter>
          <Link to="/login">Back to sign in</Link>
        </AuthLensFooter>
      </AuthLens>
    </AuthStage>
  );
}
