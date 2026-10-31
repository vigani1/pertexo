import type { OAuth2ConnectionResponse } from '@pertexo/contracts';
import { ExternalLinkIcon } from 'lucide-react';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import type { useOAuth2Consent } from '../../hooks/use-oauth2-consent';
import { connectSentence } from '../../model/oauth2-copy';

type Consent = ReturnType<typeof useOAuth2Consent>;

/** Where a consent stands; nothing while no one has asked for one. */
export function OAuth2ConsentStatus({
  state,
}: Readonly<{ state: Consent['state'] }>) {
  switch (state.kind) {
    case 'idle':
    case 'starting':
      return null;
    case 'waiting':
      return (
        <p role="status" className="text-sm text-muted-foreground">
          Finish signing in in the window that opened.
        </p>
      );
    case 'blocked':
      return (
        <Notice tone="warning" title="Your browser blocked the window.">
          <a
            href={state.authorizationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium underline underline-offset-3"
          >
            Open sign-in page
            <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
          </a>
        </Notice>
      );
    case 'failed':
      return (
        <Notice role="alert" tone="destructive">
          {state.message}
        </Notice>
      );
  }
}

/** The step between saving a connection and testing it. */
export function OAuth2ConnectStep({
  connection,
  consent,
}: Readonly<{
  connection: OAuth2ConnectionResponse;
  consent: Consent;
}>) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">{connection.name}</span>{' '}
        is saved. {connectSentence(connection.oauth2.settings)}
      </p>
      <ProgressButton
        type="button"
        variant="primary"
        className="self-start"
        pending={consent.state.kind === 'starting'}
        pendingLabel="Opening…"
        onClick={consent.connect}
      >
        Connect
      </ProgressButton>
      <OAuth2ConsentStatus state={consent.state} />
    </div>
  );
}
