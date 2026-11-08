import {
  oauth2CallbackLandingSchema,
  type ConnectionResponse,
} from '@pertexo/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getConnection } from '../data/connections.api';
import {
  useConnectionResultScope,
  type ConnectionMutationScope,
} from '../data/connections.mutations';
import { startOAuth2Authorization } from '../data/oauth2.api';
import { connectionCommandError } from '../model/connection-errors';
import { landingMessage, OAUTH2_CHANNEL } from '../model/oauth2-copy';

export type OAuth2ConsentState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'starting' }>
  | Readonly<{ kind: 'waiting' }>
  | Readonly<{ kind: 'blocked'; authorizationUrl: string }>
  | Readonly<{ kind: 'failed'; message: string }>
  | Readonly<{ kind: 'check-failed'; error: unknown }>;

const grantTimeOf = (connection: ConnectionResponse): string | undefined =>
  connection.authType === 'oauth2' && connection.status === 'active'
    ? connection.grant.authorizedAt
    : undefined;

const needsSignInWindow = (connection: ConnectionResponse): boolean =>
  connection.authType === 'oauth2' &&
  connection.oauth2.settings.grantType === 'authorization_code';

/**
 * One consent. The window opens inside the click, before anything awaits, because
 * browsers block it after that. The page stays where it is, so an unsaved editor
 * draft behind this sheet survives, and it moves on when the other tab reports back
 * or when focus returns, since a browser may not deliver the message.
 */
export function useOAuth2Consent(
  scope: ConnectionMutationScope,
  connection: ConnectionResponse | undefined,
  onConnected: (connection: ConnectionResponse) => void,
) {
  const resultScope = useConnectionResultScope(scope);
  const [checking, setChecking] = useState(false);
  const checkBusy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [state, setState] = useState<OAuth2ConsentState>({ kind: 'idle' });
  const grantBefore = useRef<string | undefined>(undefined);
  const notifyConnected = useRef(onConnected);
  useEffect(() => {
    notifyConnected.current = onConnected;
  }, [onConnected]);
  const connectionId = connection?.id;

  const refresh = useCallback(async () => {
    if (connectionId === undefined || checkBusy.current) return;
    const owner = resultScope();
    checkBusy.current = true;
    setChecking(true);
    try {
      const fresh = await getConnection(
        scope.apiClient,
        scope.workspaceId,
        connectionId,
      );
      if (!mounted.current) return;
      await owner.store(fresh);
      const grant = grantTimeOf(fresh);
      if (grant === undefined || grant === grantBefore.current) {
        setState({ kind: 'waiting' });
        return;
      }
      setState({ kind: 'idle' });
      notifyConnected.current(fresh);
    } catch (error) {
      if (mounted.current) setState({ kind: 'check-failed', error });
    } finally {
      checkBusy.current = false;
      if (mounted.current) setChecking(false);
    }
  }, [connectionId, scope.apiClient, scope.workspaceId, resultScope]);

  const listening =
    state.kind === 'waiting' ||
    state.kind === 'blocked' ||
    state.kind === 'check-failed';
  useEffect(() => {
    if (!listening) return undefined;
    const channel = new BroadcastChannel(OAUTH2_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const landing = oauth2CallbackLandingSchema.safeParse(event.data);
      if (!landing.success) return;
      // Naming no connection, it can only be the consent this tab is waiting on.
      if (!('connectionId' in landing.data)) {
        setState({ kind: 'failed', message: landingMessage(landing.data) });
        return;
      }
      if (landing.data.connectionId !== connectionId) return;
      if (landing.data.result === 'connected') {
        void refresh();
        return;
      }
      setState({ kind: 'failed', message: landingMessage(landing.data) });
    };
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      channel.close();
      window.removeEventListener('focus', onFocus);
    };
  }, [connectionId, listening, refresh]);

  const connect = useCallback(() => {
    if (connection === undefined) return;
    const owner = resultScope();
    grantBefore.current = grantTimeOf(connection);
    // Server to server has no sign-in page, so it opens no window.
    const popup = needsSignInWindow(connection)
      ? window.open('', '_blank')
      : null;
    setState({ kind: 'starting' });
    void (async () => {
      try {
        const started = await startOAuth2Authorization(
          scope.apiClient,
          scope.workspaceId,
          connection.id,
        );
        if (!mounted.current) {
          popup?.close();
          return;
        }
        if (started.kind === 'connected') {
          popup?.close();
          await owner.store(started.connection);
          setState({ kind: 'idle' });
          notifyConnected.current(started.connection);
          return;
        }
        if (popup === null) {
          setState({
            kind: 'blocked',
            authorizationUrl: started.authorizationUrl,
          });
          return;
        }
        // The service's pages get no way back into this tab.
        popup.opener = null;
        popup.location.href = started.authorizationUrl;
        setState({ kind: 'waiting' });
      } catch (error: unknown) {
        popup?.close();
        if (!mounted.current) return;
        setState({
          kind: 'failed',
          message: connectionCommandError(error, 'connect', connection.name),
        });
      }
    })();
  }, [connection, scope.apiClient, scope.workspaceId, resultScope]);

  return {
    state,
    connect,
    checking,
    checkAgain: () => {
      void refresh();
    },
  } as const;
}
