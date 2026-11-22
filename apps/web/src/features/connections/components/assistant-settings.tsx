import { assistantSettingsSchema } from '@pertexo/contracts';
import { MODEL_IDENTIFIER_MAX_CHARACTERS } from '@pertexo/node-sdk';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import { SettingsSection } from '@/components/patterns/settings/section';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { editorConnectionsQueryOptions } from '../data/connections.queries';
import { describeReadError } from '@/lib/api/error-copy';
import {
  assistantSettingsQueryOptions,
  useAssistantSettings,
} from '../data/assistant-settings.mutations';

type Scope = Parameters<typeof assistantSettingsQueryOptions>[0];
type Settings = z.output<typeof assistantSettingsSchema>;

export function AssistantSettings({ scope }: Readonly<{ scope: Scope }>) {
  const settings = useQuery(assistantSettingsQueryOptions(scope));
  const connections = useQuery(
    editorConnectionsQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspaceId,
    ),
  );
  const options = connections.data?.items.filter(
    (connection) =>
      connection.providerKey === 'ai' && connection.status === 'active',
  );
  const error = settings.error ?? connections.error;

  let content;
  if (error !== null)
    content = (
      <p role="alert" className="text-sm text-destructive">
        {describeReadError(error, 'AI assistant settings')}
      </p>
    );
  else if (settings.data === undefined || options === undefined)
    content = (
      <p role="status" className="text-sm text-muted-foreground">
        Loading assistant settings…
      </p>
    );
  else
    content = (
      <AssistantSelection
        key={JSON.stringify(settings.data.selection)}
        scope={scope}
        selection={settings.data.selection}
        options={options}
      />
    );

  return (
    <SettingsSection
      title="AI assistant"
      description="Choose the connection and model that explain failed runs in this workspace."
    >
      {content}
    </SettingsSection>
  );
}

function AssistantSelection({
  scope,
  selection,
  options,
}: Readonly<{
  scope: Scope;
  selection: Settings['selection'];
  options: readonly Readonly<{ id: string; name: string }>[];
}>) {
  const [connectionId, setConnectionId] = useState(
    selection?.connectionId ?? '',
  );
  const [model, setModel] = useState(selection?.model ?? '');
  const command = useAssistantSettings(scope);

  async function save(next: Settings['selection']) {
    await command.mutateAsync({ selection: next }).catch(() => undefined);
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save({ connectionId, model: model.trim() });
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="assistant-connection">AI connection</FieldLabel>
          <Select
            value={connectionId}
            onValueChange={(value) => {
              setConnectionId(value ?? '');
            }}
          >
            <SelectTrigger id="assistant-connection">
              <SelectValue placeholder="Choose a connection" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {options.map((connection) => (
                  <SelectItem key={connection.id} value={connection.id}>
                    {connection.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="assistant-model">Model identifier</FieldLabel>
          <Input
            id="assistant-model"
            value={model}
            maxLength={MODEL_IDENTIFIER_MAX_CHARACTERS}
            onChange={(event) => {
              setModel(event.currentTarget.value);
            }}
          />
        </Field>
      </FieldGroup>
      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Add an active AI connection in Connections to turn on the assistant.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={
            command.isPending ||
            model.trim() === '' ||
            !options.some((option) => option.id === connectionId)
          }
        >
          Save assistant settings
        </Button>
        {selection === null ? null : (
          <Button
            type="button"
            variant="outline"
            disabled={command.isPending}
            onClick={() => {
              void save(null);
            }}
          >
            Turn off assistant
          </Button>
        )}
      </div>
      {command.error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {describeReadError(command.error, 'AI assistant settings')}
        </p>
      )}
      {command.data?.kind === 'connection_unavailable' ? (
        <p role="alert" className="text-sm text-destructive">
          Choose an active AI connection you can use.
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground" role="status">
        {selection === null ? 'Assistant is off.' : 'Assistant is on.'}
      </p>
    </form>
  );
}
