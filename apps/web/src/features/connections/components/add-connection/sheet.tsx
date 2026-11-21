import { useConnectionDefinitions } from '@/features/catalog/public';
import { useCommandAttempt } from '@/lib/api/commands/use-command-attempt';
import { ExpiredAttemptNotice } from '@/components/patterns/states/expired-attempt-notice';

import {
  isUnconfirmedCommand,
  type CommandKey,
} from '@/lib/api/commands/command-retry';
import { useId, useState } from 'react';
import { ConfirmDialog } from '@/components/patterns/actions/confirm-dialog';
import type {
  ConnectionFormDefinition,
  ConnectionResponse,
} from '@pertexo/contracts';
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
  providerTestRequest,
  connectionNameError,
  connectionDefinition,
  suggestConnectionName,
  type ConnectionChoice,
} from '../../model/connection-providers';
import {
  credentialDraftHasSecret,
  toCreateRequest,
} from '../../model/credential-draft';
import {
  describeSavedCredential,
  type SavedCredential,
} from '../../model/saved-credential';
import { useOAuth2Consent } from '../../data/oauth2-consent.mutations';
import { useConnectionTest } from '../../data/connection-test.mutations';
import { useCredentialForm } from '../credential/use-form';
import { StepIndicator, type AddStep } from './steps';
import { StepBody } from './content';
import { AddConnectionFooter } from './content';

export type AddConnectionRequest = ConnectionChoice;

const DESCRIPTIONS: Readonly<Record<AddStep, string>> = {
  provider: 'Choose what Pertexo should plug into.',
  credential: 'Paste the key or token the service gave you.',
  name: 'Name it so people recognize it in steps and alerts.',
  connect: 'Sign in so Pertexo can get its token.',
  test: 'Check that the service accepts it.',
};

function stepDescription(
  step: AddStep,
  definition: ConnectionFormDefinition | undefined,
) {
  if (step === 'credential') {
    if (definition?.test === 'smtp')
      return 'Enter the settings supplied by your SMTP operator.';
    if (definition?.test === 'postgres')
      return 'Enter the PostgreSQL server and login details.';
  }
  return DESCRIPTIONS[step];
}

/**
 * The add lens: credential, name, then a test that runs straight away. The
 * connection is saved before its test, so a failed test can still be kept.
 * A lens opened from elsewhere (a step's connection slot) hears about the
 * saved connection through `onCreated` as it closes, to select it.
 */
type AddConnectionSheetProps = Readonly<{
  scope: ConnectionMutationScope;
  workspaceName: string;
  request: AddConnectionRequest | undefined;
  onClose: () => void;
  onCreated?: (connection: ConnectionResponse) => void;
}>;

export function AddConnectionSheet(props: AddConnectionSheetProps) {
  const model = useAddConnectionForm(props);
  return (
    <Sheet
      open={model.request !== undefined}
      onOpenChange={(open) => {
        if (!open) model.requestClose();
      }}
    >
      <SheetContent className="w-[min(28rem,calc(100vw-1.5rem))]">
        <SheetHeader className="gap-3">
          <SheetTitle>
            {model.definition === undefined
              ? 'Add a connection'
              : `Connect ${model.definition.presentation.name}`}
          </SheetTitle>
          <SheetDescription>
            {stepDescription(model.step, model.definition)}
          </SheetDescription>
          <StepIndicator step={model.step} />
        </SheetHeader>
        <SheetBody>
          {model.attempt.expired ? (
            <ExpiredAttemptNotice
              onNewAttempt={() => {
                model.attempt.clear();
                model.clearSensitiveState();
              }}
            />
          ) : null}
          <form
            id={`${model.id}-form`}
            noValidate
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              if (model.step === 'credential') model.continueToName();
              else if (model.step === 'name') void model.save();
            }}
          >
            <StepBody
              id={model.id}
              step={model.step}
              provider={model.provider}
              onChoose={(next, authType) => {
                model.chooseAuthType(authType);
                model.setChosen(next);
                model.setStep('credential');
              }}
              command={{
                disabled: model.create.isPending,
                uncertain: model.uncertain,
                createError:
                  model.createFailed && !model.attempt.expired
                    ? model.create.error
                    : undefined,
              }}
              result={{
                created: model.created,
                savedCredential: model.savedCredential,
                test: model.test,
                consent: model.consent,
              }}
              fields={{
                definition: model.definition,
                credential: model.credential,
                name: model.name,
                nameValidation: model.nameValidation,
                onCredentialChange: (next) => {
                  model.credential.setDraft(next);
                  if (model.create.isError) model.clearSensitiveState();
                },
                onNameChange: (next) => {
                  model.setNameInput(next);
                  if (model.create.isError) model.clearSensitiveState();
                },
              }}
            />
          </form>
        </SheetBody>
        <SheetFooter>
          <AddConnectionFooter
            formId={`${model.id}-form`}
            step={model.step}
            canGoBack={model.request === 'any'}
            saving={model.create.isPending}
            retrying={model.uncertain}
            tested={model.test.phase}
            useOAuth2={model.useOAuth2}
            onBack={() => {
              model.setStep(model.step === 'name' ? 'credential' : 'provider');
              if (model.step === 'credential') model.setChosen(undefined);
            }}
            onCancel={model.requestClose}
          />
        </SheetFooter>
      </SheetContent>
      <ConfirmDialog
        state={{
          open: model.confirmingDiscard,
          onOpenChange: model.setConfirmingDiscard,
          locked: false,
        }}
        title="Discard this connection?"
        description="The credential you pasted isn’t saved yet, so it’s lost if you leave now."
        onSubmit={() => {
          model.setConfirmingDiscard(false);
          model.close();
        }}
        actions={{
          cancel: { kind: 'close', label: 'Keep editing', variant: 'ghost' },
          confirm: {
            label: 'Discard',
            type: 'submit',
            variant: 'destructive',
            pendingLabel: 'Discard',
          },
        }}
      ></ConfirmDialog>
    </Sheet>
  );
}

