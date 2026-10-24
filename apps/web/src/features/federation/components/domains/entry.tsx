import { domainConfirmationCopy, domainStatus } from './copy';
import { useState } from 'react';
import type { FederationSettings } from '@pertexo/contracts';
import { ConfirmDialog } from '@/components/patterns/actions/confirm-dialog';
import { Button } from '@/components/ui/button';
import { ProgressButton } from '@/components/ui/progress-button';
import { Status } from '@/components/ui/status';
import { CopyButton } from '@/components/ui/copy-button';
import { formatDateTime } from '@/lib/format/time';
import type { FederationScope } from '../../data/settings.api';
import { useFederationCommand } from '../../data/use-command';
import { CommandFeedback } from '../command-feedback';
type Organization = NonNullable<FederationSettings['organization']>;
export function DomainEntry({
  scope,
  organization,
  domain,
  editable,
}: Readonly<{
  scope: FederationScope;
  organization: Organization;
  domain: Organization['domains'][number];
  editable: boolean;
}>) {
  const [confirmation, setConfirmation] = useState<{
    open: boolean;
    action: 'enforce' | 'remove';
    required: boolean;
    revision: number;
  }>({
    open: false,
    action: 'enforce',
    required: domain.requireSso,
    revision: organization.revision,
  });
  const closeConfirmation = () => {
    setConfirmation((current) => ({ ...current, open: false }));
  };
  const openConfirmation = (action: 'enforce' | 'remove') => {
    setConfirmation({
      open: true,
      action,
      required: domain.requireSso,
      revision: organization.revision,
    });
  };
  const command = useFederationCommand(scope, () => {
    closeConfirmation();
  });
  const locked = !editable || command.pending || command.uncertain;
  const ready = organization.providers.some(
    (provider) =>
      provider.enabled &&
      domain.checks.some(
        (check) =>
          check.providerId === provider.id &&
          check.providerRevision === provider.revision,
      ),
  );
  const confirmationCopy = domainConfirmationCopy({
      action: confirmation.action,
      required: confirmation.required,
    }),
    status = domainStatus(domain);
  return (
    <li className="min-w-0 space-y-4 border-b border-border py-5 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 break-all text-sm font-semibold">
          {domain.domain}
        </h3>
        <Status tone={status.tone}>{status.label}</Status>
      </div>
      {domain.challenge === null ? null : (
        <div className="space-y-2 text-sm">
          <p>Add this TXT record at your DNS provider:</p>
          <dl className="space-y-2">
            <div>
              <dt className="text-xs text-muted-foreground">Record name</dt>
              <dd className="flex min-w-0 items-start gap-2">
                <code className="min-w-0 break-all">
                  {domain.challenge.recordName}
                </code>
                <CopyButton
                  value={domain.challenge.recordName}
                  label="Copy DNS record name"
                />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">TXT value</dt>
              <dd className="flex min-w-0 items-start gap-2">
                <code className="min-w-0 break-all">
                  {domain.challenge.value}
                </code>
                <CopyButton
                  value={domain.challenge.value}
                  label="Copy DNS verification value"
                />
              </dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            Challenge expires {formatDateTime(domain.challenge.expiresAt)}.
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {domain.verifiedAt === null ? (
          <>
            <ProgressButton
              type="button"
              variant="outline"
              pending={command.pending}
              pendingLabel="Checking DNS…"
              disabled={locked}
              onClick={() =>
                void command.send({
                  kind: 'verifyDomain',
                  domainId: domain.id,
                  input: { expectedRevision: organization.revision },
                })
              }
            >
              Verify DNS
            </ProgressButton>
            <Button
              type="button"
              variant="ghost"
              disabled={locked}
              onClick={() =>
                void command.send({
                  kind: 'renewDomain',
                  domainId: domain.id,
                  input: { expectedRevision: organization.revision },
                })
              }
            >
              New challenge
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={locked || (!domain.requireSso && !ready)}
            onClick={() => {
              openConfirmation('enforce');
            }}
          >
            {domain.requireSso ? 'Make SSO optional' : 'Require SSO'}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          disabled={locked || domain.requireSso}
          onClick={() => {
            openConfirmation('remove');
          }}
        >
          Remove domain
        </Button>
      </div>
      {domain.verifiedAt !== null && !domain.requireSso && !ready ? (
        <p className="text-xs text-muted-foreground">
          Enable a provider and complete a test sign-in for this domain before
          requiring SSO.
        </p>
      ) : null}
      {!confirmation.open ? <CommandFeedback command={command} /> : null}
      <ConfirmDialog
        open={confirmation.open}
        onOpenChange={(open) => {
          if (!open && !command.pending) closeConfirmation();
        }}
        title={confirmationCopy.title}
        description={confirmationCopy.description}
        confirmLabel={confirmationCopy.confirmLabel}
        pending={command.pending}
        locked={command.pending}
        confirmDisabled={!editable || command.expired}
        error={command.error}
        unconfirmed={
          command.uncertain
            ? { onRetry: command.retry, onDismiss: () => undefined }
            : undefined
        }
        onConfirm={() =>
          command.send(
            confirmation.action === 'remove'
              ? {
                  kind: 'removeDomain',
                  domainId: domain.id,
                  input: { expectedRevision: confirmation.revision },
                }
              : {
                  kind: 'enforcement',
                  domainId: domain.id,
                  input: {
                    required: !confirmation.required,
                    expectedRevision: confirmation.revision,
                  },
                },
          )
        }
      />
    </li>
  );
}
