import { useId, useRef, useState } from 'react';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import { Button } from '@/components/ui/button';
import { LoadingOrb } from '@/components/ui/loading-orb';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { useNotifications } from '@/components/ui/use-notifications';
import { isApiError } from '@/lib/api/api-error';
import { isUncertainOutcome } from '@/lib/api/api-error-copy';
import { connectionCommandError } from '../../connection-errors';
import {
  useCreateConnectionMutation,
  type ConnectionMutationScope,
  type CreateConnectionCommand,
} from '../../connections.mutations';
import {
  connectionNameError,
  PROVIDERS,
  suggestConnectionName,
  type ProviderKey,
} from '../../model/connection-providers';
import { toCreateRequest } from '../../model/credential-draft';
import { useConnectionTest } from '../../use-connection-test';
import { CredentialFields } from '../credential/credential-fields';
import {
  createHeaderRowId,
  useCredentialForm,
} from '../credential/use-credential-form';
import { ProviderSockets } from '../provider-sockets';
import {
  NameStep,
  StepIndicator,
  TestStep,
  type AddStep,
} from './add-connection-steps';

export type AddConnectionRequest = ProviderKey | 'any';

const DESCRIPTIONS: Readonly<Record<AddStep, string>> = {
  provider: 'Choose what Pertexo should plug into.',
  credential: 'Pertexo encrypts it and never shows it again.',
  name: 'Name it so people recognise it in steps and alerts.',
  test: 'Check that the service accepts it.',
};

/**
 * The add lens: credential, name, then a test that runs straight away. The
 * connection is saved before its test, so a failed test can still be kept.
 */
export function AddConnectionSheet({
  scope,
  workspaceName,
  request,
  onClose,
}: Readonly<{
  scope: ConnectionMutationScope;
  workspaceName: string;
  request: AddConnectionRequest | undefined;
  onClose: () => void;
}>) {
  const id = useId();
  const notifications = useNotifications();
  const [chosen, setChosen] = useState<ProviderKey>();
  const [stepState, setStep] = useState<AddStep>();
  const [nameInput, setNameInput] = useState<string>();
  const [created, setCreated] = useState<ConnectionResponse>();
  const provider = chosen ?? (request === 'any' ? undefined : request);
  const step: AddStep =
    stepState ?? (provider === undefined ? 'provider' : 'credential');
  const credential = useCredentialForm(provider ?? 'slack');
  const nameValidation = useFieldValidation<'name'>();
  const { mutation: create, clearSensitiveState } =
    useCreateConnectionMutation(scope);
  const test = useConnectionTest(scope);
  const attempt = useRef<
    | Readonly<{ signature: string; command: CreateConnectionCommand }>
    | undefined
  >(undefined);
  const name =
    nameInput ??
    (provider === undefined
      ? ''
      : suggestConnectionName(provider, workspaceName));

  function close() {
    if (create.isPending) return;
    if (created !== undefined)
      notifications.success(
        test.phase === 'ok'
          ? { title: `Connected ${created.name}` }
          : {
              title: `Saved ${created.name}`,
              description: 'It hasn’t passed a test yet.',
            },
      );
    attempt.current = undefined;
    setChosen(undefined);
    setStep(undefined);
    setNameInput(undefined);
    setCreated(undefined);
    credential.clear();
    nameValidation.reset();
    clearSensitiveState();
    test.reset();
    onClose();
  }

  function continueToName() {
    if (credential.validate() !== undefined) setStep('name');
  }

  async function save() {
    if (provider === undefined || create.isPending) return;
    if (!nameValidation.submit({ name: connectionNameError(name) })) return;
    if (credential.validate() === undefined) {
      setStep('credential');
      return;
    }
    const body = toCreateRequest(name.trim(), credential.draft);
    const signature = JSON.stringify(body);
    const command =
      attempt.current?.signature === signature
        ? attempt.current.command
        : { request: body, idempotencyKey: crypto.randomUUID() };
    attempt.current = { signature, command };
    let connection: ConnectionResponse;
    try {
      connection = await create.mutateAsync(command);
    } catch (error) {
      const issues = isApiError(error) ? (error.problem?.errors ?? []) : [];
      if (issues.some((issue) => issue.path === 'name'))
        nameValidation.showErrors({
          name: 'Pertexo couldn’t use this name. Try a shorter one.',
        });
      if (credential.showServerIssues(issues)) setStep('credential');
      return;
    }
    attempt.current = undefined;
    credential.clear();
    clearSensitiveState();
    setCreated(connection);
    setStep('test');
    if (connection.providerKey === 'slack')
      test.run(connection, { providerKey: 'slack' });
  }

  const createFailed = create.isError && !isFieldProblem(create.error);
  const uncertain = create.isError && isUncertainOutcome(create.error);

  return (
    <Sheet
      open={request !== undefined}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetContent className="w-[min(28rem,calc(100vw-1.5rem))]">
        <SheetHeader className="gap-3">
          <SheetTitle>
            {provider === undefined
              ? 'Add a connection'
              : PROVIDERS[provider].connectTitle}
          </SheetTitle>
          <SheetDescription>{DESCRIPTIONS[step]}</SheetDescription>
          <StepIndicator step={step} />
        </SheetHeader>
        <SheetBody>
          <form
            id={`${id}-form`}
            noValidate
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              if (step === 'credential') continueToName();
              else if (step === 'name') void save();
            }}
          >
            {step === 'provider' ? (
              <ProviderSockets
                onConnect={(next) => {
                  setChosen(next);
                  setStep('credential');
                }}
              />
            ) : null}
            {step === 'credential' && provider !== undefined ? (
              <CredentialFields
                draft={credential.draft}
                idPrefix={id}
                disabled={create.isPending}
                validation={credential.validation}
                createId={createHeaderRowId}
                onChange={(next) => {
                  credential.setDraft(next);
                  if (create.isError) clearSensitiveState();
                }}
              />
            ) : null}
            {step === 'name' && provider !== undefined ? (
              <NameStep
                id={id}
                provider={provider}
                name={name}
                disabled={create.isPending}
                validation={nameValidation}
                onNameChange={(next) => {
                  setNameInput(next);
                  if (create.isError) clearSensitiveState();
                }}
                uncertain={uncertain}
                commandError={
                  createFailed
                    ? connectionCommandError(
                        create.error,
                        'create',
                        name.trim(),
                      )
                    : undefined
                }
              />
            ) : null}
            {step === 'test' && created !== undefined ? (
              <TestStep connection={created} test={test} />
            ) : null}
          </form>
        </SheetBody>
        <SheetFooter>
          <AddConnectionFooter
            formId={`${id}-form`}
            step={step}
            canGoBack={request === 'any'}
            saving={create.isPending}
            retrying={uncertain}
            tested={test.phase}
            onBack={() => {
              setStep(step === 'name' ? 'credential' : 'provider');
              if (step === 'credential') setChosen(undefined);
            }}
            onCancel={close}
          />
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function isFieldProblem(error: unknown): boolean {
  return isApiError(error) && (error.problem?.errors?.length ?? 0) > 0;
}

function AddConnectionFooter({
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
        {tested === 'ok'
          ? 'Done'
          : tested === 'idle'
            ? 'Skip test'
            : 'Save anyway'}
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
        <Button type="submit" form={formId} variant="primary" disabled={saving}>
          {saving ? <LoadingOrb data-icon="inline-start" /> : null}
          {saving ? 'Saving…' : retrying ? 'Try again' : 'Save and test'}
        </Button>
      )}
    </>
  );
}
