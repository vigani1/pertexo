import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import { PlusIcon } from 'lucide-react';
import { use, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { describeConnectionRequirement } from '@/features/catalog/presentation.public';
import {
  AddConnectionSheet,
  providerForCredential,
} from '@/features/connections/add-connection.public';
import { AddConnectionContext } from '../../model/add-connection-context';
import type { NodeFormApi } from '../../model/node-form';
import { ChoiceSelect } from './choice-select';

/**
 * Which workspace connection a step uses for one requirement. Only active
 * connections of the right kind are offered. People who manage connections
 * can add one in place: "New Slack connection" opens the add-connection
 * lens over the editor and comes back with the new connection selected, so
 * the draft and its guards never leave the screen.
 */
export function ConnectionSlot({
  requirement,
  selectedId,
  connections,
  form,
}: Readonly<{
  requirement: string;
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
        id={id}
        value={selectedId ?? null}
        disabled={!form.editable}
        choices={[
          { value: null, label: 'Choose a connection' },
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
      />
      {matching.length === 0 ? (
        <FieldDescription>
          There’s no active {label.toLowerCase()} in this workspace yet.
          {addScope === null ? ' Admins and owners can add one.' : ''}
        </FieldDescription>
      ) : null}
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
              if (connection.authType === requirement) choose(connection.id);
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
  const usable = connections.filter(
    (connection) =>
      connection.authType === requirement && connection.status === 'active',
  );
  const fresh =
    created?.authType === requirement &&
    created.status === 'active' &&
    !usable.some((connection) => connection.id === created.id);
  return fresh ? [...usable, created] : usable;
}
