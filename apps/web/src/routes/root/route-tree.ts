import {
  accountSecurityRoute,
  authStageRoute,
  indexRoute,
  invitationAcceptanceRoute,
  loginRoute,
  logoutRoute,
  passwordRecoveryRoute,
  passwordResetRoute,
  signUpRoute,
  workspacesRoute,
} from './public-routes';
import { rootRoute } from './route';
import {
  workflowBuildRoute,
  workflowHubRoute,
  workflowRunsRoute,
  workflowSettingsRoute,
  workflowTriggersRoute,
  workflowVersionsRoute,
} from '../workflow/hub/routes';
import {
  alertsRoute,
  connectionsRoute,
  homeRoute,
  inboxRoute,
  runDetailRoute,
  runsRoute,
  shellCatchAllRoute,
  teamRoute,
  usageRoute,
  workflowsRoute,
  workspaceAccountRoute,
  workspaceScopeRoute,
  workspaceSettingsRoute,
  workspaceShellRoute,
} from '../workspace/routes';

export const routeTree = rootRoute.addChildren([
  indexRoute,
  authStageRoute.addChildren([
    loginRoute,
    signUpRoute,
    passwordRecoveryRoute,
    passwordResetRoute,
  ]),
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
      inboxRoute,
      connectionsRoute,
      teamRoute,
      usageRoute,
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
