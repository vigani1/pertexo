import { oauth2CallbackLandingSchema } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo } from 'react';
import { LANDING_TEXT, OAUTH2_CHANNEL } from '../model/oauth2-copy';

/**
 * Where a consent ends, in the tab it opened. It reads no data and needs no
 * session: it tells the tab that started consent, tries to close itself, and
 * says how it went if the browser keeps it open.
 */
export function OAuth2FinishedPage({ search }: Readonly<{ search: unknown }>) {
  const landing = useMemo(() => {
    const parsed = oauth2CallbackLandingSchema.safeParse(search);
    return parsed.success ? parsed.data : ({ result: 'invalid' } as const);
  }, [search]);

  useEffect(() => {
    const channel = new BroadcastChannel(OAUTH2_CHANNEL);
    channel.postMessage(landing);
    channel.close();
    window.close();
  }, [landing]);

  return (
    <main
      id="main"
      className="relative grid min-h-svh place-items-center bg-background px-5"
    >
      <div className="ambient" aria-hidden="true" />
      <div className="relative z-10 flex max-w-md flex-col gap-4 text-center">
        <p className="text-lg text-pretty">{LANDING_TEXT[landing.result]}</p>
        {landing.result === 'invalid' ? null : (
          <Link
            to="/w/$workspaceId/connections"
            params={{ workspaceId: landing.workspaceId }}
            search={{ connection: landing.connectionId }}
            className="text-sm text-accent-foreground underline-offset-3 hover:underline"
          >
            Open this connection
          </Link>
        )}
      </div>
    </main>
  );
}
