import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { AuroraLoadingPanel } from '@/components/patterns/aurora-loading-panel';
import {
  GlassSection,
  GlassSectionContent,
  GlassSectionDescription,
  GlassSectionHeader,
  GlassSectionTitle,
} from '@/components/patterns/glass-section';
import { authenticationErrorMessage } from './auth-errors';
import { startOidcLogin } from './auth.api';

type LoginPageProps = Readonly<{
  apiClient: ApiClient;
  navigateToProvider: (authorizationUrl: string) => void;
}>;

export function LoginPage({ apiClient, navigateToProvider }: LoginPageProps) {
  const navigationStarted = useRef(false);
  const [navigationPending, setNavigationPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const login = useMutation({
    mutationFn: () => startOidcLogin(apiClient),
  });

  async function beginLogin() {
    if (login.isPending || navigationStarted.current) return;
    setMessage(undefined);
    try {
      const transaction = await login.mutateAsync();
      navigationStarted.current = true;
      setNavigationPending(true);
      navigateToProvider(transaction.authorizationUrl);
    } catch (error) {
      setMessage(authenticationErrorMessage(error));
    }
  }

  return (
    <main
      id="main"
      className="auth-stage relative grid min-h-svh place-items-center overflow-hidden px-5 py-10"
    >
      <div className="process-trace" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="relative z-10 flex w-full max-w-[28rem] flex-col gap-7">
        <header className="text-center">
          <p className="font-mono text-xs tracking-[0.22em] text-secondary">
            PERTEXO / CONTROL PLANE
          </p>
          <h1
            translate="no"
            className="mt-3 text-4xl font-semibold tracking-tight text-primary text-balance sm:text-5xl"
          >
            Pertexo<span className="text-secondary">.</span>
          </h1>
          <p className="mt-2 text-base text-muted-foreground">
            Precision workflow operations
          </p>
        </header>

        <AuroraLoadingPanel active={login.isPending}>
          <GlassSection
            aria-labelledby="login-title"
            aria-busy={login.isPending}
          >
            <GlassSectionHeader>
              <GlassSectionTitle id="login-title">
                Sign in to continue
              </GlassSectionTitle>
              <GlassSectionDescription>
                Use your organization’s identity provider. Pertexo never asks
                for your password here.
              </GlassSectionDescription>
            </GlassSectionHeader>
            <GlassSectionContent className="flex flex-col gap-5">
              {message ? (
                <p
                  role="alert"
                  className="rounded-lg border border-destructive/35 bg-destructive/10 px-4 py-3 text-sm leading-relaxed text-destructive"
                >
                  {message}
                </p>
              ) : null}
              <Button
                type="button"
                size="lg"
                className="w-full"
                disabled={login.isPending || navigationPending}
                onClick={() => void beginLogin()}
              >
                {login.isPending
                  ? 'Contacting identity provider…'
                  : 'Continue with SSO'}
              </Button>
              <p className="text-center text-xs leading-relaxed text-muted-foreground">
                Your session stays in secure browser cookies.
              </p>
            </GlassSectionContent>
          </GlassSection>
        </AuroraLoadingPanel>
      </div>
    </main>
  );
}
