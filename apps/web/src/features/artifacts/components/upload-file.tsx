import { useState, type ReactNode } from 'react';
import { UploadIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Status, type StatusTone } from '@/components/ui/status';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import { useLatestRequest } from '@/lib/hooks/use-latest-request';
import { formatByteLength } from '@/lib/format/bytes';
import { useUpload } from '../hooks/use-upload';
import type { FileReference, UploadPhase } from '../model/upload';

export type FileUploadScope = WorkspaceApiScope;
type Props = Readonly<{
  scope: FileUploadScope;
  /** A target change cancels this session while keeping its opener mounted. */
  targetKey: string;
  disabled?: boolean;
  label?: string;
  useLabel?: string;
  description: string;
  children?: (state: Readonly<{ disabled: boolean }>) => ReactNode;
  /** A returned reason leaves the finalized reference available for correction. */
  onUse: (
    reference: FileReference,
    signal: AbortSignal,
  ) => string | undefined | Promise<string | undefined>;
}>;

export function UploadFile(props: Props) {
  return (
    <ScopedUpload
      key={`${props.scope.userId}:${props.scope.workspaceId}`}
      {...props}
    />
  );
}

function ScopedUpload(props: Props) {
  const [openedFor, setOpenedFor] = useState<string>();
  const open = openedFor === props.targetKey && !(props.disabled ?? false);
  if (openedFor !== undefined && !open) setOpenedFor(undefined);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpenedFor(next ? props.targetKey : undefined);
      }}
    >
      <DialogTrigger
        disabled={props.disabled}
        render={<Button type="button" variant="outline" size="sm" />}
      >
        <UploadIcon data-icon="inline-start" />
        {props.label ?? 'Upload file'}
      </DialogTrigger>
      <DialogContent className="flex flex-col gap-5">
        {open ? (
          <UploadSession
            {...props}
            onClose={() => {
              setOpenedFor(undefined);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const phases: Readonly<
  Record<UploadPhase, Readonly<{ label: string; tone: StatusTone }>>
> = {
  empty: { label: 'Choose a file', tone: 'neutral' },
  hashing: { label: 'Checking file…', tone: 'live' },
  reserving: { label: 'Preparing upload…', tone: 'live' },
  uploading: { label: 'Sending file…', tone: 'live' },
  finalizing: { label: 'Verifying stored bytes…', tone: 'live' },
  available: { label: 'File ready', tone: 'success' },
  uncertain: { label: 'Needs attention', tone: 'attention' },
};

function UploadSession({
  scope,
  description,
  children,
  onUse,
  useLabel = 'Use file',
  onClose,
}: Props & Readonly<{ onClose: () => void }>) {
  const attachment = useLatestRequest();
  const upload = useUpload(scope.apiClient, scope.workspaceId);
  const [attachmentError, setAttachmentError] = useState<string>();
  const phase = phases[upload.state.phase];
  function close() {
    attachment.abort();
    upload.cancel();
    onClose();
  }
  return (
    <>
      <div>
        <DialogTitle>Upload a file</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </div>
      <LabelledField
        id="upload-file"
        label="File"
        description="Up to 10 MB (or the server’s lower storage limit). Files are not virus-checked."
      >
        {(control) => (
          <Input
            {...control}
            type="file"
            disabled={upload.pending || attachment.pending}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file !== undefined) {
                setAttachmentError(undefined);
                void upload.select(file);
              }
            }}
          />
        )}
      </LabelledField>
      <div
        className="flex min-w-0 flex-col gap-2 rounded-lg border border-surface-ink/8 bg-recess-ink/18 p-3"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <Status tone={phase.tone}>{phase.label}</Status>
        {upload.state.filename === undefined ? null : (
          <p className="break-words text-sm text-muted-foreground">
            {upload.state.filename} ·{' '}
            {formatByteLength(upload.state.byteLength ?? 0)}
          </p>
        )}
      </div>
      {upload.state.error === undefined ? null : (
        <Notice tone="warning">{upload.state.error}</Notice>
      )}
      {children?.({ disabled: attachment.pending })}
      {attachmentError === undefined ? null : (
        <Notice tone="destructive">{attachmentError}</Notice>
      )}
      <p className="text-xs leading-relaxed text-subtle-foreground">
        Only a verified file reference is inserted. Saved drafts, versions,
        input cases and runs keep their files. Unused finalized files expire
        after 30 days.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={close}>
          {upload.pending ? 'Cancel upload' : 'Cancel'}
        </Button>
        {upload.state.phase === 'uncertain' && upload.canRetry ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void upload.retry();
            }}
          >
            Check and retry same file
          </Button>
        ) : null}
        <Button
          type="button"
          variant="primary"
          disabled={
            upload.state.reference === undefined ||
            upload.pending ||
            attachment.pending
          }
          onClick={() => {
            if (upload.state.reference === undefined) return;
            const reference = upload.state.reference;
            const request = attachment.begin();
            void Promise.resolve()
              .then(() => {
                if (!request.isCurrent()) return undefined;
                return onUse(reference, request.signal);
              })
              .then((error) => {
                if (!request.isCurrent()) return;
                setAttachmentError(error);
                if (error === undefined) close();
              })
              .catch(() => {
                if (request.isCurrent())
                  setAttachmentError(
                    'The workflow input could not be checked. Try again; the file is already uploaded.',
                  );
              })
              .finally(request.finish);
          }}
        >
          {useLabel}
        </Button>
      </div>
    </>
  );
}
