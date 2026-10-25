import { useId, useRef, useState, type RefObject } from 'react';
import {
  API_TOKEN_DEFAULT_LIFETIME_DAYS,
  API_TOKEN_MAX_LIFETIME_DAYS,
  apiTokenCreateRequestSchema,
  type ApiTokenCreateRequest,
  type ApiTokenScope,
} from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ProgressButton } from '@/components/ui/progress-button';
import { SCOPE_COPY } from '../model/copy';

export function CreateTokenForm({
  availableScopes,
  pending,
  onCreate,
  onClose,
}: Readonly<{
  availableScopes: readonly ApiTokenScope[];
  pending: boolean;
  onClose: () => void;
  onCreate: (request: ApiTokenCreateRequest) => Promise<void>;
}>) {
  const id = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const scopeGroup = useRef<HTMLFieldSetElement>(null);
  const expiryInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [days, setDays] = useState(String(API_TOKEN_DEFAULT_LIFETIME_DAYS));
  const [scopes, setScopes] = useState<ApiTokenScope[]>([]);
  const selectedScopes = new Set(scopes);
  const [errors, setErrors] = useState<
    Partial<Record<'name' | 'scopes' | 'expiresInDays', string | undefined>>
  >({});
  return (
    <form
      noValidate
      className="mt-5 flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const parsed = apiTokenCreateRequestSchema.safeParse({
          name,
          scopes,
          expiresInDays: Number(days),
        });
        if (!parsed.success) {
          const next = {
            ...(parsed.error.issues.some((issue) => issue.path[0] === 'name')
              ? {
                  name: 'Enter a name, up to 128 characters, without control characters.',
                }
              : {}),
            ...(parsed.error.issues.some((issue) => issue.path[0] === 'scopes')
              ? { scopes: 'Choose at least one scope.' }
              : {}),
            ...(parsed.error.issues.some(
              (issue) => issue.path[0] === 'expiresInDays',
            )
              ? {
                  expiresInDays: `Choose a whole number from 1 to ${String(API_TOKEN_MAX_LIFETIME_DAYS)}.`,
                }
              : {}),
          };
          setErrors(next);
          if (next.name !== undefined) nameInput.current?.focus();
          else if (next.scopes !== undefined) scopeGroup.current?.focus();
          else expiryInput.current?.focus();
          return;
        }
        setErrors({});
        void onCreate(parsed.data);
      }}
    >
      <FieldGroup>
        <LabelledField
          id={`${id}-name`}
          label="Token name"
          error={errors.name}
          description="Where you will use it, for example your build runner."
        >
          {(props) => (
            <Input
              {...props}
              ref={nameInput}
              autoComplete="off"
              maxLength={128}
              value={name}
              disabled={pending}
              onChange={(event) => {
                setName(event.target.value);
                setErrors((previous) => ({ ...previous, name: undefined }));
              }}
            />
          )}
        </LabelledField>
        <ScopePicker
          id={id}
          groupRef={scopeGroup}
          availableScopes={availableScopes}
          selectedScopes={selectedScopes}
          disabled={pending}
          error={errors.scopes}
          onToggle={({ scope, checked }) => {
            setScopes((previous) =>
              checked
                ? [...previous, scope]
                : previous.filter((value) => value !== scope),
            );
            setErrors((previous) => ({ ...previous, scopes: undefined }));
          }}
        />
        <LabelledField
          id={`${id}-expiry`}
          label="Expires in (days)"
          error={errors.expiresInDays}
          description={`From 1 to ${String(API_TOKEN_MAX_LIFETIME_DAYS)} days. There is no unlimited expiry.`}
        >
          {(props) => (
            <Input
              {...props}
              ref={expiryInput}
              type="number"
              min={1}
              max={API_TOKEN_MAX_LIFETIME_DAYS}
              step={1}
              value={days}
              disabled={pending}
              onChange={(event) => {
                setDays(event.target.value);
                setErrors((previous) => ({
                  ...previous,
                  expiresInDays: undefined,
                }));
              }}
            />
          )}
        </LabelledField>
      </FieldGroup>
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={onClose}
        >
          Cancel
        </Button>
        <ProgressButton
          type="submit"
          variant="primary"
          pending={pending}
          pendingLabel="Creating token…"
        >
          Create token
        </ProgressButton>
      </DialogFooter>
    </form>
  );
}

function ScopePicker({
  id,
  groupRef,
  availableScopes,
  selectedScopes,
  disabled,
  error,
  onToggle,
}: Readonly<{
  id: string;
  groupRef: RefObject<HTMLFieldSetElement | null>;
  availableScopes: readonly ApiTokenScope[];
  selectedScopes: ReadonlySet<ApiTokenScope>;
  disabled: boolean;
  error: string | undefined;
  onToggle: (
    change: Readonly<{ scope: ApiTokenScope; checked: boolean }>,
  ) => void;
}>) {
  return (
    <fieldset
      ref={groupRef}
      tabIndex={-1}
      aria-describedby={`${id}-scopes-description${error === undefined ? '' : ` ${id}-scopes-error`}`}
      aria-invalid={error !== undefined}
      disabled={disabled}
      className="flex min-w-0 flex-col gap-3 rounded-sm outline-none focus-ring"
    >
      <legend className="mb-2 text-sm font-semibold">Scopes</legend>
      <p
        id={`${id}-scopes-description`}
        className="text-xs leading-relaxed text-muted-foreground"
      >
        Choose only what this script needs. Scopes are independent and cannot
        exceed your current access.
      </p>
      {availableScopes.map((scope) => (
        <label
          key={scope}
          className="flex cursor-pointer items-start gap-3 py-1 text-sm"
        >
          <Checkbox
            aria-labelledby={`${id}-${scope.replace(':', '-')}-label`}
            disabled={disabled}
            checked={selectedScopes.has(scope)}
            onCheckedChange={(checked) => {
              onToggle({ scope, checked });
            }}
            aria-describedby={`${id}-${scope.replace(':', '-')}-hint`}
          />
          <span className="flex min-w-0 flex-col gap-1">
            <span id={`${id}-${scope.replace(':', '-')}-label`}>
              {SCOPE_COPY[scope].label}
            </span>
            <span
              id={`${id}-${scope.replace(':', '-')}-hint`}
              className="text-xs leading-relaxed text-muted-foreground"
            >
              {SCOPE_COPY[scope].description}
            </span>
          </span>
        </label>
      ))}
      {error === undefined ? null : (
        <p
          id={`${id}-scopes-error`}
          role="alert"
          className="text-xs text-destructive"
        >
          {error}
        </p>
      )}
    </fieldset>
  );
}
