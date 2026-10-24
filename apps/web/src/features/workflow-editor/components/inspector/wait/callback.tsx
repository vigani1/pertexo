import { isRecord } from '@pertexo/workflow-model';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import type { NodeConfig } from '../../../model/inspector/draft';
import { nestedConfigForm } from '../../../model/inspector/nested-config-form';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import { ChoiceSelect } from '../fields/choice-select';
import { SchemaField } from '../fields/schema-field';

export function CallbackSetup({
  config,
  form,
}: Readonly<{ config: NodeConfig; form: NodeFormApi }>) {
  const authentication = isRecord(config.authentication)
    ? config.authentication
    : { mode: 'secret_url', allowedOrigins: [] };
  const authenticationForm = nestedConfigForm(form, 'authentication');
  return (
    <>
      <Field>
        <FieldLabel htmlFor={fieldControlId(form.nodeId, 'callback-auth')}>
          Callback authentication
        </FieldLabel>
        <ChoiceSelect
          value={
            typeof authentication.mode === 'string'
              ? authentication.mode
              : 'secret_url'
          }
          disabled={!form.editable}
          choices={[
            { value: 'secret_url', label: 'Secret URL' },
            { value: 'signed', label: 'Signed (HMAC)' },
            { value: 'header_secret', label: 'Header secret' },
          ]}
          onChange={(mode) => {
            if (mode === null) return;
            form.commit(
              (node) => ({
                config: {
                  ...node.config,
                  authentication:
                    mode === 'header_secret'
                      ? {
                          mode,
                          headerName: 'authorization',
                          allowedOrigins: [],
                        }
                      : { mode, allowedOrigins: [] },
                },
              }),
              `${form.nodeId}:callback-auth`,
            );
          }}
          control={{ id: fieldControlId(form.nodeId, 'callback-auth') }}
        />
        <FieldDescription>
          {callbackAuthenticationDescription(authentication.mode)}
        </FieldDescription>
      </Field>
      {authentication.mode === 'header_secret' ? (
        <SchemaField
          config={authentication}
          form={authenticationForm}
          field={{
            key: 'headerName',
            label: 'Secret header name',
            kind: 'string',
            required: true,
            description:
              'authorization uses Bearer; dedicated headers send the secret directly. Proxy, cookie and reserved headers are refused.',
          }}
        />
      ) : null}
      <p className="text-xs leading-relaxed text-subtle-foreground">
        To send the URL, open an earlier HTTP, Slack or email step and insert it
        from Inputs → Insert data. Test workflow runs can be called back;
        testing this step alone can’t.
      </p>
    </>
  );
}

function callbackAuthenticationDescription(mode: unknown): string {
  if (mode === 'secret_url')
    return 'Anyone with the URL can resume the run, so send it only to a service you trust.';
  if (mode === 'signed')
    return 'The service signs each call with a shared secret, using the same signature headers as Pertexo webhooks.';
  return 'The service sends a shared secret in a header, Authorization: Bearer by default.';
}
