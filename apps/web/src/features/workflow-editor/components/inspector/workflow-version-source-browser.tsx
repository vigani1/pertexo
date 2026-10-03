import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  workflowVersionSourcesQueryOptions,
  type VersionSourceScope,
} from '../../workflow-version-sources.queries';
import { WorkflowSourcePicker } from './workflow-source-picker';
import { VersionSourcePreview } from './version-source-preview';

/** No draft or form interface: this browser can only inspect and copy source. */
export function WorkflowVersionSourceBrowser({
  scope,
}: Readonly<{ scope: VersionSourceScope }>) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button type="button" variant="outline" size="sm" className="w-fit" />
        }
      >
        Browse version source
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Browse version source</DialogTitle>
        <DialogDescription>
          Inspect published source in this workspace. Nothing here selects,
          upgrades or changes the Call pin.
        </DialogDescription>
        {open ? (
          <SourceDiscovery
            key={`${scope.userId}:${scope.workspaceId}`}
            scope={scope}
          />
        ) : null}
        <DialogClose
          render={<Button type="button" variant="outline" className="mt-4" />}
        >
          Close source browser
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

function SourceDiscovery({ scope }: Readonly<{ scope: VersionSourceScope }>) {
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  return (
    <FieldGroup className="mt-4 gap-4">
      <WorkflowSourcePicker
        scope={scope}
        selected={workflowId}
        onSelect={setWorkflowId}
      />
      {workflowId === null ? null : (
        <VersionSources
          key={workflowId}
          scope={scope}
          workflowId={workflowId}
        />
      )}
    </FieldGroup>
  );
}

function VersionSources({
  scope,
  workflowId,
}: Readonly<{ scope: VersionSourceScope; workflowId: string }>) {
  const [versionId, setVersionId] = useState<string | null>(null);
  const versions = useQuery(
    workflowVersionSourcesQueryOptions(scope, workflowId),
  );
  if (versions.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading published version sources…
      </p>
    );
  if (versions.isError)
    return (
      <Notice
        tone="destructive"
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void versions.refetch();
            }}
          >
            Retry version sources
          </Button>
        }
      >
        Version discovery is incomplete: the read failed or reached its bounded
        page limit. This does not mean the pinned version is absent or that no
        newer source exists.
      </Notice>
    );
  const items = versions.data.items;
  if (items.length === 0)
    return (
      <Notice>
        No published version sources were returned for this workflow.
      </Notice>
    );
  const selected = items.find((version) => version.id === versionId);
  const options = items.map((version) => ({
    value: version.id,
    label: `v${String(version.versionNumber)} — ${version.id}`,
  }));
  return (
    <FieldGroup className="gap-4">
      <LabelledField
        id="version-source-version"
        label="Published version source"
        description="Choose an exact immutable version to inspect. The list does not establish executable eligibility."
      >
        {(control) => (
          <Select
            items={options}
            value={versionId}
            onValueChange={(value) => {
              if (
                typeof value === 'string' &&
                items.some((version) => version.id === value)
              )
                setVersionId(value);
            }}
          >
            <SelectTrigger {...control}>
              <SelectValue placeholder="Choose a version to inspect" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
      </LabelledField>
      {selected === undefined ? null : (
        <VersionSourcePreview key={selected.id} version={selected} />
      )}
    </FieldGroup>
  );
}
