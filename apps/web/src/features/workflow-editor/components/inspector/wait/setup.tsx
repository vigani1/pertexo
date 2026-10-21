import {
  callbackWaitConfigSchema,
  isRecord,
  WAIT_MAXIMUM_SECONDS,
} from '@pertexo/workflow-model';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import type { NodeConfig } from '../../../model/inspector/draft';
import { nestedConfigForm } from '../../../model/inspector/nested-config-form';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import { ChoiceSelect } from '../fields/choice-select';
import { SchemaField } from '../fields/schema-field';

export function WaitSetup({
  config,
  form,
}: Readonly<{ config: NodeConfig; form: NodeFormApi }>) {
  const callback = config.mode === 'callback';
  const authentication = isRecord(config.authentication)
    ? config.authentication
    : { mode: 'secret_url', allowedOrigins: [] };
  const authenticationForm = nestedConfigForm(form, 'authentication');
  return (
    <>
      <Field>
        <FieldLabel htmlFor={fieldControlId(form.nodeId, 'wait-mode')}>
          Wait until
        </FieldLabel>
        <ChoiceSelect
          id={fieldControlId(form.nodeId, 'wait-mode')}
          value={callback ? 'callback' : 'duration'}
          disabled={!form.editable}
          choices={[
            { value: 'duration', label: 'A duration has passed' },
            { value: 'callback', label: 'Called back' },
          ]}
          onChange={(mode) => {
            if (mode === null || (mode === 'callback') === callback) return;
            form.commit(
              {
                config:
                  mode === 'callback'
                    ? callbackWaitConfigSchema.parse({
                        mode: 'callback',
                        timeoutSeconds: 3600,
                      })
                    : { durationSeconds: 60 },
              },
              `${form.nodeId}:wait-mode`,
            );
          }}
        />
        <FieldDescription>
          {callback
            ? 'An earlier sending step can insert this Wait’s callback URL. The first authenticated POST resumes this run once.'
            : 'Pause for a fixed duration. Draft workflow tests complete duration waits immediately.'}
        </FieldDescription>
      </Field>
      <SchemaField
        config={config}
        form={form}
        field={{
          key: callback ? 'timeoutSeconds' : 'durationSeconds',
          label: callback ? 'Callback timeout (seconds)' : 'Wait for (seconds)',
          kind: 'integer',
          required: true,
          minimum: 1,
          maximum: WAIT_MAXIMUM_SECONDS,
          description: callback
            ? 'From 1 second to 30 days, starting when this step opens. A timeout fails the step; add a failure route to handle it.'
            : 'From 1 second to 30 days.',
        }}
      />
      {callback ? (
        <>
          <Field>
            <FieldLabel htmlFor={fieldControlId(form.nodeId, 'callback-auth')}>
              Callback authentication
            </FieldLabel>
            <ChoiceSelect
              id={fieldControlId(form.nodeId, 'callback-auth')}
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
            />
            <FieldDescription>
              {authentication.mode === 'secret_url'
                ? 'Anyone holding the URL can resume this Wait. Send it only to a trusted service.'
                : authentication.mode === 'signed'
                  ? 'Map the authentication secret to the sender. Sign the exact request bytes using the normal Pertexo webhook signature and timestamp headers.'
                  : 'Map the authentication secret to the sender. Use Authorization: Bearer, or choose a dedicated header.'}
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
          <p className="text-xs text-subtle-foreground">
            In an earlier HTTP, Slack or email step, choose Inputs → Insert data
            → this Wait. Test workflow supports live callbacks; single-step
            previews do not.
          </p>
        </>
      ) : null}
    </>
  );
}
