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
import { Status } from '@/components/ui/status';
import { formAccessQueryOptions } from '../data/forms.queries';
import { setFormAccess, type MemberFormScope } from '../data/forms.api';
import { useFormCommand } from '../data/use-command';
function newCapability() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
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
  if (query.isPending)
    return (
      <p className="text-sm text-muted-foreground">Loading form access…</p>
    );
  if (query.isError)
    return (
      <Notice
        action={
          <Button
            type="button"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Check again
          </Button>
        }
      >
        {isApiError(query.error) &&
        query.error.problem?.code === 'form.unavailable'
          ? 'Publish an enabled Form trigger before sharing it.'
          : 'Form access could not be loaded. Try again.'}
      </Notice>
    );
  return <SharedFormAccess scope={scope} access={query.data} />;
}
function SharedFormAccess({
  scope,
  access,
}: Readonly<{ scope: MemberFormScope; access: FormAccess }>) {
  const cache = useQueryClient();
  const [shownLink, setShownLink] =
    useState<Readonly<{ url: string; revision: number }>>();
  const command = useFormCommand(
    (body: FormAccessRequest, key: string) => setFormAccess(scope, body, key),
    async (result, body) => {
      await cache.invalidateQueries({
        queryKey: formAccessQueryOptions(scope).queryKey,
      });
      const current = cache.getQueryData(
        formAccessQueryOptions(scope).queryKey,
      );
      if (
        body.access === 'public' &&
        result.publicId !== null &&
        current?.revision === result.revision
      ) {
        const url = new URL(
          `/forms/${encodeURIComponent(result.publicId)}`,
          window.location.origin,
        );
        url.hash = body.capability;
        setShownLink({ url: url.toString(), revision: result.revision });
      } else setShownLink(undefined);
    },
  );
  const disabled = command.pending || command.uncertain;
  const link =
    shownLink?.revision === access.revision ? shownLink.url : undefined;
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
            Public links are shown once. Regenerating invalidates the old link.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void command.send({
                  access: 'public',
                  capability: newCapability(),
                  expectedRevision: access.revision,
                })
              }
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
          label="Save this link now"
          description="It is shown only after this change. Anyone holding it can send responses."
        >
          {(control) => (
            <div className="flex min-w-0 gap-2">
              <Input {...control} readOnly value={link} />
              <CopyButton value={link} label="Copy form link" />
            </div>
          )}
        </LabelledField>
      )}
      {command.error === undefined ? null : (
        <Notice
          tone={command.uncertain ? 'warning' : 'destructive'}
          action={
            command.uncertain ? (
              <Button
                type="button"
                variant="outline"
                disabled={command.pending}
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
