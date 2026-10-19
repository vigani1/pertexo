import { useState } from 'react';
import { SearchIcon } from 'lucide-react';
import { VariableUsageDialog } from '../components/usage';
import { useQuery } from '@tanstack/react-query';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { SettingsSection } from '@/components/patterns/settings/section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { StatusGlyph } from '@/components/ui/status';
import { variablesQueryOptions } from '../data/variables.queries';
import type { VariablesScope } from '../data/variables.api';
import { VariablesEditor } from '../components/editor';
import { variableMatches, variableRows } from '../model/draft';
import { Disclosure } from '@/components/ui/disclosure';
export function WorkspaceVariablesPage({
  scope,
  workspace,
}: Readonly<{ scope: VariablesScope; workspace: AccessibleWorkspace }>) {
  const [inspected, setInspected] = useState<string>();
  const [filter, setFilter] = useState('');
  const query = useQuery(variablesQueryOptions(scope));
  const snapshot = query.data;
  const editable =
    workspace.status === 'active' &&
    workspace.capabilities.includes('variable:manage');
  return (
    <div className="flex min-w-0 max-w-5xl flex-col gap-6">
      <PageHeader>
        <div className="flex flex-col gap-3">
          <PageHeaderTitle>Variables</PageHeaderTitle>
          {/* How values reach runs, read under the title; the section
              below draws the page's one divider. */}
          <div className="flex flex-col gap-1.5 text-sm text-muted-foreground sm:flex-row sm:gap-6">
            <p className="flex items-center gap-2">
              <StatusGlyph tone="live" />
              New runs take the current values.
            </p>
            <p className="flex items-center gap-2">
              <StatusGlyph tone="success" />
              Existing runs keep their captured set.
            </p>
          </div>
        </div>
      </PageHeader>
      <SettingsSection
        title="Shared configuration"
        description="Text, numbers and true/false that every member can read. Secrets belong in Connections."
      >
        <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
          <p>
            Use <code translate="no">$vars.NAME</code> in a step’s mappings.
          </p>
          <Disclosure summary="Limits" size="xs" className="text-xs">
            <p className="max-w-lg leading-relaxed">
              Up to 100 names, 4,096 characters per text value and 32 KB in all.
              A replay, a recovery or a child workflow keeps the values its run
              started with.
            </p>
          </Disclosure>
        </div>
        {query.isError ? (
          <Notice
            tone="warning"
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void query.refetch()}
              >
                Refresh values
              </Button>
            }
          >
            {snapshot === undefined
              ? 'Workspace variables could not be loaded.'
              : 'Current values could not be refreshed; showing the last revision.'}
          </Notice>
        ) : null}
        {snapshot !== undefined && Object.keys(snapshot.values).length > 5 ? (
          <div className="relative max-w-xs">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground"
            />
            <Input
              type="search"
              aria-label="Filter variables"
              placeholder="Filter by name or value"
              className="pl-8"
              value={filter}
              onChange={(event) => {
                setFilter(event.currentTarget.value);
              }}
            />
          </div>
        ) : null}
        {snapshot === undefined ? (
          query.isPending ? (
            <p role="status">Loading workspace variables…</p>
          ) : null
        ) : editable ? (
          <VariablesEditor scope={scope} snapshot={snapshot} filter={filter} />
        ) : (
          <>
            <Notice>
              Only owners and admins in an active workspace can change shared
              variables.
            </Notice>
            <dl className="divide-y divide-border">
              {variableRows(snapshot.values, snapshot.descriptions)
                .filter((row) => variableMatches(row, filter))
                .map(({ name, value, description }) => (
                  <div
                    key={name}
                    className="flex min-w-0 flex-col gap-1 py-3 sm:flex-row sm:gap-6"
                  >
                    <dt className="min-w-0 font-mono text-sm [overflow-wrap:anywhere]">
                      {name}
                    </dt>
                    <dd className="break-words whitespace-pre-wrap text-sm">
                      <p>{value}</p>
                      {description === '' ? null : (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {description}
                        </p>
                      )}
                    </dd>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setInspected(name);
                      }}
                    >
                      References
                    </Button>
                  </div>
                ))}
            </dl>
            {Object.keys(snapshot.values).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No workspace variables configured.
              </p>
            ) : null}
          </>
        )}
      </SettingsSection>
      {inspected === undefined ? null : (
        <VariableUsageDialog
          scope={scope}
          name={inspected}
          onClose={() => {
            setInspected(undefined);
          }}
        />
      )}
    </div>
  );
}
