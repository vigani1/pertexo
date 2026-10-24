import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  WorkflowPromotionSettings,
  WorkflowPromotionTarget,
} from '@pertexo/contracts';
import { accessibleWorkspacesQueryOptions } from '@/features/workspaces/queries.public';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { QueryView } from '@/components/patterns/states/query-view';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import {
  setPromotionTarget,
  type PromotionScope,
} from '../data/promotions.api';
import { promotionKeys } from '../data/promotions.queries';
import { PromotionCommandFeedback } from './command-feedback';
export function PromotionTarget({
  scope,
  snapshot,
  disabled,
  onChange,
}: {
  scope: PromotionScope;
  snapshot: WorkflowPromotionSettings;
  disabled: boolean;
  onChange: () => void;
}) {
  const cache = useQueryClient();
  const currentTargetId = snapshot.target?.workspaceId ?? null;
  const [target, setTarget] = useState(currentTargetId ?? 'none');
  const [base, setBase] = useState({
    revision: snapshot.revision,
    targetWorkspaceId: currentTargetId,
  });
  const command = useRetainedCommand(
    (body: WorkflowPromotionTarget, key: string) =>
      setPromotionTarget(scope, body, key),
    async (result) => {
      setBase({
        revision: result.revision,
        targetWorkspaceId: result.targetWorkspaceId,
      });
      onChange();
      await cache.invalidateQueries({ queryKey: promotionKeys.scope(scope) });
    },
    { action: 'saving the promotion target' },
  );
  const locked = disabled || command.pending || command.uncertain;
  const changed =
    snapshot.revision !== base.revision ||
    currentTargetId !== base.targetWorkspaceId;
  function loadCurrent() {
    setBase({
      revision: snapshot.revision,
      targetWorkspaceId: currentTargetId,
    });
    setTarget(currentTargetId ?? 'none');
    onChange();
  }
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (locked || changed) return;
        void command.send({
          expectedRevision: base.revision,
          expectedTargetWorkspaceId: base.targetWorkspaceId,
          targetWorkspaceId: target === 'none' ? null : target,
        });
      }}
    >
      {changed ? (
        <Notice tone="warning">
          The target setting changed. Your selection is kept.{' '}
          <Button
            type="button"
            variant="ghost"
            disabled={locked}
            onClick={loadCurrent}
          >
            Load current target
          </Button>
        </Notice>
      ) : null}
      <TargetPicker
        scope={scope}
        target={target}
        disabled={locked || !snapshot.canConfigure}
        onChange={setTarget}
      />
      {snapshot.canConfigure ? (
        <Button
          className="self-start"
          type="submit"
          variant="outline"
          disabled={locked || changed || target === (currentTargetId ?? 'none')}
        >
          {command.pending ? 'Saving…' : 'Save target'}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          The source workspace owner chooses the target. You need edit access to
          both workspaces to promote.
        </p>
      )}
      <PromotionCommandFeedback
        command={command}
        retryLabel="Retry same change"
      />
    </form>
  );
}
function TargetPicker({
  scope,
  target,
  disabled,
  onChange,
}: {
  scope: PromotionScope;
  target: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const choices = useQuery(
    accessibleWorkspacesQueryOptions(scope.apiClient, scope.userId),
  );
  const available = (choices.data ?? []).filter(
    (workspace) =>
      workspace.id !== scope.workspaceId &&
      workspace.status === 'active' &&
      workspace.capabilities.includes('workflow:update'),
  );
  const label =
    target === 'none'
      ? 'No target'
      : (available.find((workspace) => workspace.id === target)?.name ??
        'Unavailable workspace');
  return (
    <>
      <label className="grid max-w-md gap-2 text-sm">
        Promotion target
        <Select
          value={target}
          disabled={disabled}
          onValueChange={(value) => {
            if (value !== null) onChange(value);
          }}
        >
          <SelectTrigger>
            <SelectValue>{label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No target</SelectItem>
            {available.map((workspace) => (
              <SelectItem key={workspace.id} value={workspace.id}>
                {workspace.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <QueryView query={choices} resource="Target workspaces" loading={null} />
    </>
  );
}
