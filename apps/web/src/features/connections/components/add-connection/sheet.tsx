import { isUnconfirmedCommand } from '@/lib/api/commands/contract';
import { useId, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/patterns/actions/confirm-dialog';
import type { ConnectionResponse } from '@pertexo/contracts';
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
import { isApiError } from '@/lib/api/error';
import {
  useCreateConnectionMutation,
  type ConnectionMutationScope,
  type CreateConnectionCommand,
} from '../../data/connections.mutations';
import {
  connectionNameError,
  PROVIDERS,
  suggestConnectionName,
  type ProviderKey,
} from '../../model/connection-providers';
import {
  credentialDraftHasSecret,
  describeSavedCredential,
  toCreateRequest,
  type SavedCredential,
} from '../../model/credential-draft';
import { useConnectionTest } from '../connection-test/use-test';
import { useCredentialForm } from '../credential/use-form';
import { StepIndicator, type AddStep } from './steps';
import { StepBody } from './content';
import { AddConnectionFooter } from './content';

export type AddConnectionRequest = ProviderKey | 'any';

const DESCRIPTIONS: Readonly<Record<AddStep, string>> = {
  provider: 'Choose what Pertexo should plug into.',
  credential: 'Paste the key or token the service gave you.',
  name: 'Name it so people recognize it in steps and alerts.',
  test: 'Check that the service accepts it.',
};

/**
 * The add lens: credential, name, then a test that runs straight away. The
 * connection is saved before its test, so a failed test can still be kept.
 * A lens opened from elsewhere (a step's connection slot) hears about the
 * saved connection through `onCreated` as it closes, to select it.
 */
export function AddConnectionSheet({
  scope,
  workspaceName,
  request,
  onClose,
  onCreated,
}: Readonly<{
  scope: ConnectionMutationScope;
  workspaceName: string;
  request: AddConnectionRequest | undefined;
  onClose: () => void;
  onCreated?: (connection: ConnectionResponse) => void;
}>) {
  const id = useId();
  const notifications = useNotifications();
  const [chosen, setChosen] = useState<ProviderKey>();
  const [stepState, setStep] = useState<AddStep>();
  const [nameInput, setNameInput] = useState<string>();
  const [created, setCreated] = useState<ConnectionResponse>();
  const [savedCredential, setSavedCredential] = useState<SavedCredential>();
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const provider = chosen ?? (request === 'any' ? undefined : request);
  const step: AddStep =
    stepState ?? (provider === undefined ? 'provider' : 'credential');
  const credential = useCredentialForm(provider ?? 'slack');
  const nameValidation = useFieldValidation<'name'>();
  const { mutation: create, clearSensitiveState } =
    useCreateConnectionMutation(scope);
  const test = useConnectionTest(scope, { toastOnPass: false });
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
    if (created !== undefined) {
      notifications.success(
        savedMessage({ name: created.name, passed: test.phase === 'ok' }),
      );
      onCreated?.(test.result?.connection ?? created);
    }
    attempt.current = undefined;
    setChosen(undefined);
    setStep(undefined);
    setNameInput(undefined);
    setCreated(undefined);
    setSavedCredential(undefined);
    credential.clear();
    nameValidation.reset();
    clearSensitiveState();
    test.reset();
    onClose();
  }

  /** Closing asks first when a pasted secret would be thrown away. */
  function requestClose() {
    if (
      created === undefined &&
      provider !== undefined &&
      credentialDraftHasSecret(credential.draft)
    )
      setConfirmingDiscard(true);
    else close();
  }

  function continueToName() {
    if (credential.validate() !== undefined) setStep('name');
  }

  /** Server field errors land on the name or the credential step. */
  function placeServerIssues(error: unknown) {
    const issues = isApiError(error) ? (error.problem?.errors ?? []) : [];
    if (issues.some((issue) => issue.path === 'name'))
      nameValidation.showErrors({
        name: 'Pertexo couldn’t use this name. Try a shorter one.',
      });
    if (credential.showServerIssues(issues)) setStep('credential');
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
      placeServerIssues(error);
      return;
    }
    attempt.current = undefined;
    setSavedCredential(describeSavedCredential(credential.draft));
    credential.clear();
    clearSensitiveState();
    setCreated(connection);
    setStep('test');
    if (
      connection.providerKey === 'slack' ||
      connection.providerKey === 'signing'
    )
      test.run(connection, { providerKey: connection.providerKey });
  }

  const createFailed = create.isError && !isFieldProblem(create.error);
  const uncertain = create.isError && isUnconfirmedCommand(create.error);

  return (
    <Sheet
      open={request !== undefined}
      onOpenChange={(open) => {
        if (!open) requestClose();
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
            <StepBody
              id={id}
              step={step}
              provider={provider}
              created={created}
              savedCredential={savedCredential}
              credential={credential}
              name={name}
              nameValidation={nameValidation}
              disabled={create.isPending}
              uncertain={uncertain}
              createError={createFailed ? create.error : undefined}
              test={test}
              onChoose={(next) => {
                setChosen(next);
                setStep('credential');
              }}
              onCredentialChange={(next) => {
                credential.setDraft(next);
                if (create.isError) clearSensitiveState();
              }}
              onNameChange={(next) => {
                setNameInput(next);
                if (create.isError) clearSensitiveState();
              }}
            />
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
            onCancel={requestClose}
          />
        </SheetFooter>
      </SheetContent>
      <ConfirmDialog
        open={confirmingDiscard}
        onOpenChange={setConfirmingDiscard}
        tone="destructive"
        title="Discard this connection?"
        description="The credential you pasted isn’t saved yet, so it’s lost if you leave now."
        cancelLabel="Keep editing"
        confirmLabel="Discard"
        onConfirm={() => {
          setConfirmingDiscard(false);
          close();
        }}
      />
    </Sheet>
  );
}

function savedMessage({
  name,
  passed,
}: Readonly<{ name: string; passed: boolean }>) {
  return passed
    ? { title: `Connected ${name}` }
    : { title: `Saved ${name}`, description: 'It hasn’t passed a test yet.' };
}

function isFieldProblem(error: unknown): boolean {
  return isApiError(error) && (error.problem?.errors?.length ?? 0) > 0;
}
