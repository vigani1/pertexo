import type { ConnectionResponse } from '@pertexo/contracts';
import { ProgressButton } from '@/components/ui/progress-button';
import { Button } from '@/components/ui/button';
import type { FieldValidation } from '@/components/ui/use-field-validation';
import { connectionCommandError } from '../../model/connection-errors';
import type { ProviderKey } from '../../model/connection-providers';
import type {
  CredentialDraft,
  SavedCredential,
} from '../../model/credential-draft';
import type { useConnectionTest } from '../connection-test/use-command';
import type { ConnectionTest } from '../connection-test/use-command';
import { CredentialFields } from '../credential/fields';
import { createHeaderRowId, type CredentialForm } from '../credential/use-form';
import { ProviderSockets } from '../provider-sockets';
import { NameStep, TestStep, type AddStep } from './steps';

/** The body of the current step; only the step's own controls render. */
export function StepBody({
  id,
  step,
  provider,
  onChoose,
  fields,
  result,
  command,
}: Readonly<{
  id: string;
  step: AddStep;
  provider: ProviderKey | undefined;
  onChoose: (provider: ProviderKey) => void;
  fields: Readonly<{
    credential: CredentialForm;
    name: string;
    nameValidation: FieldValidation<'name'>;
    onCredentialChange: (draft: CredentialDraft) => void;
    onNameChange: (name: string) => void;
  }>;
  result: Readonly<{
    created: ConnectionResponse | undefined;
    savedCredential: SavedCredential | undefined;
    test: ConnectionTest;
  }>;
  command: Readonly<{
    disabled: boolean;
    uncertain: boolean;
    /** A failed save that isn't about one field. */
    createError: unknown;
  }>;
}>) {
  const { credential, name, nameValidation, onCredentialChange, onNameChange } =
    fields;

  const { created, savedCredential, test } = result;

  const { disabled, uncertain, createError } = command;

  if (step === 'provider')
    return <ProviderSockets layout="stack" onConnect={onChoose} />;
  if (step === 'test')
    return created === undefined ? null : (
      <TestStep connection={created} saved={savedCredential} test={test} />
    );
  if (provider === undefined) return null;
  if (step === 'credential')
    return (
      <CredentialFields
        draft={credential.draft}
        idPrefix={id}
        disabled={disabled}
        validation={credential.validation}
        createId={createHeaderRowId}
        onChange={onCredentialChange}
      />
    );
  return (
    <NameStep
      id={id}
      provider={provider}
      name={name}
      disabled={disabled}
      validation={nameValidation}
      onNameChange={onNameChange}
      uncertain={uncertain}
      commandError={
        createError === undefined
          ? undefined
          : connectionCommandError(createError, 'create', name.trim())
      }
    />
  );
}

export function AddConnectionFooter({
  formId,
  step,
  canGoBack,
  saving,
  retrying,
  tested,
  onBack,
  onCancel,
}: Readonly<{
  formId: string;
  step: AddStep;
  canGoBack: boolean;
  saving: boolean;
  retrying: boolean;
  tested: ReturnType<typeof useConnectionTest>['phase'];
  onBack: () => void;
  onCancel: () => void;
}>) {
  if (step === 'test')
    return (
      <Button
        type="button"
        variant={tested === 'ok' ? 'primary' : 'outline'}
        disabled={tested === 'running'}
        onClick={onCancel}
      >
        {tested === 'idle' ? 'Skip test' : 'Done'}
      </Button>
    );
  const back =
    step === 'name' || (step === 'credential' && canGoBack) ? (
      <Button type="button" variant="ghost" disabled={saving} onClick={onBack}>
        Back
      </Button>
    ) : (
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    );
  if (step === 'provider') return back;
  return (
    <>
      {back}
      {step === 'credential' ? (
        <Button type="submit" form={formId} variant="primary">
          Continue
        </Button>
      ) : (
        <ProgressButton
          type="submit"
          form={formId}
          variant="primary"
          pending={saving}
          pendingLabel="Saving…"
        >
          {retrying ? 'Try again' : 'Save and test'}
        </ProgressButton>
      )}
    </>
  );
}
