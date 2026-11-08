import { encode } from 'uqr';
import { ConfirmDialog } from '@/components/patterns/actions/confirm-dialog';
import { isApiError } from '@/lib/api/error';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { FormAccessRequest, FormAccess } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { LabelledField } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { QueryView } from '@/components/patterns/states/query-view';
import { Status } from '@/components/ui/status';
import { formAccessQueryOptions } from '../data/forms.queries';
import { setFormAccess, type MemberFormScope } from '../data/forms.api';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
function newCapability() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}
function formNotPublished(error: unknown) {
  if (!isApiError(error) || error.problem?.code !== 'form.unavailable')
    return undefined;
  return <Notice>Publish an enabled Form trigger before sharing it.</Notice>;
}

export function FormAccessControl({
  scope,
  editable,
}: Readonly<{ scope: MemberFormScope; editable: boolean }>) {
  const query = useQuery({
    ...formAccessQueryOptions(scope),
    enabled: editable,
  });
  if (!editable)
    return (
      <Notice>
        Workspace members can open the published form. An editor manages public
        access.
      </Notice>
    );
  return (
    <QueryView query={query} resource="Form access" failure={formNotPublished}>
      {(access) => <SharedFormAccess scope={scope} access={access} />}
    </QueryView>
  );
}
function SharedFormAccess({
  scope,
  access,
}: Readonly<{ scope: MemberFormScope; access: FormAccess }>) {
  const cache = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const command = useRetainedCommand(
    (body: FormAccessRequest, key: string) => setFormAccess(scope, body, key),
    async () => {
      setConfirming(false);
      await cache.invalidateQueries({
        queryKey: formAccessQueryOptions(scope).queryKey,
      });
    },
  );
  const disabled = command.pending || command.uncertain;
  const url =
    access.access === 'public' && access.publicId !== null && access.capability
      ? new URL(
          `/forms/${encodeURIComponent(access.publicId)}`,
          window.location.origin,
        )
      : undefined;
  if (url !== undefined) url.hash = access.capability ?? '';
  const link = url?.toString();
  return (
    <section className="flex min-w-0 flex-col gap-3 border-t border-border pt-4">
      <h3 className="font-medium">Who can open this form</h3>
      <Status tone={access.access === 'public' ? 'attention' : 'neutral'}>
        {access.access === 'public'
          ? 'Anyone with the link'
          : 'Workspace members'}
      </Status>
      <p className="text-xs text-muted-foreground">
        Sharing uses the published form. Publish to apply field changes.
      </p>
      <Link
        to="/w/$workspaceId/forms/$workflowId"
        params={{
          workspaceId: scope.workspaceId,
          workflowId: scope.workflowId,
        }}
        className="text-sm underline underline-offset-4"
      >
        Open member form
      </Link>
      {access.access === 'public' ? (
        <>
          <p className="text-xs text-muted-foreground">
            {link === undefined
              ? 'This older link can’t be shown again. Regenerate it once to save a copy you can view here anytime.'
              : 'Anyone holding this link can send responses.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                setConfirming(true);
              }}
            >
              Regenerate link
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void command.send({
                  access: 'members',
                  expectedRevision: access.revision,
                })
              }
            >
              Turn public access off
            </Button>
          </div>
        </>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          disabled={disabled}
          onClick={() =>
            void command.send({
              access: 'public',
              capability: newCapability(),
              expectedRevision: access.revision,
            })
          }
        >
          Enable public link
        </Button>
      )}
      {link === undefined ? null : (
        <LabelledField
          id={`${scope.workflowId}-public-form-link`}
          label="Public form link"
          description="Editors can return here to copy this link anytime."
        >
          {(control) => (
            <div className="flex min-w-0 gap-2">
              <Input {...control} readOnly value={link} />
              <CopyButton value={link} label="Copy form link" />
            </div>
          )}
        </LabelledField>
      )}
      {link === undefined ? null : <FormLinkQr link={link} />}
      <RegenerateFormLink
        open={confirming}
        setOpen={setConfirming}
        disabled={disabled}
        onConfirm={() => {
          setConfirming(false);
          return command.send({
            access: 'public',
            capability: newCapability(),
            expectedRevision: access.revision,
          });
        }}
      />
      {command.error === undefined ? null : (
        <Notice
          tone={command.uncertain ? 'warning' : 'destructive'}
          action={
            command.uncertain ? (
              <Button
                type="button"
                variant="outline"
                disabled={command.pending || command.expired}
                onClick={command.retry}
              >
                Retry same change
              </Button>
            ) : undefined
          }
        >
          {command.error}
        </Notice>
      )}
    </section>
  );
}

function FormLinkQr({ link }: Readonly<{ link: string }>) {
  const { data, size } = encode(link);
  const path = data
    .flatMap((row, y) =>
      row.flatMap((dark, x) =>
        dark ? [`M${String(x + 4)} ${String(y + 4)}h1v1h-1z`] : [],
      ),
    )
    .join('');
  return (
    <svg
      role="img"
      aria-label="Public form QR code"
      viewBox={`0 0 ${String(size + 8)} ${String(size + 8)}`}
      className="size-48 max-w-full"
      shapeRendering="crispEdges"
    >
      <rect width="100%" height="100%" fill="white" />
      <path d={path} fill="black" />
    </svg>
  );
}

function RegenerateFormLink({
  open,
  setOpen,
  disabled,
  onConfirm,
}: Readonly<{
  open: boolean;
  setOpen: (open: boolean) => void;
  disabled: boolean;
  onConfirm: () => unknown;
}>) {
  return (
    <ConfirmDialog
      state={{ open, onOpenChange: setOpen, locked: disabled }}
      title="Regenerate public form link?"
      description="This invalidates the old link. Existing pages and QR codes using it will stop working. Replace them with the new link."
      submitDisabled={disabled}
      onSubmit={onConfirm}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setOpen(false);
            }}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={disabled}>
            Regenerate and invalidate old link
          </Button>
        </div>
      }
    />
  );
}
