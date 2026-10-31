import type { ConnectionResponse } from '@pertexo/contracts';
import { ProgressButton } from '@/components/ui/progress-button';
import { Button } from '@/components/ui/button';
import { RadioChoice } from '@/components/ui/radio-choice';
import type { FieldValidation } from '@/components/ui/use-field-validation';
import type { useOAuth2Consent } from '../../hooks/use-oauth2-consent';
import { connectionCommandError } from '../../model/connection-errors';
import { isOAuth2Connection } from '../../model/oauth2-copy';
import type { ProviderKey } from '../../model/connection-providers';
import type {
  CredentialDraft,
  SavedCredential,
} from '../../model/credential-draft';
import type { useConnectionTest } from '../connection-test/use-command';
import type { ConnectionTest } from '../connection-test/use-command';
import { CredentialFields } from '../credential/fields';
import { createHeaderRowId, type CredentialForm } from '../credential/use-form';
import { OAuth2ConnectStep } from '../oauth2/connect';
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
    useOAuth2: boolean;
    onUseOAuth2: (useOAuth2: boolean) => void;
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
    consent: ReturnType<typeof useOAuth2Consent>;
  }>;
  command: Readonly<{
    disabled: boolean;
    uncertain: boolean;
    /** A failed save that isn't about one field. */
    createError: unknown;
  }>;
}>) {
  const {
    useOAuth2,
    onUseOAuth2,
    credential,
    name,
    nameValidation,
    onCredentialChange,
    onNameChange,
  } = fields;

  const { created, savedCredential, test, consent } = result;

  const { disabled, uncertain, createError } = command;

  if (step === 'provider')
    return <ProviderSockets layout="stack" onConnect={onChoose} />;
  if (step === 'connect')
    return created === undefined || !isOAuth2Connection(created) ? null : (
      <OAuth2ConnectStep connection={created} consent={consent} />
    );
  if (step === 'test')
    return created === undefined ? null : (
      <TestStep connection={created} saved={savedCredential} test={test} />
    );
  if (provider === undefined) return null;
  if (step === 'credential')
    return (
      <div className="flex flex-col gap-5">
        {provider === 'http' ? (
          <RadioChoice
            label="How this connection signs in"
            value={useOAuth2 ? 'oauth2' : 'headers'}
            disabled={disabled}
            options={[
              { value: 'headers', label: 'Headers' },
              { value: 'oauth2', label: 'OAuth2' },
            ]}
            onChange={(choice) => {
              onUseOAuth2(choice === 'oauth2');
            }}
          />
        ) : null}
        <CredentialFields
          draft={credential.draft}
          idPrefix={id}
          disabled={disabled}
          validation={credential.validation}
          createId={createHeaderRowId}
          onChange={onCredentialChange}
        />
      </div>
    );
  return (
    <NameStep
      id={id}
      provider={provider}
      authType={useOAuth2 ? 'oauth2' : undefined}
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

function saveLabel({
  retrying,
  useOAuth2,
}: Readonly<{ retrying: boolean; useOAuth2: boolean }>): string {
  if (retrying) return 'Try again';
  return useOAuth2 ? 'Continue' : 'Save and test';
}

export function AddConnectionFooter({
  formId,
  step,
  canGoBack,
  saving,
  retrying,
  tested,
  useOAuth2,
  onBack,
  onCancel,
}: Readonly<{
  formId: string;
  step: AddStep;
  canGoBack: boolean;
  saving: boolean;
  retrying: boolean;
  tested: ReturnType<typeof useConnectionTest>['phase'];
  useOAuth2: boolean;
  onBack: () => void;
  onCancel: () => void;
}>) {
  if (step === 'connect')
    return (
      <Button type="button" variant="ghost" onClick={onCancel}>
        Finish later
      </Button>
    );
  if (step === 'test')
    return (
      <Button
        type="button"
        variant={tested === 'ok' ? 'primary' : 'outline'}
        disabled={tested === 'running'}
        onClick={onCancel}
      >
        {tested === 'idle' && !useOAuth2 ? 'Skip test' : 'Done'}
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
          {saveLabel({ retrying, useOAuth2 })}
        </ProgressButton>
      )}
    </>
  );
}