function useAddConnectionForm({
  scope,
  workspaceName,
  request,
  onClose,
  onCreated,
}: AddConnectionSheetProps) {
  const id = useId();
  const notifications = useNotifications();
  const [chosen, setChosen] = useState<ConnectionChoice>();
  const [stepState, setStep] = useState<AddStep>();
  const [nameInput, setNameInput] = useState<string>();
  const [created, setCreated] = useState<ConnectionResponse>();
  const [savedCredential, setSavedCredential] = useState<SavedCredential>();
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [authType, chooseAuthType] = useState<string>();
  const provider = chosen ?? (request === 'any' ? undefined : request);
  const step: AddStep =
    stepState ?? (provider === undefined ? 'provider' : 'credential');
  const definitions = useConnectionDefinitions();
  const definition = connectionDefinition(definitions, provider, authType);
  const credential = useCredentialForm(definition);
  const useOAuth2 = definition?.test === 'oauth2';
  const nameValidation = useFieldValidation<'name'>();
  const { mutation: create, clearSensitiveState } =
    useCreateConnectionMutation(scope);
  const test = useConnectionTest(scope, { toastOnPass: false });
  const consent = useOAuth2Consent(scope, created, (connected) => {
    setCreated(connected);
    setStep('test');
    onCreated?.(connected);
  });
  const attempt = useCommandAttempt<HeldCommand>();
  const name = nameInput ?? suggestConnectionName(definition, workspaceName);

  function close() {
    if (create.isPending) return;
    if (created !== undefined) {
      notifications.success(savedMessage(created, test.phase === 'ok'));
      onCreated?.(test.result?.connection ?? created);
    }
    attempt.clear();
    setChosen(undefined);
    setStep(undefined);
    setNameInput(undefined);
    setCreated(undefined);
    setSavedCredential(undefined);
    chooseAuthType(undefined);
    credential.clear();
    nameValidation.reset();
    clearSensitiveState();
    test.reset();
    onClose();
  }

  function requestClose() {
    if (
      created === undefined &&
      credential.draft !== undefined &&
      credentialDraftHasSecret(credential.draft)
    )
      setConfirmingDiscard(true);
    else close();
  }

  function continueToName() {
    if (credential.validate() !== undefined) setStep('name');
  }

  async function save() {
    if (
      definition === undefined ||
      credential.draft === undefined ||
      create.isPending
    )
      return;
    if (!nameValidation.submit({ name: connectionNameError(name) })) return;
    const value = credential.validate();
    if (value === undefined) {
      setStep('credential');
      return;
    }
    const request = toCreateRequest(name.trim(), definition, value);
    const signature = JSON.stringify(request);
    if (attempt.current()?.signature !== signature) attempt.clear();
    const command = await attempt.getOrCreateKeyed(() => ({
      signature,
      request,
    }));
    if (command === undefined) return;
    let connection: ConnectionResponse;
    try {
      connection = await create.mutateAsync(command);
    } catch (error) {
      if (placeServerIssues(error, nameValidation, credential))
        setStep('credential');
      return;
    }
    attempt.clear();
    setSavedCredential(describeSavedCredential(credential.draft));
    credential.clear();
    clearSensitiveState();
    setCreated(connection);
    if (connection.authType === 'oauth2') {
      setStep('connect');
      return;
    }
    setStep('test');
    const automatic =
      definition.testAutomatically === true
        ? providerTestRequest(definition)
        : undefined;
    if (automatic !== undefined) test.run(connection, automatic);
  }

  const createFailed = create.isError && !isFieldProblem(create.error);
  const uncertain = create.isError && isUnconfirmedCommand(create.error);

  return {
    definition,
    request,
    attempt,
    requestClose,
    provider,
    step,
    id,
    continueToName,
    save,
    created,
    savedCredential,
    useOAuth2,
    chooseAuthType,
    consent,
    credential,
    name,
    nameValidation,
    create,
    uncertain,
    createFailed,
    test,
    setChosen,
    setStep,
    clearSensitiveState,
    setNameInput,
    confirmingDiscard,
    setConfirmingDiscard,
    close,
  } as const;
}

type HeldCommand = CreateConnectionCommand &
  CommandKey &
  Readonly<{ signature: string }>;
const NAME_REFUSED = 'Pertexo couldn’t use this name. Try a shorter one.';

const problemIssues = (error: unknown) =>
  isApiError(error) ? (error.problem?.errors ?? []) : [];

function savedMessage(connection: ConnectionResponse, passed: boolean) {
  const { name, authType, status } = connection;
  if (authType === 'oauth2' && status !== 'active')
    return {
      title: `Saved ${name}`,
      description: 'Connect it from its details when you’re ready.',
    };
  return passed
    ? { title: `Connected ${name}` }
    : { title: `Saved ${name}`, description: 'It hasn’t passed a test yet.' };
}

function isFieldProblem(error: unknown): boolean {
  return isApiError(error) && (error.problem?.errors?.length ?? 0) > 0;
}

/** Server field errors land on the name or the credential step. */
function placeServerIssues(
  error: unknown,
  nameValidation: ReturnType<typeof useFieldValidation<'name'>>,
  credential: ReturnType<typeof useCredentialForm>,
) {
  const issues = problemIssues(error);
  if (issues.some((issue) => issue.path === 'name'))
    nameValidation.showErrors({ name: NAME_REFUSED });
  return credential.showServerIssues(issues);
}
