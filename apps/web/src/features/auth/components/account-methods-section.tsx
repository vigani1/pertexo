import type { AccountSecurityResponse } from '@pertexo/contracts/schemas/identity-workspace';
import { useState } from 'react';
import {
  GlassSection,
  GlassSectionContent,
  GlassSectionDescription,
  GlassSectionHeader,
  GlassSectionTitle,
} from '@/components/patterns/glass-section';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import { useUnlinkAccountMethod } from '../account-security.mutations';
import { LinkProviderDialog } from './link-provider-dialog';
import { ProviderMark } from './social-provider-button';
import { isSocialProvider, providerName } from './social-provider';

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
  const [providerToLink, setProviderToLink] = useState<
    AccountSecurityResponse['availableProviders'][number] | undefined
  >();
  const [methodToRemove, setMethodToRemove] = useState<
    AccountSecurityResponse['methods'][number] | undefined
  >();
  const unlink = useUnlinkAccountMethod(apiClient, userId);
  const connectedProviders = new Set(
    security.methods.flatMap((method) =>
      method.provider === null ? [] : [method.provider],
    ),
  );
  const linkableProviders = security.availableProviders.filter(
    (provider) => !connectedProviders.has(provider),
  );
  const busy = unlink.isPending;

  return (
    <GlassSection>
      <GlassSectionHeader>
        <GlassSectionTitle>Sign-in methods</GlassSectionTitle>
        <GlassSectionDescription>
          Review the methods already attached to this account. Adding another
          provider requires fresh proof of an existing method and a separate
          provider authorization; matching email addresses alone never link
          accounts.
        </GlassSectionDescription>
      </GlassSectionHeader>
      <GlassSectionContent className="space-y-5">
        <ul
          className="divide-y divide-border"
          aria-label="Authentication methods"
        >
          {security.methods.map((method) => (
            <li
              key={method.id}
              className="flex items-center justify-between gap-4 py-3"
            >
              <div className="flex items-center gap-3">
                {!isSocialProvider(method.provider) ? null : (
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.035]">
                    <ProviderMark provider={method.provider} />
                  </span>
                )}
                <div>
                  <p className="font-medium">
                    {method.kind === 'password'
                      ? 'Password'
                      : providerName(method.provider ?? 'social')}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {method.kind === 'password'
                      ? security.email
                      : 'Verified external identity'}
                  </p>
                </div>
              </div>
              {security.methods.length > 1 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    unlink.reset();
                    setMethodToRemove(method);
                  }}
                >
                  Remove
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">Required</span>
              )}
            </li>
          ))}
        </ul>
        {linkableProviders.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {linkableProviders.map((provider) => (
              <Button
                key={provider}
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setProviderToLink(provider);
                }}
              >
                <ProviderMark provider={provider} />
                Link {providerName(provider)}
              </Button>
            ))}
          </div>
        ) : null}
      </GlassSectionContent>
      {providerToLink === undefined ? null : (
        <LinkProviderDialog
          key={`${userId}:${providerToLink}`}
          apiClient={apiClient}
          target={providerToLink}
          methods={security.methods}
          onClose={() => {
            setProviderToLink(undefined);
          }}
          navigateToProvider={navigateToProvider}
        />
      )}
      <Dialog
        open={methodToRemove !== undefined}
        onOpenChange={(open) => {
          if (!open && !unlink.isPending) {
            unlink.reset();
            setMethodToRemove(undefined);
          }
        }}
      >
        <DialogContent>
          <DialogTitle>Remove sign-in method?</DialogTitle>
          <DialogDescription>
            Remove{' '}
            {methodToRemove?.kind === 'password'
              ? 'your password'
              : providerName(methodToRemove?.provider ?? 'social')}
            ? Other browser sessions will end and this browser will receive a
            replacement session. Keep another verified method available.
          </DialogDescription>
          {unlink.error === null ? null : (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {methodError(unlink.error)}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={unlink.isPending}
              onClick={() => {
                unlink.reset();
                setMethodToRemove(undefined);
              }}
            >
              Keep method
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={unlink.isPending || methodToRemove === undefined}
              onClick={() => {
                if (methodToRemove !== undefined)
                  unlink.mutate(methodToRemove.id, {
                    onSuccess: () => {
                      setMethodToRemove(undefined);
                    },
                  });
              }}
            >
              {unlink.isPending ? 'Removing…' : 'Remove method'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </GlassSection>
  );
}

function methodError(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 401) return 'Your session expired. Sign in again.';
    if (error.status === 403)
      return 'Linking and removal require a recent sign-in.';
    if (error.status === 400 || error.status === 409)
      return 'That sign-in method cannot be changed. Keep at least one verified method.';
  }
  return 'The sign-in method could not be changed. Try again.';
}
