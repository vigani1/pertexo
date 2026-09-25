import { PlusIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FieldControl, FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { FieldValidation } from '@/components/ui/use-field-validation';
import {
  credentialErrors,
  MAX_HEADER_ROWS,
  type CredentialDraft,
  type CredentialField,
  type HeaderRow,
} from '../../model/credential-draft';

type HttpDraft = Extract<CredentialDraft, { provider: 'http' }>;

/**
 * Header name/value pairs sent with every call. Values are masked while typed
 * and never shown again once saved.
 */
export function HttpHeaderEditor({
  draft,
  idPrefix,
  disabled,
  validation,
  onChange,
  createId,
}: Readonly<{
  draft: HttpDraft;
  idPrefix: string;
  disabled: boolean;
  validation: FieldValidation<CredentialField>;
  onChange: (draft: HttpDraft) => void;
  createId: () => string;
}>) {
  function update(rows: readonly HeaderRow[], field?: CredentialField) {
    const next: HttpDraft = { provider: 'http', headers: rows };
    onChange(next);
    if (field !== undefined)
      validation.change(field, credentialErrors(next)[field]);
  }

  const formError = validation.error('headers');

  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="mb-2 text-sm font-medium">Headers</legend>
      <ol className="flex flex-col gap-3">
        {draft.headers.map((row, index) => {
          const nameField: CredentialField = `header-name:${row.id}`;
          const valueField: CredentialField = `header-value:${row.id}`;
          const nameError = validation.error(nameField);
          const valueError = validation.error(valueField);
          const nameId = `${idPrefix}-header-${row.id}-name`;
          const valueId = `${idPrefix}-header-${row.id}-value`;
          return (
            <li
              key={row.id}
              className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-start gap-2"
            >
              <FieldControl>
                <Input
                  ref={validation.register(nameField)}
                  id={nameId}
                  aria-label={`Header ${String(index + 1)} name`}
                  placeholder="Authorization"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={128}
                  disabled={disabled}
                  value={row.name}
                  aria-invalid={nameError !== undefined}
                  aria-describedby={
                    nameError === undefined ? undefined : `${nameId}-error`
                  }
                  onChange={(event) => {
                    const name = event.currentTarget.value;
                    update(
                      draft.headers.map((candidate) =>
                        candidate.id === row.id
                          ? { ...candidate, name }
                          : candidate,
                      ),
                      nameField,
                    );
                  }}
                />
              </FieldControl>
              <FieldControl>
                <Input
                  ref={validation.register(valueField)}
                  id={valueId}
                  type="password"
                  aria-label={`Header ${String(index + 1)} value`}
                  placeholder="Bearer …"
                  autoComplete="new-password"
                  spellCheck={false}
                  maxLength={8_192}
                  disabled={disabled}
                  value={row.value}
                  aria-invalid={valueError !== undefined}
                  aria-describedby={
                    valueError === undefined ? undefined : `${valueId}-error`
                  }
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    update(
                      draft.headers.map((candidate) =>
                        candidate.id === row.id
                          ? { ...candidate, value }
                          : candidate,
                      ),
                      valueField,
                    );
                  }}
                />
              </FieldControl>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove header ${String(index + 1)}`}
                disabled={disabled || draft.headers.length === 1}
                onClick={() => {
                  update(
                    draft.headers.filter(
                      (candidate) => candidate.id !== row.id,
                    ),
                  );
                }}
              >
                <XIcon aria-hidden="true" />
              </Button>
              {nameError === undefined ? null : (
                <FieldError id={`${nameId}-error`} className="col-span-3">
                  {nameError}
                </FieldError>
              )}
              {valueError === undefined ? null : (
                <FieldError id={`${valueId}-error`} className="col-span-3">
                  {valueError}
                </FieldError>
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || draft.headers.length >= MAX_HEADER_ROWS}
          onClick={() => {
            update([...draft.headers, { id: createId(), name: '', value: '' }]);
          }}
        >
          <PlusIcon data-icon="inline-start" aria-hidden="true" />
          Add header
        </Button>
        <p className="text-xs text-subtle-foreground">
          Values are stored encrypted and never shown again.
        </p>
      </div>
      {formError === undefined ? null : <FieldError>{formError}</FieldError>}
    </fieldset>
  );
}
