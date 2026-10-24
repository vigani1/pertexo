import { useId, useRef, useState } from 'react';
import { directoryCredentialCreateSchema } from '@pertexo/contracts';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { ProgressButton } from '@/components/ui/progress-button';
import { Checkbox } from '@/components/ui/checkbox';
import { CopyButton } from '@/components/ui/copy-button';
import { Notice } from '@/components/ui/notice';
import { Status } from '@/components/ui/status';
import { useLatestRequest } from '@/lib/hooks/use-latest-request';
import { isUnconfirmedCommand } from '@/lib/api/commands/contract';
import { describeCommandError } from '@/lib/api/error-copy';
import { createDirectoryCredential } from '../../data/directory.api';
import type { FederationScope } from '../../data/settings.api';

type View =
  | Readonly<{ kind: 'form'; error?: string }>
  | Readonly<{ kind: 'unconfirmed' }>
  | Readonly<{ kind: 'secret'; secret: string }>;
/** A bearer secret stays in this mounted dialog; it never enters a Query cache. */
export function DirectoryCredentialDialog({
  scope,
  revision,
  onRefresh,
  onClose,
}: Readonly<{
  scope: FederationScope;
  revision: number;
  onRefresh: () => void;
  onClose: () => void;
}>) {
  const id = useId(),
    request = useLatestRequest(),
    busy = useRef(false),
    nameInput = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<View>({ kind: 'form' }),
    [name, setName] = useState('');
  async function create() {
    if (busy.current || view.kind !== 'form') return;
    const input = directoryCredentialCreateSchema.safeParse({
      name,
      expectedRevision: revision,
    });
    if (!input.success) {
      setView({
        kind: 'form',
        error: 'Enter a credential name, up to 128 characters.',
      });
      nameInput.current?.focus();
      return;
    }
    busy.current = true;
    const attempt = request.begin();
    setView({ kind: 'form' });
    try {
      const result = await createDirectoryCredential(
        scope,
        input.data,
        crypto.randomUUID(),
        attempt.signal,
      );
      if (!attempt.isCurrent()) return;
      setView(
        result.replayed
          ? { kind: 'unconfirmed' }
          : { kind: 'secret', secret: result.secret },
      );
      onRefresh();
    } catch (cause: unknown) {
      if (!attempt.isCurrent()) return;
      if (isUnconfirmedCommand(cause)) {
        setView({ kind: 'unconfirmed' });
        onRefresh();
      } else
        setView({
          kind: 'form',
          error: describeCommandError(
            cause,
            'creating this provisioning credential',
          ),
        });
    } finally {
      busy.current = false;
      attempt.finish();
    }
  }
  return (
    <Dialog
      open
      disablePointerDismissal={request.pending || view.kind === 'secret'}
      onOpenChange={(open) => {
        if (!open && !request.pending && view.kind !== 'secret') onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>{credentialTitle[view.kind]}</DialogTitle>
        <DialogDescription>
          {view.kind === 'form'
            ? 'This credential can provision users and groups across the linked workspaces. Keep it in your identity provider’s secret settings.'
            : 'Pertexo shows the bearer secret once. It cannot be retrieved later.'}
        </DialogDescription>
        {view.kind === 'secret' ? (
          <DirectoryCredentialReceipt
            id={id}
            secret={view.secret}
            onClose={onClose}
          />
        ) : null}
        {view.kind === 'unconfirmed' ? (
          <UnconfirmedCredentialNotice
            onRefresh={onRefresh}
            onClose={onClose}
          />
        ) : null}
        {view.kind === 'form' ? (
          <form
            noValidate
            className="mt-5 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <LabelledField
              id={`${id}-name`}
              label="Credential name"
              error={view.error}
            >
              {(control) => (
                <Input
                  {...control}
                  ref={nameInput}
                  value={name}
                  maxLength={128}
                  autoComplete="off"
                  disabled={request.pending}
                  onChange={(event) => {
                    setName(event.target.value);
                    setView({ kind: 'form' });
                  }}
                />
              )}
            </LabelledField>
            <div className="flex flex-wrap gap-2">
              <ProgressButton
                type="submit"
                variant="primary"
                pending={request.pending}
                pendingLabel="Creating credential…"
              >
                Create credential
              </ProgressButton>
              <Button
                type="button"
                variant="ghost"
                disabled={request.pending}
                onClick={onClose}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const credentialTitle = {
  secret: 'Save this credential now',
  unconfirmed: 'Check your credentials',
  form: 'Create provisioning credential',
} satisfies Record<View['kind'], string>;

function DirectoryCredentialReceipt({
  id,
  secret,
  onClose,
}: Readonly<{ id: string; secret: string; onClose: () => void }>) {
  const [saved, setSaved] = useState(false);
  return (
    <div className="mt-5 space-y-5">
      <Status tone="success">Provisioning credential created</Status>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`${id}-secret`} className="text-sm font-medium">
          Provisioning bearer credential
        </label>
        <CopyButton value={secret} label="Copy provisioning credential" />
      </div>
      <Textarea
        id={`${id}-secret`}
        readOnly
        value={secret}
        autoComplete="off"
        spellCheck={false}
        className="font-mono text-base break-all md:text-xs"
      />
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={saved} onCheckedChange={setSaved} />
        I’ve saved this credential
      </label>
      <Button
        type="button"
        variant="primary"
        disabled={!saved}
        onClick={onClose}
      >
        Done
      </Button>
    </div>
  );
}

function UnconfirmedCredentialNotice({
  onRefresh,
  onClose,
}: Readonly<{ onRefresh: () => void; onClose: () => void }>) {
  return (
    <div className="mt-5 space-y-4">
      <Notice tone="warning">
        Creation could not be confirmed, or its one-time secret is no longer
        available. Check the list and revoke the credential you cannot use
        before creating a replacement.
      </Notice>
      <Button
        type="button"
        onClick={() => {
          onRefresh();
          onClose();
        }}
      >
        Close and check credentials
      </Button>
    </div>
  );
}
