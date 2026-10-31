import type { OAuth2ConnectionResponse } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ConnectionMutationScope } from '../../data/connections.mutations';
import { useOAuth2Consent } from '../../hooks/use-oauth2-consent';
import { connectLabel, oauth2Notice } from '../../model/oauth2-copy';
import { OAuth2ConsentStatus } from './connect';

/** OAuth2 asks for consent, not a pasted replacement, to get working again. */
export function OAuth2OverviewActions({
  scope,
  connection,
  canTest,
  canManage,
  onMode,
}: Readonly<{
  scope: ConnectionMutationScope;
  connection: OAuth2ConnectionResponse;
  canTest: boolean;
  canManage: boolean;
  onMode: (mode: 'test' | 'replace' | 'sharing') => void;
}>) {
  const notifications = useNotifications();
  const consent = useOAuth2Consent(scope, connection, () => {
    notifications.success({ title: `Connected ${connection.name}` });
  });
  const reconnect = connection.status === 'reauthorization_required';
  const notice = reconnect ? oauth2Notice(connection) : undefined;
  return (
    <>
      {notice === undefined ? null : <Notice tone="warning">{notice}</Notice>}
      <div className="flex flex-wrap gap-2">
        {canTest ? (
          <Button
            type="button"
            variant={reconnect ? 'outline' : 'default'}
            onClick={() => {
              onMode('test');
            }}
          >
            Test
          </Button>
        ) : null}
        {canManage ? (
          <>
            <ProgressButton
              type="button"
              variant={reconnect ? 'primary' : 'outline'}
              pending={consent.state.kind === 'starting'}
              pendingLabel="Opening…"
              onClick={consent.connect}
            >
              {connectLabel(connection)}
            </ProgressButton>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onMode('replace');
              }}
            >
              Edit settings
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onMode('sharing');
              }}
            >
              Share
            </Button>
          </>
        ) : null}
      </div>
      <OAuth2ConsentStatus state={consent.state} />
    </>
  );
}
