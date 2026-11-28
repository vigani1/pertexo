import type { assistantSettingsSchema } from '@pertexo/contracts';
import { MODEL_IDENTIFIER_MAX_CHARACTERS } from '@pertexo/node-sdk';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import { SettingRow } from '@/components/patterns/settings/row';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import { RowList } from '@/components/patterns/lists/row';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
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
    <section aria-labelledby="assistant-settings">
      <RuleHeading id="assistant-settings">AI assistant</RuleHeading>
      {content}
    </section>
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
  const configured = selection !== null;
  const valid =
    model.trim() !== '' && options.some((option) => option.id === connectionId);
  const next = { connectionId, model: model.trim() };
  const edited =
    selection === null ||
    next.connectionId !== selection.connectionId ||
    next.model !== selection.model;

  async function save(next: Settings['selection']) {
    await command.mutateAsync({ selection: next }).catch(() => undefined);
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && edited) void save(next);
      }}
    >
      <RowList>
        <SettingRow
          title="Assistant"
          description="Explains failed runs in plain language. It reads the run and leaves connection secrets private."
          action={
            <Switch
              aria-label="Assistant"
              checked={configured}
              disabled={command.isPending || (!configured && !valid)}
              onCheckedChange={(checked) => {
                void save(checked ? next : null);
              }}
            />
          }
        />
        <SettingRow
          title="AI connection"
          description="The connection that sends questions to your provider."
          action={
            <Select
              value={connectionId}
              disabled={command.isPending}
              onValueChange={(value) => {
                setConnectionId(value ?? '');
              }}
            >
              <SelectTrigger aria-label="AI connection">
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
          }
        />
        <SettingRow
          title="Model identifier"
          description="Use the identifier your provider gives the model."
          action={
            <Input
              aria-label="Model identifier"
              value={model}
              disabled={command.isPending}
              maxLength={MODEL_IDENTIFIER_MAX_CHARACTERS}
              onChange={(event) => {
                setModel(event.target.value);
              }}
            />
          }
        />
      </RowList>
      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Add an active AI connection in Connections to turn on the assistant.
        </p>
      ) : null}
      {configured ? (
        <Button
          type="submit"
          variant="outline"
          className="self-end"
          disabled={command.isPending || !valid || !edited}
        >
          Save assistant settings
        </Button>
      ) : null}
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
    </form>
  );
}
