import type { AccountSecurityResponse } from '@pertexo/contracts/schemas/identity-workspace';
import { KeyRoundIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { Button } from '@/components/ui/button';
import { useNotifications } from '@/components/ui/use-notifications';
import { isApiError } from '@/lib/api/api-error';
import type { ApiClient } from '@/lib/api/client';
import { useUnlinkAccountMethod } from '../../account-security.mutations';
import { ProviderMark } from '../social/social-provider-button';
import { isSocialProvider, providerName } from '../../model/social-provider';
import { accountCommandFailure } from '../../model/account-failure';
import { AccountSection, FreshSignInLink } from './account-section';
import { LinkProviderDialog } from './link-provider-dialog';

type Method = AccountSecurityResponse['methods'][number];

function methodName(method: Method): string {
  return method.kind === 'password'
    ? 'Password'
    : providerName(method.provider ?? 'Provider');
}

function MethodMark({ method }: Readonly<{ method: Method }>) {
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-md border border-white/10 bg-white/[0.035] text-muted-foreground">
      {isSocialProvider(method.provider) ? (
        <ProviderMark provider={method.provider} />
      ) : (
        <KeyRoundIcon aria-hidden="true" className="size-4" />
      )}
    </span>
  );
}

/** The ways this account signs in, with add and (confirmed) remove. */
export function AccountMethodsSection({
  apiClient,
  userId,
  security,
  navigateToProvider = (url) => {
    window.location.assign(url);
  },
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  security: AccountSecurityResponse;
  navigateToProvider?: (url: string) => void;
}>) {
  const [adding, setAdding] = useState(false);
  const [methodToRemove, setMethodToRemove] = useState<Method>();
  const unlink = useUnlinkAccountMethod(apiClient, userId);
  const notifications = useNotifications();
  const connected = new Set(security.methods.map((method) => method.provider));
  const linkable = security.availableProviders.filter(
    (provider) => !connected.has(provider),
  );
  const onlyMethod = security.methods.length <= 1;

  function closeRemoval() {
    if (unlink.isPending) return;
    unlink.reset();
    setMethodToRemove(undefined);
  }

  return (
    <AccountSection
      id="account-methods-title"
      title="Sign-in methods"
      description="Every way you can sign in to Pertexo."
      action={
        linkable.length === 0 ? undefined : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setAdding(true);
            }}
          >
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            Add a sign-in method
          </Button>
        )
      }
    >
      <ul
        aria-label="Sign-in methods"
        className="divide-y divide-border rounded-lg border border-border"
      >
        {security.methods.map((method) => (
          <li
            key={method.id}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
          >
            <div className="flex min-w-0 items-center gap-3">
              <MethodMark method={method} />
              <div className="min-w-0">
                <p className="text-sm font-semibold">{methodName(method)}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {method.kind === 'password'
                    ? security.email
                    : 'Connected account'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {onlyMethod ? (
                <span
                  id={`method-${method.id}-reason`}
                  className="text-xs text-subtle-foreground"
                >
                  Your only way to sign in
                </span>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={`Remove ${methodName(method)}`}
                aria-describedby={
                  onlyMethod ? `method-${method.id}-reason` : undefined
                }
                disabled={onlyMethod || unlink.isPending}
                onClick={() => {
                  unlink.reset();
                  setMethodToRemove(method);
                }}
              >
                Remove
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {adding ? (
        <LinkProviderDialog
          key={userId}
          apiClient={apiClient}
          providers={linkable}
          methods={security.methods}
          navigateToProvider={navigateToProvider}
          onClose={() => {
            setAdding(false);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={methodToRemove !== undefined}
        onOpenChange={(open) => {
          if (!open) closeRemoval();
        }}
        title="Remove sign-in method?"
        description={`You won’t be able to sign in with ${
          methodToRemove === undefined ? 'it' : methodName(methodToRemove)
        } any more. Other devices will be signed out; this one stays signed in.`}
        tone="destructive"
        confirmLabel="Remove method"
        pendingLabel="Removing…"
        cancelLabel="Keep method"
        pending={unlink.isPending}
        confirmDisabled={methodToRemove === undefined}
        error={
          unlink.error === null
            ? undefined
            : isApiError(unlink.error) &&
                (unlink.error.status === 400 || unlink.error.status === 409)
              ? 'This method can’t be removed. Keep at least one way to sign in.'
              : accountCommandFailure(unlink.error, 'removing this method')
        }
        errorAction={<FreshSignInLink error={unlink.error} />}
        onConfirm={async () => {
          if (methodToRemove === undefined) return;
          const name = methodName(methodToRemove);
          await unlink.mutateAsync(methodToRemove.id);
          setMethodToRemove(undefined);
          notifications.success({ title: `${name} removed` });
        }}
      />
    </AccountSection>
  );
}
