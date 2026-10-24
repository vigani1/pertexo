import { useMemo, useState, type ReactNode } from 'react';
import { encode } from 'uqr';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { useLatestRequest } from '@/lib/hooks/use-latest-request';
import { Button } from '@/components/ui/button';
import { ProgressButton } from '@/components/ui/progress-button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useFieldValues } from '@/components/ui/use-field-validation';
import { CopyButton } from '@/components/ui/copy-button';
import { PasswordField } from '../../forms/password-field';
import { currentPasswordProblem } from '../../forms/field-rules';
import {
  enableTwoFactor,
  disableTwoFactor,
  regenerateRecoveryCodes,
} from '../../data/two-factor.api';
import { AccountCommandFailure } from '../account/section';
import { TwoFactorCodeForm } from './code-form';
import { useTwoFactorVerification } from './use-verify';
import { RecoveryCodes } from './recovery-codes';

type Stage =
  | Readonly<{ kind: 'password' }>
  | Readonly<{ kind: 'verify'; uri: string; codes: readonly string[] }>
  | Readonly<{ kind: 'codes'; codes: readonly string[] }>;
export type TwoFactorAction = 'enable' | 'disable' | 'regenerate';

function EnrollmentKey({ uri }: Readonly<{ uri: string }>) {
  const { data, size } = useMemo(() => encode(uri), [uri]);
  const secret = new URL(uri).searchParams.get('secret') ?? '';
  // Render only the encoder's boolean grid; the secret never enters markup as HTML or a remote image URL.
  const path = data
    .flatMap((row, y) =>
      row.flatMap((dark, x) =>
        dark ? [`M${String(x + 4)} ${String(y + 4)}h1v1h-1z`] : [],
      ),
    )
    .join('');
  return (
    <div className="flex flex-col items-start gap-3">
      <svg
        role="img"
        aria-label="Scan this QR code in your authenticator app"
        viewBox={`0 0 ${String(size + 8)} ${String(size + 8)}`}
        className="size-48 max-w-full"
        shapeRendering="crispEdges"
      >
        <rect width="100%" height="100%" fill="white" />
        <path d={path} fill="black" />
      </svg>
      <p className="text-sm text-muted-foreground">
        Can’t scan? Enter this key in your authenticator:
      </p>
      <div className="flex max-w-full items-center gap-2">
        <code className="break-all text-sm">{secret}</code>
        <CopyButton value={secret} label="Copy authenticator key" />
      </div>
    </div>
  );
}

const ACTION_COPY: Readonly<
  Record<TwoFactorAction, Readonly<{ title: string; description: string }>>
> = {
  enable: {
    title: 'Turn on two-factor sign-in',
    description:
      'Use an authenticator app to protect email and password sign-in. Your SSO or social provider manages its own verification.',
  },
  disable: {
    title: 'Turn off two-factor sign-in',
    description:
      'Your password will be the only check for email sign-in. Other devices stay signed in.',
  },
  regenerate: {
    title: 'Get new recovery codes',
    description: 'These replace all previous recovery codes.',
  },
};

type TwoFactorSetupProps = Readonly<{
  apiClient: ApiClient;
  action: TwoFactorAction;
  onClose: () => void;
  closing: boolean;
  onComplete: () => void;
}>;

export function TwoFactorSetupDialog({
  apiClient,
  action,
  onClose,
  closing,
  onComplete,
}: TwoFactorSetupProps) {
  const [stage, setStage] = useState<Stage>({ kind: 'password' });
  const [failure, setFailure] = useState<unknown>();
  const requests = useLatestRequest();
  const verification = useTwoFactorVerification({
    apiClient,
    method: 'totp',
    purpose: 'enrollment',
    onVerified: () => {
      if (stage.kind === 'verify')
        setStage({ kind: 'codes', codes: stage.codes });
    },
  });
  const busy = requests.pending || verification.pending || closing;
  const fields = useFieldValues(
    { password: currentPasswordProblem },
    { password: '' },
  );
  const { title, description } = ACTION_COPY[action];
  async function submit() {
    if (busy) return;
    const values = fields.validate();
    if (values === undefined) return;
    const request = requests.begin();
    setFailure(undefined);
    try {
      if (action === 'enable') {
        const result = await enableTwoFactor(
          apiClient,
          values.password,
          request.signal,
        );
        if (request.isCurrent())
          setStage({
            kind: 'verify',
            uri: result.totpURI,
            codes: result.backupCodes,
          });
      } else if (action === 'regenerate') {
        const result = await regenerateRecoveryCodes(
          apiClient,
          values.password,
          request.signal,
        );
        if (request.isCurrent())
          setStage({ kind: 'codes', codes: result.backupCodes });
      } else {
        await disableTwoFactor(apiClient, values.password, request.signal);
        if (request.isCurrent()) onComplete();
      }
    } catch (error) {
      if (request.isCurrent()) setFailure(error);
    } finally {
      if (request.isCurrent()) fields.reset();
      request.finish();
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy && stage.kind !== 'codes') onClose();
      }}
    >
      <DialogContent aria-busy={busy || undefined}>
        <DialogTitle>
          {stage.kind === 'codes' ? 'Save your recovery codes' : title}
        </DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        <SetupStage
          stage={stage}
          password={
            <PasswordSetup
              fields={fields}
              busy={busy}
              closing={closing}
              action={action}
              failure={failure}
              onSubmit={submit}
              onClose={onClose}
            />
          }
          verification={verification}
          busy={busy}
          onClose={onClose}
          onComplete={onComplete}
          closing={closing}
        />
      </DialogContent>
    </Dialog>
  );
}

function PasswordSetup({
  fields,
  busy,
  closing,
  action,
  failure,
  onSubmit,
  onClose,
}: Readonly<{
  fields: ReturnType<typeof useFieldValues<'password'>>;
  busy: boolean;
  closing: boolean;
  action: TwoFactorAction;
  failure: unknown;
  onSubmit: () => Promise<void>;
  onClose: () => void;
}>) {
  const { title } = ACTION_COPY[action];
  return (
    <form
      noValidate
      className="mt-6 flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      <PasswordField
        id="two-factor-password"
        label="Current password"
        autoComplete="current-password"
        disabled={busy}
        {...fields.field('password')}
        {...fields.control('password')}
      />
      {failure === undefined ? null : (
        <AccountCommandFailure
          error={failure}
          action="changing two-factor sign-in"
          message={
            isApiError(failure) && failure.status === 400
              ? 'Your current password wasn’t accepted. Check it and try again.'
              : undefined
          }
        />
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <ProgressButton
          type="submit"
          variant={action === 'disable' ? 'destructive' : 'primary'}
          pending={busy}
          pendingLabel={closing ? 'Finishing…' : 'Confirming…'}
        >
          {action === 'enable' ? 'Continue' : title}
        </ProgressButton>
      </div>
    </form>
  );
}

function SetupStage({
  stage,
  password,
  verification,
  busy,
  onClose,
  onComplete,
  closing,
}: Readonly<{
  stage: Stage;
  password: ReactNode;
  verification: ReturnType<typeof useTwoFactorVerification>;
  busy: boolean;
  onClose: () => void;
  onComplete: () => void;
  closing: boolean;
}>) {
  if (stage.kind === 'password') return password;
  if (stage.kind === 'verify')
    return (
      <div className="mt-6 flex flex-col gap-5">
        <EnrollmentKey uri={stage.uri} />
        <TwoFactorCodeForm verification={verification} />
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
          Cancel setup
        </Button>
      </div>
    );
  return (
    <RecoveryCodes codes={stage.codes} onDone={onComplete} pending={closing} />
  );
}
