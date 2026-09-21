import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { workspaceRenameRequestSchema } from '@pertexo/contracts/schemas/identity-workspace';
import { useRef, useState, type SyntheticEvent } from 'react';
import {
  GlassSection,
  GlassSectionContent,
  GlassSectionDescription,
  GlassSectionHeader,
  GlassSectionTitle,
} from '@/components/patterns/glass-section';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { ApiClient } from '@/lib/api/client';
import { useWorkspaceRename } from '../../mutations/use-workspace-rename';

export function WorkspaceNameSection({
  apiClient,
  userId,
  workspace,
  onWorkspaceChanged,
  onAccessLost,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  onWorkspaceChanged: () => void;
  onAccessLost: () => void;
}>) {
  const canRename =
    workspace.status === 'active' &&
    workspace.capabilities.includes('workspace:manage');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(workspace.name);
  const [submitted, setSubmitted] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [submittedRevision, setSubmittedRevision] = useState<
    number | undefined
  >(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const command = useWorkspaceRename({
    apiClient,
    userId,
    workspaceId: workspace.id,
    onChanged: () => {
      setEditing(false);
      setSubmitted(false);
      setSubmittedRevision(undefined);
      onWorkspaceChanged();
    },
    onAccessLost,
  });

  function validate(value: string): string | undefined {
    const valid =
      workspaceRenameRequestSchema.shape.name.safeParse(value).success;
    const next = valid
      ? undefined
      : 'Enter a workspace name between 1 and 128 characters.';
    setFieldError(next);
    return next;
  }

  function startRename(expectedRevision: number) {
    const parsed = workspaceRenameRequestSchema.safeParse({
      name,
      expectedRevision,
    });
    if (!parsed.success) {
      validate(name);
      inputRef.current?.focus();
      return;
    }
    setName(parsed.data.name);
    setSubmittedRevision(expectedRevision);
    void command.start({
      body: parsed.data,
      idempotencyKey: crypto.randomUUID(),
    });
  }

  function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    setSubmitted(true);
    if (command.retryAvailable) {
      void command.retry();
      return;
    }
    if (command.accepted) {
      void command.refresh();
      return;
    }
    startRename(workspace.revision);
  }

  const conflict = command.error?.kind === 'conflict';
  const latestLoaded =
    conflict &&
    submittedRevision !== undefined &&
    workspace.revision !== submittedRevision;

  return (
    <GlassSection>
      <GlassSectionHeader>
        <GlassSectionTitle>Workspace name</GlassSectionTitle>
        <GlassSectionDescription>
          Change the display name shown in navigation. The stable slug and
          workspace links do not change.
        </GlassSectionDescription>
      </GlassSectionHeader>
      <GlassSectionContent>
        {editing ? (
          <form className="flex max-w-xl flex-col gap-5" onSubmit={submit}>
            <Field data-invalid={fieldError === undefined ? undefined : true}>
              <FieldLabel htmlFor="workspace-display-name">
                Display name
              </FieldLabel>
              <Input
                ref={inputRef}
                id="workspace-display-name"
                autoComplete="off"
                maxLength={128}
                required
                value={name}
                disabled={
                  command.pending || command.retryAvailable || command.accepted
                }
                aria-invalid={fieldError === undefined ? undefined : true}
                aria-describedby={
                  fieldError === undefined ? undefined : 'workspace-name-error'
                }
                onBlur={() => {
                  validate(name);
                }}
                onInvalid={() => {
                  validate(name);
                }}
                onChange={(event) => {
                  const next = event.target.value;
                  setName(next);
                  command.clearError();
                  if (submitted || fieldError !== undefined) validate(next);
                }}
              />
              {fieldError === undefined ? null : (
                <FieldError id="workspace-name-error">{fieldError}</FieldError>
              )}
            </Field>

            {command.error === undefined ? null : (
              <p role="alert" className="text-sm text-destructive">
                {command.error.message}
              </p>
            )}
            {latestLoaded ? (
              <p className="break-all text-sm text-muted-foreground">
                Current workspace name: <strong>{workspace.name}</strong>
              </p>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2">
              {command.retryAvailable ? (
                <Button type="button" variant="ghost" onClick={command.dismiss}>
                  Dismiss attempt
                </Button>
              ) : command.accepted ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={command.pending}
                  onClick={() => {
                    setName(workspace.name);
                    setEditing(false);
                    setSubmitted(false);
                    setFieldError(undefined);
                    command.clearError();
                  }}
                >
                  Cancel
                </Button>
              )}
              {conflict ? (
                latestLoaded ? (
                  <Button
                    type="button"
                    onClick={() => {
                      command.clearError();
                      startRename(workspace.revision);
                    }}
                  >
                    Reapply against latest
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={() => {
                      void command.reloadLatest().then((reloaded) => {
                        if (reloaded) onWorkspaceChanged();
                      });
                    }}
                  >
                    Refresh workspace
                  </Button>
                )
              ) : (
                <Button
                  type="submit"
                  disabled={command.pending || command.refreshPending}
                >
                  {command.pending
                    ? 'Saving…'
                    : command.refreshPending
                      ? 'Refreshing…'
                      : command.retryAvailable
                        ? 'Retry exact rename'
                        : command.accepted
                          ? 'Refresh workspace access'
                          : 'Save name'}
                </Button>
              )}
            </div>
          </form>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-4">
            <p className="min-w-0 basis-0 flex-1 break-all text-sm font-medium">
              {workspace.name}
            </p>
            {canRename ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setName(workspace.name);
                  setEditing(true);
                }}
              >
                Edit name
              </Button>
            ) : null}
          </div>
        )}
      </GlassSectionContent>
    </GlassSection>
  );
}
