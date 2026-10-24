import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { codeLanguageSchema, type CodeLanguage } from '@pertexo/node-sdk';
import {
  CODE_LANGUAGE_CHOICES,
  CODE_LANGUAGE_PRESENTATION,
} from './presentation';
import {
  ConfirmDialog,
  ConfirmationFooter,
} from '@/components/patterns/actions/confirm-dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { ChoiceSelect } from '../fields/choice-select';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';

/** The draft owns language; only the unconfirmed choice is local. */
export function CodeLanguageField({
  language,
  source,
  form,
}: Readonly<{ language: CodeLanguage; source: string; form: NodeFormApi }>) {
  const [requested, setRequested] = useState<CodeLanguage>();
  const change = (next: CodeLanguage) => {
    form.commit(
      (node) => ({ config: { ...node.config, language: next } }),
      `${form.nodeId}:config:language`,
    );
    setRequested(undefined);
  };
  const choose = (next: string | null) => {
    const parsed = codeLanguageSchema.safeParse(next);
    if (!parsed.success || parsed.data === language) return;
    if (source.trim()) setRequested(parsed.data);
    else change(parsed.data);
  };
  const id = fieldControlId(form.nodeId, 'code-language');
  return (
    <>
      <Field>
        <FieldLabel htmlFor={id}>Language</FieldLabel>
        <ChoiceSelect
          value={language}
          disabled={!form.editable}
          choices={CODE_LANGUAGE_CHOICES}
          onChange={choose}
          control={{ id: id }}
        />
      </Field>
      <ConfirmDialog
        state={{
          open: requested !== undefined,
          onOpenChange: (open) => {
            if (!open) setRequested(undefined);
          },
          locked: false,
        }}
        title={`Switch to ${CODE_LANGUAGE_PRESENTATION[requested ?? language].label}?`}
        description="Your code is kept as written. Check its syntax and update it for the new language before running. Undo restores the previous language."
        onSubmit={() => {
          if (requested !== undefined) change(requested);
        }}
        submitDisabled={!form.editable}
        footer={
          <ConfirmationFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              Cancel
            </DialogClose>
            <ProgressButton
              type="submit"
              variant="primary"
              pendingLabel="Switch language"
              disabled={!form.editable}
            >
              Switch language
            </ProgressButton>
          </ConfirmationFooter>
        }
      ></ConfirmDialog>
    </>
  );
}
