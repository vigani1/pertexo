import { workspaceCreateRequestSchema } from '@pertexo/contracts/schemas/identity-workspace';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { TextField } from '@/components/patterns/text-field';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Notice } from '@/components/ui/notice';
import type { WorkspaceCreationCommand } from '../../mutations/use-workspace-creation';

type Field = 'name' | 'slug';
type FieldErrors = Readonly<Partial<Record<Field, string | undefined>>>;

const FIELD_MESSAGES: Record<Field, string> = {
  name: 'Give the workspace a name of up to 128 characters.',
  slug: 'Use lowercase letters, numbers and single hyphens, up to 64 characters.',
};

function suggestWorkspaceSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, 64)
    .replace(/-+$/u, '');
}

function fieldProblem(field: Field, value: string): string | undefined {
  return workspaceCreateRequestSchema.shape[field].safeParse(value).success
    ? undefined
    : FIELD_MESSAGES[field];
}

function submitLabel(command: WorkspaceCreationCommand): string {
  if (command.pending)
    return command.retryAvailable ? 'Checking…' : 'Creating…';
  if (command.refreshPending) return 'Opening…';
  if (command.retryAvailable) return 'Check again';
  return command.created ? 'Open workspace' : 'Create workspace';
}

function HandlePreview({
  slug,
  disabled,
  onEdit,
}: Readonly<{ slug: string; disabled: boolean; onEdit: () => void }>) {
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-[0.8rem] text-muted-foreground">
      Handle
      <code className="max-w-full truncate rounded-sm bg-white/[0.04] px-1.5 py-0.5 text-foreground">
        {slug === '' ? 'follows the name' : slug}
      </code>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto px-0"
        aria-label="Edit handle"
        disabled={disabled}
        onClick={onEdit}
      >
        Edit
      </Button>
    </p>
  );
}

/** Uncertain requests can be checked again or dropped; nothing else. */
function CreationActions({
  command,
  onStartOver,
  onCancel,
}: Readonly<{
  command: WorkspaceCreationCommand;
  onStartOver: () => void;
  onCancel: (() => void) | undefined;
}>) {
  const busy = command.pending || command.refreshPending;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {command.retryAvailable ? (
        <Button
          type="button"
          variant="ghost"
          disabled={command.pending}
          onClick={() => {
            command.dismissUncertain();
            onStartOver();
          }}
        >
          Start over
        </Button>
      ) : onCancel === undefined || command.created ? null : (
        <Button
          type="button"
          variant="ghost"
          disabled={command.pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
      )}
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? <LoadingOrb /> : null}
        {submitLabel(command)}
      </Button>
    </div>
  );
}

/**
 * Name the workspace; its handle follows the name until edited. After an
 * uncertain answer the same request can only be checked again or dropped,
 * never silently re-sent with different details.
 */
export function WorkspaceCreationForm({
  idPrefix,
  command,
  onStartOver,
  onCancel,
}: Readonly<{
  idPrefix: string;
  command: WorkspaceCreationCommand;
  onStartOver: () => void;
  onCancel?: (() => void) | undefined;
}>) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [editingSlug, setEditingSlug] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const nameRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement | null>(null);
  const focusSlugOnMount = useRef(false);
  const locked = command.locked || command.created;
  const slugError =
    errors.slug ??
    (command.error?.field === 'slug' ? command.error.message : undefined);
  const generalError =
    command.error?.field === undefined ? command.error?.message : undefined;
  const slugVisible = editingSlug || slugError !== undefined;

  useEffect(() => {
    if (command.error?.field === 'slug') slugRef.current?.focus();
  }, [command.error]);

  function check(field: Field, value: string) {
    setErrors((current) => ({
      ...current,
      [field]: fieldProblem(field, value),
    }));
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
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
    const next = {
      name: fieldProblem('name', name),
      slug: fieldProblem('slug', slug),
    };
    setErrors(next);
    if (next.name !== undefined) {
      nameRef.current?.focus();
      return;
    }
    if (next.slug !== undefined) {
      if (slugRef.current === null) focusSlugOnMount.current = true;
      else slugRef.current.focus();
      setEditingSlug(true);
      return;
    }
    const parsed = workspaceCreateRequestSchema.parse({ name, slug });
    void command.start({ body: parsed, idempotencyKey: crypto.randomUUID() });
  }

  return (
    <form noValidate className="flex flex-col gap-5" onSubmit={submit}>
      <FieldGroup className="gap-4">
        <TextField
          ref={nameRef}
          id={`${idPrefix}-name`}
          label="Workspace name"
          autoComplete="off"
          maxLength={128}
          disabled={locked}
          value={name}
          error={errors.name}
          state={errors.name === undefined ? undefined : 'invalid'}
          aria-invalid={errors.name === undefined ? undefined : true}
          onBlur={() => {
            check('name', name);
          }}
          onChange={(event) => {
            const nextName = event.target.value;
            setName(nextName);
            command.clearError();
            if (!slugEdited) setSlug(suggestWorkspaceSlug(nextName));
            if (submitted || errors.name !== undefined) check('name', nextName);
          }}
        />
        {slugVisible ? (
          <TextField
            ref={(element) => {
              slugRef.current = element;
              if (element !== null && focusSlugOnMount.current) {
                focusSlugOnMount.current = false;
                element.focus();
              }
            }}
            id={`${idPrefix}-slug`}
            label="Handle"
            description="Lowercase letters, numbers and single hyphens. It identifies the workspace in references."
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            disabled={locked}
            value={slug}
            error={slugError}
            state={slugError === undefined ? undefined : 'invalid'}
            aria-invalid={slugError === undefined ? undefined : true}
            onBlur={() => {
              check('slug', slug);
            }}
            onChange={(event) => {
              setSlug(event.target.value);
              setSlugEdited(true);
              command.clearError();
              if (submitted || errors.slug !== undefined)
                check('slug', event.target.value);
            }}
          />
        ) : (
          <HandlePreview
            slug={slug}
            disabled={locked}
            onEdit={() => {
              focusSlugOnMount.current = true;
              setEditingSlug(true);
            }}
          />
        )}
      </FieldGroup>
      {generalError === undefined ? null : (
        <Notice
          role="alert"
          tone={
            command.retryAvailable || command.created
              ? 'warning'
              : 'destructive'
          }
        >
          {generalError}
        </Notice>
      )}
      <CreationActions
        command={command}
        onStartOver={onStartOver}
        onCancel={onCancel}
      />
    </form>
  );
}
