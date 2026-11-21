import { generateSchemaDocument } from '@pertexo/node-sdk';
import { compareOrdinal, isRecord } from '@pertexo/workflow-model';
import {
  DATABASE_MODULE,
  EMAIL_MODULE,
  HTTP_MODULE,
  SLACK_MODULE,
  SIGNING_MODULE,
  type ConnectionDefinition,
  type IntegrationExecutorDependencies,
