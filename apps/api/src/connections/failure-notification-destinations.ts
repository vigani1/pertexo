import { Injectable } from '@nestjs/common';
import {
  failureNotificationDestinationAppendVersionRequestSchema,
  failureNotificationDestinationCreateRequestSchema,
  failureNotificationDestinationListResponseSchema,
  failureNotificationDestinationStatusRequestSchema,
  type FailureNotificationDestinationResponse,
  type WorkflowFailureNotificationPolicyResponse,
  workflowFailureNotificationPolicyRequestSchema,
} from '@pertexo/contracts/connections';
import {
  generatePersistedId,
  type FailureNotificationDestinationDatabase,
} from '@pertexo/database/api';
import { z } from 'zod';

import {
  CONNECTION_OPERATION,
  NOOP_CONNECTION_TELEMETRY,
  type ConnectionTelemetry,
} from './telemetry.js';
import {
  hashRequest,
  type ConnectionCommandInput,
} from './use-case-support.js';

function databaseCommand(input: DestinationCommandInput) {
  return {
    workspaceId: input.routeWorkspaceId,
    actorId: input.actor.actorId,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
  };
}

function idempotentCommand(input: DestinationMutationInput, value: unknown) {
  return {
    ...databaseCommand(input),
    idempotencyKey: input.idempotencyKey,
    requestHash: hashRequest(value),
  };
}

function response(
  record: Awaited<ReturnType<FailureNotificationDestinationDatabase['get']>>,
): FailureNotificationDestinationResponse {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    kind: record.kind,
    status: record.status,
    currentVersion: record.currentVersion,
    config: record.config,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

type DestinationCommandInput = Pick<
  ConnectionCommandInput,
  'actor' | 'routeWorkspaceId' | 'requestId' | 'traceId'
>;
type DestinationMutationInput = DestinationCommandInput &
  Readonly<{ idempotencyKey: string }>;
export type CreateFailureNotificationDestinationInput =
  DestinationMutationInput &
    Readonly<{
      body: z.output<typeof failureNotificationDestinationCreateRequestSchema>;
    }>;
export type ListFailureNotificationDestinationsInput = DestinationCommandInput;
export type GetFailureNotificationDestinationInput = DestinationCommandInput &
  Readonly<{ destinationId: string }>;
export type AppendFailureNotificationDestinationVersionInput =
  GetFailureNotificationDestinationInput &
    DestinationMutationInput &
    Readonly<{
      body: z.output<
        typeof failureNotificationDestinationAppendVersionRequestSchema
      >;
    }>;
export type SetFailureNotificationDestinationStatusInput =
  GetFailureNotificationDestinationInput &
    DestinationMutationInput &
    Readonly<{
      body: z.output<typeof failureNotificationDestinationStatusRequestSchema>;
    }>;
export type SetWorkflowFailureNotificationPolicyInput =
  DestinationMutationInput &
    Readonly<{
      workflowId: string;
      body: z.output<typeof workflowFailureNotificationPolicyRequestSchema>;
    }>;
export type ClearWorkflowFailureNotificationPolicyInput =
  DestinationMutationInput & Readonly<{ workflowId: string }>;
export type GetWorkflowFailureNotificationPolicyInput =
  DestinationCommandInput & Readonly<{ workflowId: string }>;

@Injectable()
export class FailureNotificationDestinationUseCases {
  public constructor(
    private readonly database: FailureNotificationDestinationDatabase,
    private readonly telemetry: ConnectionTelemetry = NOOP_CONNECTION_TELEMETRY,
  ) {}

  public create(
    input: CreateFailureNotificationDestinationInput,
  ): Promise<FailureNotificationDestinationResponse> {
    return this.telemetry.measure(
      CONNECTION_OPERATION.destinationCreate,
      async () =>
        response(
          await this.database.create({
            ...idempotentCommand(input, input.body),
            destinationId: generatePersistedId(),
            config: input.body,
          }),
        ),
    );
  }
  public async list(
    input: ListFailureNotificationDestinationsInput,
  ): Promise<
    z.output<typeof failureNotificationDestinationListResponseSchema>
  > {
    const records = await this.database.list(databaseCommand(input));
    return { items: records.map(response) };
  }
  public async get(
    input: GetFailureNotificationDestinationInput,
  ): Promise<FailureNotificationDestinationResponse> {
    return response(
      await this.database.get({
        ...databaseCommand(input),
        destinationId: input.destinationId,
      }),
    );
  }
  public append(
    input: AppendFailureNotificationDestinationVersionInput,
  ): Promise<FailureNotificationDestinationResponse> {
    return this.telemetry.measure(
      CONNECTION_OPERATION.destinationAppend,
      async () =>
        response(
          await this.database.appendVersion({
            ...idempotentCommand(input, {
              destinationId: input.destinationId,
              ...input.body,
            }),
            destinationId: input.destinationId,
            expectedVersion: input.body.expectedVersion,
            config: input.body.config,
          }),
        ),
    );
  }
  public status(
    input: SetFailureNotificationDestinationStatusInput,
  ): Promise<FailureNotificationDestinationResponse> {
    return this.telemetry.measure(
      CONNECTION_OPERATION.destinationStatus,
      async () =>
        response(
          await this.database.setStatus({
            ...idempotentCommand(input, {
              destinationId: input.destinationId,
              ...input.body,
            }),
            destinationId: input.destinationId,
            status: input.body.status,
          }),
        ),
    );
  }
  /** The current choice in the destination read projection, never secrets. */
  public async getPolicy(
    input: GetWorkflowFailureNotificationPolicyInput,
  ): Promise<WorkflowFailureNotificationPolicyResponse> {
    const destination = await this.database.getWorkflowPolicy({
      ...databaseCommand(input),
      workflowId: input.workflowId,
    });
    return { destination: destination === null ? null : response(destination) };
  }
  public setPolicy(
    input: SetWorkflowFailureNotificationPolicyInput,
  ): Promise<void> {
    return this.telemetry.measure(CONNECTION_OPERATION.policySet, () =>
      this.database.setWorkflowPolicy({
        ...idempotentCommand(input, {
          workflowId: input.workflowId,
          ...input.body,
        }),
        workflowId: input.workflowId,
        destinationId: input.body.destinationId,
      }),
    );
  }
  public clearPolicy(
    input: ClearWorkflowFailureNotificationPolicyInput,
  ): Promise<void> {
    return this.telemetry.measure(CONNECTION_OPERATION.policyClear, () =>
      this.database.clearWorkflowPolicy({
        ...idempotentCommand(input, {
          workflowId: input.workflowId,
        }),
        workflowId: input.workflowId,
      }),
    );
  }
}
