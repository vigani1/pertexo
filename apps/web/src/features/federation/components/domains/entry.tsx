import { DialogClose } from '@/components/ui/dialog';
import { domainConfirmationCopy, domainStatus } from './copy';
import { useState } from 'react';
import type { FederationSettings } from '@pertexo/contracts';
import {
  ConfirmDialog,
  ConfirmationFooter,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import { Button } from '@/components/ui/button';
import { ProgressButton } from '@/components/ui/progress-button';
import { Status } from '@/components/ui/status';
import { CopyButton } from '@/components/ui/copy-button';
import { formatDateTime } from '@/lib/format/time';
import type { FederationScope } from '../../data/settings.api';
import { useFederationCommand } from '../../data/use-command';
import { CommandFeedback } from '../command-feedback';
type Organization = NonNullable<FederationSettings['organization']>;
type DomainEntryProps = Readonly<{
  scope: FederationScope;
  organization: Organization;
  domain: Organization['domains'][number];
  editable: boolean;
}>;

export function DomainEntry(props: DomainEntryProps) {
  const model = useDomainCommands(props);
  return (
    <li className="min-w-0 space-y-4 border-b border-border py-5 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 break-all text-sm font-semibold">
          {model.domain.domain}
        </h3>
        <Status tone={model.status.tone}>{model.status.label}</Status>
      </div>
      <DomainChallenge challenge={model.domain.challenge} />
      <div className="flex flex-wrap gap-2">
        {model.domain.verifiedAt === null ? (
          <>
            <ProgressButton
              type="button"
              variant="outline"
              pending={model.command.pending}
              pendingLabel="Checking DNS…"
              disabled={model.locked}
              onClick={() =>
                void model.command.send({
                  kind: 'verifyDomain',
                  domainId: model.domain.id,
                  input: { expectedRevision: model.organization.revision },
                })
              }
            >
              Verify DNS
            </ProgressButton>
            <Button
              type="button"
              variant="ghost"
              disabled={model.locked}
              onClick={() =>
                void model.command.send({
                  kind: 'renewDomain',
                  domainId: model.domain.id,
                  input: { expectedRevision: model.organization.revision },
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
            disabled={
              model.locked || (!model.domain.requireSso && !model.ready)
            }
            onClick={() => {
              model.openConfirmation('enforce');
            }}
          >
            {model.domain.requireSso ? 'Make SSO optional' : 'Require SSO'}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          disabled={model.locked || model.domain.requireSso}
          onClick={() => {
            model.openConfirmation('remove');
          }}
        >
          Remove domain
        </Button>
      </div>
      {model.domain.verifiedAt !== null &&
      !model.domain.requireSso &&
      !model.ready ? (
        <p className="text-xs text-muted-foreground">
          Enable a provider and complete a test sign-in for this domain before
          requiring SSO.
        </p>
      ) : null}
      {!model.confirmation.open ? (
        <CommandFeedback command={model.command} />
      ) : null}
      <DomainConfirmation model={model} />
    </li>
  );
}

function useDomainCommands({
  scope,
  organization,
  domain,
  editable,
}: DomainEntryProps) {
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

  return {
    domain,
    status,
    command,
    locked,
    organization,
    ready,
    openConfirmation,
    confirmation,
    closeConfirmation,
    confirmationCopy,
    editable,
  } as const;
}

function DomainChallenge({
  challenge,
}: Readonly<{ challenge: Organization['domains'][number]['challenge'] }>) {
  if (challenge === null) return null;
  return (
    <div className="space-y-2 text-sm">
      <p>Add this TXT record at your DNS provider:</p>
      <dl className="space-y-2">
        <div>
          <dt className="text-xs text-muted-foreground">Record name</dt>
          <dd className="flex min-w-0 items-start gap-2">
            <code className="min-w-0 break-all">{challenge.recordName}</code>
            <CopyButton
              value={challenge.recordName}
              label="Copy DNS record name"
            />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">TXT value</dt>
          <dd className="flex min-w-0 items-start gap-2">
            <code className="min-w-0 break-all">{challenge.value}</code>
            <CopyButton
              value={challenge.value}
              label="Copy DNS verification value"
            />
          </dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">
        Challenge expires {formatDateTime(challenge.expiresAt)}.
      </p>
    </div>
  );
}

function DomainConfirmation({
  model,
}: Readonly<{ model: ReturnType<typeof useDomainCommands> }>) {
  const changeConfirmationOpen = (open: boolean) => {
    if (!open && !model.command.pending) model.closeConfirmation();
  };
  const confirmationRetry = model.command.uncertain
    ? { onRetry: model.command.retry, onDismiss: () => undefined }
    : undefined;
  const confirmBlocked =
    model.command.pending || !model.editable || model.command.expired;
  return (
    <ConfirmDialog
      state={{
        open: model.confirmation.open,
        onOpenChange: changeConfirmationOpen,
        locked: model.command.pending,
      }}
      title={model.confirmationCopy.title}
      description={model.confirmationCopy.description}
      onSubmit={
        confirmationRetry?.onRetry ??
        (() =>
          model.command.send(
            model.confirmation.action === 'remove'
              ? {
                  kind: 'removeDomain',
                  domainId: model.domain.id,
                  input: { expectedRevision: model.confirmation.revision },
                }
              : {
                  kind: 'enforcement',
                  domainId: model.domain.id,
                  input: {
                    required: !model.confirmation.required,
                    expectedRevision: model.confirmation.revision,
                  },
                },
          ))
      }
      submitDisabled={confirmBlocked}
      footer={
        <ConfirmationFooter>
          {confirmationRetry === undefined ? (
            <DialogClose
              disabled={model.command.pending}
              render={<Button type="button" variant="ghost" />}
            >
              Cancel
            </DialogClose>
          ) : (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                confirmationRetry.onDismiss();
                changeConfirmationOpen(false);
              }}
            >
              Close
            </Button>
          )}
          <ProgressButton
            type="submit"
            variant="primary"
            pending={model.command.pending}
            pendingLabel={model.confirmationCopy.confirmLabel}
            disabled={!model.editable || model.command.expired}
          >
            {confirmationRetry === undefined
              ? model.confirmationCopy.confirmLabel
              : 'Try again'}
          </ProgressButton>
        </ConfirmationFooter>
      }
    >
      <ConfirmationDetails
        error={model.command.error}
        tone={confirmationRetry === undefined ? 'destructive' : 'warning'}
      />
    </ConfirmDialog>
  );
}
