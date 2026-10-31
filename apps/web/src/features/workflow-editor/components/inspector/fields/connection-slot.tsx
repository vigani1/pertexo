import type { ConnectionResponse } from '@pertexo/contracts';
import { PlusIcon } from 'lucide-react';
import { use, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { describeConnectionRequirement } from '@/features/catalog/presentation.public';
import {
  AddConnectionSheet,
  providerForCredential,
} from '@/features/connections/add.public';
import { isUsableConnection } from '@/features/connections/queries.public';
import { AddConnectionContext } from '../../../model/add-connection-context';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { ChoiceSelect } from './choice-select';
import { whoCan } from '@/features/workspaces/roles.public';
import { sentenceStart } from '@/lib/format/sentence';

/**
 * Which workspace connection a step uses for one requirement. Only active
 * connections of the right kind are offered. People who manage connections
 * can add one in place: "New Slack connection" opens the add-connection
 * lens over the editor and comes back with the new connection selected, so
 * the draft and its guards never leave the screen.
 */
export function ConnectionSlot({
  requirement,
  optional = false,
  selectedId,
  connections,
  form,
}: Readonly<{
  requirement: string;
  /** May be left empty, as for a public API that needs no auth. */
  optional?: boolean;
  selectedId: string | undefined;
  connections: readonly ConnectionResponse[];
  form: NodeFormApi;
}>) {
  const addScope = use(AddConnectionContext);
  const [adding, setAdding] = useState(false);
  // Shown until the workspace's list, refreshed after the save, includes it.
  const [created, setCreated] = useState<ConnectionResponse>();
  const id = `connection-${form.nodeId}-${requirement}`;
  const label = describeConnectionRequirement(requirement);
  const provider = providerForCredential(requirement);
  const matching = usableConnections(connections, requirement, created);
  const missingId =
    selectedId !== undefined &&
    !matching.some((connection) => connection.id === selectedId)
      ? selectedId
      : undefined;

  function choose(connectionId: string | null) {
    form.commit(
      (node) => ({
        connectionRefs:
          connectionId === null
            ? Object.fromEntries(
                Object.entries(node.connectionRefs).filter(
                  ([key]) => key !== requirement,
                ),
              )
            : { ...node.connectionRefs, [requirement]: connectionId },
      }),
      `${form.nodeId}:connection:${requirement}`,
    );
  }

  const canAdd = addScope !== null && provider !== undefined && form.editable;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <ChoiceSelect
        value={selectedId ?? null}
        disabled={!form.editable}
        choices={[
          {
            value: null,
            label: optional ? 'No connection' : 'Choose a connection',
          },
          ...matching.map((connection) => ({
            value: connection.id,
            label: connection.name,
          })),
          ...(missingId === undefined
            ? []
            : [
                {
                  value: missingId,
                  label: 'A connection that’s no longer active',
                },
              ]),
        ]}
        onChange={choose}
        control={{ id: id }}
      />
      <ConnectionGuidance
        optional={optional}
        selectedId={selectedId}
        matchingCount={matching.length}
        label={label}
        canManage={addScope !== null}
      />
      {missingId === undefined ? null : (
        <FieldDescription className="text-warning">
          The chosen connection was revoked or needs reauthorizing. Choose
          another one.
        </FieldDescription>
      )}
      {canAdd ? (
        <>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="w-fit"
            onClick={() => {
              setAdding(true);
            }}
          >
            <PlusIcon data-icon="inline-start" />
            New {label}
          </Button>
          <AddConnectionSheet
            scope={addScope.scope}
            workspaceName={addScope.workspaceName}
            request={adding ? provider : undefined}
            onCreated={(connection) => {
              setCreated(connection);
              if (isUsableConnection(connection, requirement))
                choose(connection.id);
            }}
            onClose={() => {
              setAdding(false);
            }}
          />
        </>
      ) : null}
    </Field>
  );
}

/** Active connections holding `requirement`, with one just created here. */
function usableConnections(
  connections: readonly ConnectionResponse[],
  requirement: string,
  created: ConnectionResponse | undefined,
): readonly ConnectionResponse[] {
  const usable = connections.filter((connection) =>
    isUsableConnection(connection, requirement),
  );
  const fresh =
    created !== undefined &&
    isUsableConnection(created, requirement) &&
    !connections.some((connection) => connection.id === created.id);
  return fresh ? [...usable, created] : usable;
}

function ConnectionGuidance({
  optional,
  selectedId,
  matchingCount,
  label,
  canManage,
}: Readonly<{
  optional: boolean;
  selectedId: string | undefined;
  matchingCount: number;
  label: string;
  canManage: boolean;
}>) {
  if (optional && selectedId === undefined)
    return (
      <FieldDescription>
        Leave it empty for an API that needs no key, or choose one to send its
        headers.
      </FieldDescription>
    );
  if (matchingCount === 0)
    return (
      <FieldDescription>
        There’s no active {label} in this workspace yet.
        {canManage
          ? ''
          : ` ${sentenceStart(whoCan('connection:manage'))} can add one.`}
      </FieldDescription>
    );
  return null;
}
