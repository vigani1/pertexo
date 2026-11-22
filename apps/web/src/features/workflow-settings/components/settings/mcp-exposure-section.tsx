import { useQuery } from '@tanstack/react-query';
import {
  MCP_ENDPOINT_PATH,
  MCP_TOOL_LIMITS,
  type WorkflowMcpSettings,
} from '@pertexo/contracts';
import { SettingsSection } from '@/components/patterns/settings/section';
import { QueryView } from '@/components/patterns/states/query-view';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { shownData } from '@/lib/api/error-copy';
import { mcpExposureQuery } from '../../data/mcp-exposure.queries';
import { useMcpExposureDraft } from '../../hooks/use-mcp-exposure-draft';
import { settingsReadFailure } from '../settings-read-failure';
import { CopyField } from '../copy-field';

type Scope = Parameters<typeof mcpExposureQuery>[0];
export function McpExposureSection({ scope }: Readonly<{ scope: Scope }>) {
  const query = useQuery(mcpExposureQuery(scope));
  const settings = shownData(query);
  return (
    <SettingsSection
      title="MCP exposure"
      description="Expose a reviewed published version as a tool for clients with a workspace API token."
    >
      {settings === undefined ? (
        <QueryView
          query={query}
          resource="MCP exposure"
          failure={settingsReadFailure}
        />
      ) : (
        <McpExposureEditor scope={scope} settings={settings} />
      )}
    </SettingsSection>
  );
}

function McpExposureEditor({
  scope,
  settings,
}: Readonly<{ scope: Scope; settings: WorkflowMcpSettings }>) {
  const { exposure, eligible } = settings;
  const draft = useMcpExposureDraft(scope, settings);
  const endpoint = new URL(
    MCP_ENDPOINT_PATH.replace(
      '{workspaceId}',
      encodeURIComponent(scope.workspaceId),
    ),
    window.location.origin,
  ).href;

  return (
    <form
      className="flex max-w-lg flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void draft.expose();
      }}
    >
      {draft.exposed ? (
        <CopyField label="MCP endpoint" value={endpoint} />
      ) : null}
      {draft.reviewRequired ? (
        <Notice
          tone="warning"
          action={
            <Button
              variant="outline"
              type="button"
              onClick={() => {
                draft.reviewCurrentVersion();
              }}
            >
              Use current version
            </Button>
          }
        >
          The published version or exposure changed while you were editing.
        </Notice>
      ) : null}
      {exposure !== null && !draft.exposed ? (
        <Notice tone="warning">
          A new version was published. Review the new contract before exposing
          it.
        </Notice>
      ) : null}
      {eligible ? (
        <>
          <LabelledField id="mcp-tool-name" label="Tool name">
            {(control) => (
              <Input
                {...control}
                value={draft.name}
                required
                maxLength={MCP_TOOL_LIMITS.nameCharacters}
                disabled={draft.pending}
                onChange={(event) => {
                  draft.setName(event.target.value);
                }}
              />
            )}
          </LabelledField>
          <LabelledField id="mcp-tool-description" label="Tool description">
            {(control) => (
              <Textarea
                {...control}
                value={draft.description}
                required
                maxLength={MCP_TOOL_LIMITS.descriptionCharacters}
                disabled={draft.pending}
                onChange={(event) => {
                  draft.setDescription(event.target.value);
                }}
              />
            )}
          </LabelledField>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Publish a workflow with a callable object input and declared result to
          expose it.
        </p>
      )}
      {draft.failure === undefined ? null : (
        <Notice tone="destructive">{draft.failure}</Notice>
      )}
      <div className="flex flex-wrap gap-2">
        {eligible ? (
          <ProgressButton
            type="submit"
            pending={draft.pending}
            pendingLabel="Saving…"
            disabled={!draft.canExpose}
          >
            {draft.exposed ? 'Update exposure' : 'Expose published version'}
          </ProgressButton>
        ) : null}
        {exposure === null ? null : (
          <Button
            type="button"
            variant="outline"
            disabled={draft.pending}
            onClick={() => {
              void draft.revoke();
            }}
          >
            Revoke exposure
          </Button>
        )}
      </div>
    </form>
  );
}
