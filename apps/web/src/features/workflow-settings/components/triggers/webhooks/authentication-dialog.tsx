import { useState, type Dispatch, type SetStateAction } from 'react';
import {
  webhookAuthenticationSchema,
  type WebhookAuthentication,
} from '@pertexo/contracts';
import { ConfirmDialog } from '@/components/patterns/actions/confirm-dialog';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useFieldValidation } from '@/components/ui/use-field-validation';

const MODES = [
  { value: 'signed', label: 'Signed' },
  { value: 'secret_url', label: 'Secret URL' },
  { value: 'header_secret', label: 'Header secret' },
];
type FormFields = 'headerName' | 'allowedOrigins';
export function WebhookAuthenticationDialog({
  authentication,
  pending,
  blocked,
  error,
  onSave,
  onClose,
}: Readonly<{
  authentication: WebhookAuthentication;
  pending: boolean;
  blocked: boolean;
  error?: string | undefined;
  onSave: (value: WebhookAuthentication) => Promise<unknown>;
  onClose: () => void;
}>) {
  const [draft, setDraft] = useState<AuthenticationDraft>({
    mode: authentication.mode,
    headerName:
      authentication.mode === 'header_secret'
        ? authentication.headerName
        : 'authorization',
    origins: authentication.allowedOrigins.join('\n'),
  });
  const validation = useFieldValidation<FormFields>();
  const value = () => ({
    mode: draft.mode,
    ...(draft.mode === 'header_secret'
      ? { headerName: draft.headerName.trim().toLowerCase() }
      : {}),
    allowedOrigins:
      draft.mode === 'signed'
        ? []
        : draft.origins
            .split('\n')
            .map((origin) => origin.trim())
            .filter(Boolean),
  });
  const changesCredential =
    draft.mode !== authentication.mode ||
    (authentication.mode === 'header_secret' &&
      draft.headerName.trim().toLowerCase() !== authentication.headerName);
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Webhook authentication"
      description="Choose how senders prove they may start this workflow."
      error={error}
      confirmDisabled={blocked && !pending}
      confirmLabel={
        changesCredential
          ? 'Save and rotate credentials'
          : 'Save authentication'
      }
      pendingLabel="Saving…"
      pending={pending}
      onConfirm={async () => {
        const parsed = webhookAuthenticationSchema.safeParse(value());
        const issues = parsed.success ? [] : parsed.error.issues;
        if (
          validation.submit({
            headerName: issues.find((issue) => issue.path[0] === 'headerName')
              ?.message,
            allowedOrigins: issues.find(
              (issue) => issue.path[0] === 'allowedOrigins',
            )?.message,
          }) &&
          parsed.success
        )
          await onSave(parsed.data);
      }}
    >
      <LabelledField id="webhook-mode" label="Authentication mode">
        {(control) => (
          <Select
            value={draft.mode}
            items={MODES}
            disabled={pending}
            onValueChange={(mode) => {
              if (mode !== null) {
                setDraft((current) => ({ ...current, mode }));
                validation.reset();
              }
            }}
          >
            <SelectTrigger {...control}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map((mode) => (
                <SelectItem key={mode.value} value={mode.value}>
                  {mode.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </LabelledField>
      <p className="text-sm text-muted-foreground">
        {AUTHENTICATION_COPY[draft.mode]}
      </p>
      <WebhookCredentialFields
        draft={draft}
        setDraft={setDraft}
        validation={validation}
        pending={pending}
        value={value}
      />
      {changesCredential ? (
        <p className="text-sm text-muted-foreground">
          This immediately replaces the URL and secret. Existing senders stop
          working until updated. Store the new credentials when they appear.
        </p>
      ) : null}
    </ConfirmDialog>
  );
}

const AUTHENTICATION_COPY: Readonly<
  Record<WebhookAuthentication['mode'], string>
> = {
  signed:
    'Signs the exact request bytes and checks a five-minute timestamp. Recommended when the sender supports it.',
  secret_url:
    'The URL is the only credential. Anyone who obtains it can start runs. Keep it private and rotate it if shared accidentally.',
  header_secret:
    'Send the generated secret in Authorization: Bearer, or a header used only for this credential. Use HTTPS.',
};

interface AuthenticationDraft {
  mode: WebhookAuthentication['mode'];
  headerName: string;
  origins: string;
}
function WebhookCredentialFields({
  draft,
  setDraft,
  validation,
  pending,
  value,
}: Readonly<{
  draft: AuthenticationDraft;
  setDraft: Dispatch<SetStateAction<AuthenticationDraft>>;
  validation: ReturnType<typeof useFieldValidation<FormFields>>;
  pending: boolean;
  value: () => {
    mode: WebhookAuthentication['mode'];
    headerName?: string;
    allowedOrigins: string[];
  };
}>) {
  return (
    <>
      {draft.mode === 'header_secret' ? (
        <LabelledField
          id="webhook-header"
          label="Secret header"
          description="Use authorization for Bearer, or a dedicated name such as x-webhook-secret."
          error={validation.error('headerName')}
        >
          {(control) => (
            <Input
              {...control}
              ref={validation.register('headerName')}
              disabled={pending}
              value={draft.headerName}
              onChange={(event) => {
                const headerName = event.target.value;
                setDraft((current) => ({ ...current, headerName }));
                const parsed = webhookAuthenticationSchema.safeParse({
                  ...value(),
                  headerName: headerName.trim().toLowerCase(),
                });
                validation.change(
                  'headerName',
                  parsed.success
                    ? undefined
                    : parsed.error.issues.find(
                        (issue) => issue.path[0] === 'headerName',
                      )?.message,
                );
              }}
            />
          )}
        </LabelledField>
      ) : null}
      {draft.mode === 'signed' ? null : (
        <LabelledField
          id="webhook-origins"
          label="Allowed browser origins"
          description="Optional, one exact origin per line, for example https://app.example.com. No paths, trailing slashes or wildcards. Server callers need no origin."
          error={validation.error('allowedOrigins')}
        >
          {(control) => (
            <Textarea
              {...control}
              ref={validation.register('allowedOrigins')}
              disabled={pending}
              value={draft.origins}
              onChange={(event) => {
                const origins = event.target.value;
                setDraft((current) => ({ ...current, origins }));
                const parsed = webhookAuthenticationSchema.safeParse({
                  ...value(),
                  allowedOrigins: origins
                    .split('\n')
                    .map((origin) => origin.trim())
                    .filter(Boolean),
                });
                validation.change(
                  'allowedOrigins',
                  parsed.success
                    ? undefined
                    : parsed.error.issues.find(
                        (issue) => issue.path[0] === 'allowedOrigins',
                      )?.message,
                );
              }}
            />
          )}
        </LabelledField>
      )}
    </>
  );
}
