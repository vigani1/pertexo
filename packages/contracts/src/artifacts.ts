import {
  identityWorkspaceClientContract,
  identityWorkspaceOpenApiDocument,
} from './identity-workspace.js';

export const CONTRACT_ARTIFACTS = Object.freeze([
  Object.freeze({
    fileName: 'identity-workspace.client-schema.json',
    content: `${JSON.stringify(identityWorkspaceClientContract, undefined, 2)}\n`,
  }),
  Object.freeze({
    fileName: 'identity-workspace.openapi.json',
    content: `${JSON.stringify(identityWorkspaceOpenApiDocument, undefined, 2)}\n`,
  }),
]);
