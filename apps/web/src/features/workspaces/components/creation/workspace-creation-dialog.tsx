import { workspaceCreateRequestSchema } from '@pertexo/contracts/schemas/identity-workspace';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { ApiClient } from '@/lib/api/client';
import { useWorkspaceCreation } from '../../mutations/use-workspace-creation';

type FieldErrors = Readonly<{
  name?: string;
  slug?: string;
}>;

export function WorkspaceCreationDialog({
  apiClient,
  userId,
  open,
  onOpenChange,
  onCreated,
  onSessionInvalidated,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: Parameters<typeof useWorkspaceCreation>[0]['onCreated'];
  onSessionInvalidated: () => void;
}>) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const nameRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const command = useWorkspaceCreation({
    apiClient,
    userId,
    onCreated,
    onSessionInvalidated,
  });

  useEffect(() => {
    if (command.error?.field === 'slug') slugRef.current?.focus();
  }, [command.error]);

  function resetForm() {
    setName('');
    setSlug('');
    setSlugEdited(false);
    setSubmitted(false);
    setFieldErrors({});
    command.clearError();
  }

  function close() {
    resetForm();
    onOpenChange(false);
  }

  function validate(values: Readonly<{ name: string; slug: string }>) {
    const result = workspaceCreateRequestSchema.safeParse(values);
    const next: { name?: string; slug?: string } = {};
    if (!result.success)
      for (const issue of result.error.issues) {
        if (issue.path[0] === 'name')
          next.name = 'Enter a workspace name between 1 and 128 characters.';
        if (issue.path[0] === 'slug')
          next.slug =
            'Use 1–64 lowercase letters, numbers, or single hyphens between characters.';
      }
    setFieldErrors(next);
    return result.success ? result.data : undefined;
  }

  function validateField(field: 'name' | 'slug', value: string) {
    const result = workspaceCreateRequestSchema.shape[field].safeParse(value);
    setFieldErrors((current) => ({
      ...current,
      [field]: result.success
        ? undefined
        : field === 'name'
          ? 'Enter a workspace name between 1 and 128 characters.'
          : 'Use 1–64 lowercase letters, numbers, or single hyphens between characters.',
    }));
  }

  function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    if (command.retryAvailable) {
      void command.retry();
      return;
    }
    if (command.created) {
      void command.refresh();
      return;
    }
    setSubmitted(true);
    const parsed = validate({ name, slug });
    if (parsed === undefined) {
      if (!workspaceCreateRequestSchema.shape.name.safeParse(name).success)
        nameRef.current?.focus();
      else slugRef.current?.focus();
      return;
    }
    void command.start({
      body: parsed,
      idempotencyKey: crypto.randomUUID(),
    });
  }

  const nameError = fieldErrors.name;
  const slugError =
    fieldErrors.slug ??
    (command.error?.field === 'slug' ? command.error.message : undefined);
  const generalError =
    command.error?.field === undefined ? command.error?.message : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !command.locked && !command.created) close();
      }}
    >
      <DialogContent>
        <DialogTitle>Create a workspace</DialogTitle>
        <DialogDescription>
          Create an operational boundary for workflows, connections, and runs.
          You become its owner.
        </DialogDescription>

        <form className="mt-6" onSubmit={submit}>
          <FieldGroup>
            <Field data-invalid={nameError === undefined ? undefined : true}>
              <FieldLabel htmlFor="workspace-create-name">
                Workspace name
              </FieldLabel>
              <Input
                ref={nameRef}
                id="workspace-create-name"
                name="name"
                autoComplete="off"
                maxLength={128}
                disabled={command.locked || command.created}
                value={name}
                aria-invalid={nameError === undefined ? undefined : true}
                aria-describedby={
                  nameError === undefined
                    ? 'workspace-create-name-help'
                    : 'workspace-create-name-help workspace-create-name-error'
                }
                onBlur={() => {
                  validateField('name', name);
                }}
                onChange={(event) => {
                  const nextName = event.target.value;
                  setName(nextName);
                  command.clearError();
                  if (!slugEdited) setSlug(suggestWorkspaceSlug(nextName));
                  if (submitted || nameError !== undefined)
                    validateField('name', nextName);
                }}
              />
              <FieldDescription id="workspace-create-name-help">
                Use the name your team expects to see in navigation.
              </FieldDescription>
              {nameError === undefined ? null : (
                <FieldError id="workspace-create-name-error">
                  {nameError}
                </FieldError>
              )}
            </Field>

            <Field data-invalid={slugError === undefined ? undefined : true}>
              <FieldLabel htmlFor="workspace-create-slug">
                Workspace slug
              </FieldLabel>
              <Input
                ref={slugRef}
                id="workspace-create-slug"
                name="slug"
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
                disabled={command.locked || command.created}
                value={slug}
                aria-invalid={slugError === undefined ? undefined : true}
                aria-describedby={
                  slugError === undefined
                    ? 'workspace-create-slug-help'
                    : 'workspace-create-slug-help workspace-create-slug-error'
                }
                onBlur={() => {
                  validateField('slug', slug);
                }}
                onChange={(event) => {
                  const nextSlug = event.target.value;
                  setSlug(nextSlug);
                  setSlugEdited(true);
                  command.clearError();
                  if (submitted || slugError !== undefined)
                    validateField('slug', nextSlug);
                }}
              />
              <FieldDescription id="workspace-create-slug-help">
                This stable identifier appears in workspace references. You can
                edit the suggestion before creating the workspace.
              </FieldDescription>
              {slugError === undefined ? null : (
                <FieldError id="workspace-create-slug-error">
                  {slugError}
                </FieldError>
              )}
            </Field>
          </FieldGroup>

          {generalError === undefined ? null : (
            <p role="alert" className="mt-5 text-sm text-destructive">
              {generalError}
            </p>
          )}

          <div className="mt-7 flex flex-wrap justify-end gap-2">
            {command.retryAvailable ? (
              <Button
                type="button"
                variant="ghost"
                disabled={command.pending}
                onClick={() => {
                  command.dismissUncertain();
                  close();
                }}
              >
                Dismiss attempt
              </Button>
            ) : command.created ? null : (
              <DialogClose
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={command.pending}
                  />
                }
              >
                Cancel
              </DialogClose>
            )}
            <Button
              type="submit"
              variant="primary"
              disabled={command.pending || command.refreshPending}
            >
              {command.pending
                ? command.retryAvailable
                  ? 'Retrying…'
                  : 'Creating…'
                : command.refreshPending
                  ? 'Refreshing access…'
                  : command.retryAvailable
                    ? 'Retry same workspace'
                    : command.created
                      ? 'Refresh workspace access'
                      : 'Create workspace'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function suggestWorkspaceSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, 64)
    .replace(/-+$/u, '');
}
