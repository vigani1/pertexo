import { useEffect, useRef, useState, type RefObject } from 'react';
import type { AccountSecurityResponse } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/patterns/notices/inline-notice';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import { SettingRow } from '@/components/patterns/settings/row';
import { useAccountSecurityRefresh } from '../../data/account-security/account-security.mutations';
import { TwoFactorSetupDialog } from './setup-dialog';
import type { TwoFactorAction } from '../../data/two-factor/two-factor.mutations';
import { pluralWord } from '@/lib/format/count';

export type TwoFactorReadState = 'ready' | 'refreshing' | 'unavailable';

function recoveryWarning(
  security: AccountSecurityResponse,
  readState: TwoFactorReadState,
) {
  if (readState === 'unavailable' || !security.twoFactor.enabled)
    return undefined;
  return recoveryCodeCopy(security.twoFactor.recoveryCodesRemaining).warning;
}

export function AccountRecoveryAttention({
  security,
  readState,
  controlRef,
  onRegenerate,
}: Readonly<{
  security: AccountSecurityResponse;
  readState: TwoFactorReadState;
  controlRef: RefObject<HTMLButtonElement | null>;
  onRegenerate: () => void;
}>) {
  const warning = recoveryWarning(security, readState);
  if (warning === undefined) return null;
  return (
    <section
      aria-labelledby="account-needs-you"
      className="flex flex-col gap-2"
    >
      <RuleHeading id="account-needs-you">Needs you</RuleHeading>
      <Notice
        tone="warning"
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            ref={controlRef}
            disabled={readState !== 'ready'}
            onClick={onRegenerate}
          >
            Get new recovery codes
          </Button>
        }
      >
        {warning}
      </Notice>
    </section>
  );
}

export function AccountTwoFactorSection({
  apiClient,
  userId,
  security,
  readState,
  controlRef,
  action,
  onAction: setAction,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  security: AccountSecurityResponse;
  readState: TwoFactorReadState;
  controlRef: RefObject<HTMLButtonElement | null>;
  action: TwoFactorAction | undefined;
  onAction: (action: TwoFactorAction | undefined) => void;
}>) {
  const refreshSecurity = useAccountSecurityRefresh(userId);
  const [closing, setClosing] = useState(false);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (action !== undefined || readState !== 'ready' || !restoreFocus.current)
      return;
    restoreFocus.current = false;
    controlRef.current?.focus();
  }, [action, controlRef, readState]);

  async function refreshAndClose() {
    if (closing) return;
    setClosing(true);
    try {
      await refreshSecurity();
    } finally {
      // Completing enrollment can replace the button that opened the sheet.
      restoreFocus.current = true;
      setAction(undefined);
      setClosing(false);
    }
  }
  const { enabled, recoveryCodesRemaining } = security.twoFactor;
  const codes = recoveryCodeCopy(recoveryCodesRemaining);
  const status = enabled ? codes.status : 'Off';
  const hasPassword = security.methods.some(
    (method) => method.kind === 'password',
  );
  return (
    <SettingRow
      layout="section"
      title="Two-factor sign-in"
      description="An authenticator code after your password. Your SSO or social provider manages its own verification."
    >
      <div className="flex flex-col items-start gap-4">
        <p className="text-sm">
          {readState === 'unavailable'
            ? 'Refresh your sign-in methods above to confirm the status.'
            : status}
        </p>
        <div className="flex flex-wrap gap-2">
          {enabled ? (
            <>
              {recoveryWarning(security, readState) !== undefined ? null : (
                <Button
                  type="button"
                  variant="outline"
                  ref={controlRef}
                  disabled={readState !== 'ready'}
                  onClick={() => {
                    setAction('regenerate');
                  }}
                >
                  Get new recovery codes
                </Button>
              )}
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
              ref={controlRef}
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
    </SettingRow>
  );
}

function recoveryCodeCopy(remaining: number | null) {
  if (remaining === null) return { status: 'On', warning: undefined };
  const noun = pluralWord(remaining, 'code');
  const status = `On · ${String(remaining)} recovery ${noun} remaining`;
  if (remaining > 2) return { status, warning: undefined };
  return {
    status,
    warning:
      remaining === 0
        ? 'No recovery codes left. Get new codes now.'
        : `Only ${String(remaining)} recovery ${noun} left. Get new codes before you need them.`,
  };
}
