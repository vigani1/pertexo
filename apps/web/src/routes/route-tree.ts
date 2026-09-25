import {
  accountSecurityRoute,
  indexRoute,
  invitationAcceptanceRoute,
  legacyMigrationRoute,
  loginRoute,
  logoutRoute,
  passwordRecoveryRoute,
  passwordResetRoute,
  signUpRoute,
  workspacesRoute,
} from './public-routes';
import { rootRoute } from './root-route';
import {
  workflowBuildRoute,
  workflowHubRoute,
  workflowRunsRoute,
  workflowSettingsRoute,
  workflowTriggersRoute,
  workflowVersionsRoute,
} from './workflow-hub-routes';
import {
  alertsRoute,
  connectionsRoute,
  homeRoute,
  runDetailRoute,
  runsRoute,
  shellCatchAllRoute,
  teamRoute,
  workflowsRoute,
  workspaceAccountRoute,
  workspaceScopeRoute,
  workspaceSettingsRoute,
  workspaceShellRoute,
} from './workspace-routes';

export const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  signUpRoute,
  legacyMigrationRoute,
  passwordRecoveryRoute,
  passwordResetRoute,
  logoutRoute,
  accountSecurityRoute,
  invitationAcceptanceRoute,
  workspacesRoute,
  workspaceScopeRoute.addChildren([
    workspaceShellRoute.addChildren([
      homeRoute,
      workflowsRoute,
      runsRoute,
      runDetailRoute,
      connectionsRoute,
      teamRoute,
      alertsRoute,
      workspaceSettingsRoute,
      workspaceAccountRoute,
      shellCatchAllRoute,
    ]),
    workflowHubRoute.addChildren([
      workflowBuildRoute,
      workflowRunsRoute,
      workflowTriggersRoute,
      workflowVersionsRoute,
      workflowSettingsRoute,
    ]),
  ]),
]);
