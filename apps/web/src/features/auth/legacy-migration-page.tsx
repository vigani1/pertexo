import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { AuroraLoadingPanel } from '@/components/patterns/aurora-loading-panel';
import {
  GlassSection,
  GlassSectionContent,
  GlassSectionDescription,
  GlassSectionHeader,
  GlassSectionTitle,
} from '@/components/patterns/glass-section';
import type { ApiClient } from '@/lib/api/client';
import { authenticationCapabilitiesQueryOptions } from './auth.queries';
import { AuthenticationShell } from './authentication-shell';
import { SocialProviderButton } from './components/social-provider-button';
import { startLegacyMethodMigration } from './legacy-migration.api';

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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = undefined;
    },
    [],
  );

  const start = async (
    provider: 'google' | 'github' | 'microsoft' | 'apple',
  ) => {
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(undefined);
    try {
      const url = await startLegacyMethodMigration(
        apiClient,
        provider,
        controller.signal,
      );
      if (active.current === controller && !controller.signal.aborted)
        navigateToProvider(url);
    } catch {
      if (active.current === controller && !controller.signal.aborted)
        setError(
          'Recovery could not start. Your existing account was not changed. Contact your Pertexo operator if the old identity provider is unavailable.',
        );
    } finally {
      if (active.current === controller) {
        active.current = undefined;
        setPending(false);
      }
    }
  };

  const available =
    capabilities.data?.legacyMigrationAvailable === true &&
    capabilities.data.socialProviders.length > 0;
  return (
    <AuthenticationShell>
      <AuroraLoadingPanel active={pending || capabilities.isPending}>
        <GlassSection aria-busy={pending || capabilities.isPending}>
          <GlassSectionHeader>
            <GlassSectionTitle>
              Recover an existing Pertexo account
            </GlassSectionTitle>
            <GlassSectionDescription>
              First confirm the identity you used before Pertexo changed
              sign-in. Then independently authorize a new provider in this
              browser. Your workspaces and user ID stay with the verified old
              identity; a matching email address alone cannot transfer them.
            </GlassSectionDescription>
          </GlassSectionHeader>
          <GlassSectionContent className="space-y-5">
            {capabilities.isPending ? (
              <p role="status" className="text-sm text-muted-foreground">
                Checking recovery availability…
              </p>
            ) : !available ? (
              <p role="alert" className="text-sm text-muted-foreground">
                Automated recovery is unavailable here. Ask your Pertexo
                operator for manual identity review; email ownership alone is
                not enough.
              </p>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Choose the new provider you want to use. The old identity
                  proof and new provider authorization must finish within five
                  minutes.
                </p>
                <div className="flex flex-wrap gap-2">
                  {capabilities.data?.socialProviders.map((provider) => (
                    <SocialProviderButton
                      key={provider}
                      provider={provider}
                      type="button"
                      disabled={pending}
                      onClick={() => void start(provider)}
                    />
                  ))}
                </div>
              </div>
            )}
            {error === undefined ? null : (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Link
              to="/login"
              className="text-sm font-medium text-primary hover:underline"
            >
              Back to sign in
            </Link>
          </GlassSectionContent>
        </GlassSection>
      </AuroraLoadingPanel>
    </AuthenticationShell>
  );
}
