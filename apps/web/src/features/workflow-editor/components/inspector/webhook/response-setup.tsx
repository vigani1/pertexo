import type { NodeConfig } from '../../../model/inspector/draft';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { SchemaField } from '../fields/schema';

export function WebhookResponseSetup({
  config,
  form,
}: Readonly<{ config: NodeConfig; form: NodeFormApi }>) {
  return (
    <>
      <SchemaField
        config={{ ...config, bodyType: config.bodyType ?? 'json' }}
        form={form}
        field={{
          key: 'bodyType',
          label: 'Response body',
          kind: 'string',
          required: true,
          options: ['json', 'text'],
          optionLabels: { json: 'JSON', text: 'Plain text' },
        }}
      />
      {config.bodyType === 'text' ? (
        <SchemaField
          config={{
            ...config,
            textContentType: config.textContentType ?? 'text/plain',
          }}
          form={form}
          field={{
            key: 'textContentType',
            label: 'Text format',
            kind: 'string',
            required: true,
            options: ['text/plain', 'text/csv'],
            optionLabels: {
              'text/plain': 'Plain text',
              'text/csv': 'CSV',
            },
          }}
        />
      ) : null}
      <p className="text-sm text-muted-foreground">
        Map the body on Inputs. Status is 200 unless you map statusCode
        (200–599). Responses are up to 1 MB within the normal input limits.
      </p>
      <p className="text-xs text-subtle-foreground">
        Optional headers: content-language, retry-after, x-request-id and
        x-correlation-id, or custom x- headers (no proxy or security overrides).
        Up to 16 headers. Content type is set automatically. Status 204, 205 or
        304 needs empty plain text.
      </p>
      <p className="text-xs text-subtle-foreground">
        The first response wins and the workflow continues. Only an original
        waiting webhook can reply; tests, replay and recovery never reply to its
        caller.
      </p>
    </>
  );
}
