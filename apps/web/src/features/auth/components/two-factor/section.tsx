import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AccountSecurityResponse } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { AccountSection } from '../account/section';
import { accountSecurityKeys } from '../../data/account-security.queries';
import { TwoFactorSetupDialog, type TwoFactorAction } from './setup-dialog';

export function AccountTwoFactorSection({
  apiClient,
  userId,
  security,
  readState,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  security: AccountSecurityResponse;
  readState: 'ready' | 'refreshing' | 'unavailable';
}>) {
  const [action, setAction] = useState<TwoFactorAction>();
  const queryClient = useQueryClient();
  const [closing, setClosing] = useState(false);
  async function refreshAndClose() {
    if (closing) return;
    setClosing(true);
    try {
      await queryClient.invalidateQueries({
        queryKey: accountSecurityKeys.scope(userId),
      });
    } finally {
      setAction(undefined);
      setClosing(false);
    }
  }
  const { enabled, recoveryCodesRemaining } = security.twoFactor;
  const hasPassword = security.methods.some(
    (method) => method.kind === 'password',
  );
  return (
    <AccountSection
      title="Two-factor sign-in"
      description="An authenticator code after your password. Your SSO or social provider manages its own verification."
    >
      <div className="flex flex-col items-start gap-4">
        <p className="text-sm">
          {readState === 'unavailable'
            ? 'Refresh your sign-in methods above to confirm the status.'
            : enabled
              ? `On · ${String(recoveryCodesRemaining)} recovery codes remaining`
              : 'Off'}
        </p>
        {readState !== 'unavailable' &&
        enabled &&
        recoveryCodesRemaining !== null &&
        recoveryCodesRemaining <= 2 ? (
          <Notice tone="warning">
            Only {recoveryCodesRemaining} recovery codes left. Get new codes
            before you need them.
          </Notice>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {enabled ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={readState !== 'ready'}
                onClick={() => {
                  setAction('regenerate');
                }}
              >
                Get new recovery codes
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={readState !== 'ready'}
                onClick={() => {
                  setAction('disable');
                }}
              >
                Turn off two-factor sign-in
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={!hasPassword || readState !== 'ready'}
              onClick={() => {
                setAction('enable');
              }}
            >
              Turn on two-factor sign-in
            </Button>
          )}
        </div>
        {!hasPassword ? (
          <p className="text-sm text-muted-foreground">
            Add a password above before setting this up.
          </p>
        ) : null}
      </div>
      {action === undefined ? null : (
        <TwoFactorSetupDialog
          apiClient={apiClient}
          action={action}
          closing={closing}
          onClose={() => {
            setAction(undefined);
          }}
          onComplete={() => void refreshAndClose()}
        />
      )}
    </AccountSection>
  );
}
