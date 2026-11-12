import { useState } from 'react';
import {
  webhookAuthenticationSchema,
  type WebhookAuthentication,
} from '@pertexo/contracts';
import { LabelledField } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { useFieldValidation } from '@/components/ui/use-field-validation';

interface ListenerAuthenticationProps {
  pending: boolean;
  onListen: (authentication: WebhookAuthentication) => void;
}

export function ListenerAuthentication({
  pending,
  onListen,
}: ListenerAuthenticationProps) {
  const [mode, setMode] = useState('signed');
  const [headerName, setHeaderName] = useState('authorization');
  const [origins, setOrigins] = useState('');
  const validation = useFieldValidation<'headerName' | 'allowedOrigins'>();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const result = webhookAuthenticationSchema.safeParse({
          mode,
          allowedOrigins:
            mode === 'signed'
              ? []
              : origins
                  .split('\n')
                  .map((value) => value.trim())
                  .filter(Boolean),
          ...(mode === 'header_secret'
            ? { headerName: headerName.trim().toLowerCase() }
            : {}),
        });
        if (
          validation.submit({
            headerName: result.success
              ? undefined
              : result.error.issues.find(
                  (issue) => issue.path[0] === 'headerName',
                )?.message,
            allowedOrigins: result.success
              ? undefined
              : result.error.issues.find(
                  (issue) => issue.path[0] === 'allowedOrigins',
                )?.message,
          }) &&
          result.success
        )
          onListen(result.data);
      }}
    >
      <LabelledField
        id="test-webhook-authentication"
        label="Test authentication"
      >
        {(control) => (
          <Select
            disabled={pending}
            value={mode}
            items={[
              { value: 'signed', label: 'Signed' },
              { value: 'secret_url', label: 'Secret URL' },
              { value: 'header_secret', label: 'Header secret' },
            ]}
            onValueChange={(value) => {
              if (value !== null) {
                setMode(value);
                validation.reset();
              }
            }}
          >
            <SelectTrigger {...control}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="signed">Signed</SelectItem>
              <SelectItem value="secret_url">Secret URL</SelectItem>
              <SelectItem value="header_secret">Header secret</SelectItem>
            </SelectContent>
          </Select>
        )}
      </LabelledField>
      {mode === 'header_secret' ? (
        <LabelledField
          id="test-webhook-header"
          label="Secret header"
          error={validation.error('headerName')}
        >
          {(control) => (
            <Input
              {...control}
              disabled={pending}
              ref={validation.register('headerName')}
              value={headerName}
              onChange={(event) => {
                setHeaderName(event.target.value);
                const parsed = webhookAuthenticationSchema.safeParse({
                  mode: 'header_secret',
                  headerName: event.target.value.trim().toLowerCase(),
                  allowedOrigins: [],
                });
                validation.change(
                  'headerName',
                  parsed.success ? undefined : parsed.error.issues[0]?.message,
                );
              }}
            />
          )}
        </LabelledField>
      ) : null}
      {mode !== 'signed' ? (
        <LabelledField
          id="test-webhook-origins"
          label="Allowed browser origins (optional)"
          error={validation.error('allowedOrigins')}
          description="One exact http or https origin per line. Leave empty for server senders."
        >
          {(control) => (
            <Textarea
              {...control}
              disabled={pending}
              ref={validation.register('allowedOrigins')}
              value={origins}
              onChange={(event) => {
                setOrigins(event.target.value);
                const parsed = webhookAuthenticationSchema.safeParse({
                  mode: 'secret_url',
                  allowedOrigins: event.target.value
                    .split('\n')
                    .map((value) => value.trim())
                    .filter(Boolean),
                });
                validation.change(
                  'allowedOrigins',
                  parsed.success ? undefined : parsed.error.issues[0]?.message,
                );
              }}
            />
          )}
        </LabelledField>
      ) : null}
      {mode === 'secret_url' ? (
        <Notice>
          Anyone with the test URL can send the sample. Keep it private.
        </Notice>
      ) : null}
      <ProgressButton
        type="submit"
        pending={pending}
        pendingLabel="Opening listener…"
      >
        Listen for test event
      </ProgressButton>
    </form>
  );
}
