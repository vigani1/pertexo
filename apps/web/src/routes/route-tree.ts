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
} from './authentication-routes';
import { rootRoute } from './root-route';
import {
  runDetailRoute,
  runHistoryRoute,
  workflowEditorRoute,
  workflowListRoute,
  workflowSettingsRoute,
} from './workflow-routes';
import {
  connectionsRoute,
  overviewRoute,
  workspaceGeneralRoute,
  workspaceMembersRoute,
  workspaceNotificationsRoute,
  workspacesRoute,
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
  workflowListRoute,
  overviewRoute,
  connectionsRoute,
  workflowEditorRoute,
  runHistoryRoute,
  runDetailRoute,
  workflowSettingsRoute,
  workspaceGeneralRoute,
  workspaceMembersRoute,
  workspaceNotificationsRoute,
]);
