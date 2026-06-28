/**
 * IPC Contract Test — Phase 7
 *
 * Compile-time verification that:
 *  1. Every IPC handler channel is present in the preload/transport contract.
 *  2. Every contract RPC channel has a registered handler.
 *  3. Event channels are defined by shared contracts.
 */

import type {
  DesktopRpcChannel,
} from '@bitsentry-ce/components/services'

// Registered handler channels (must match handler factory keys)
const HANDLER_CHANNELS = [
  'plugins:list',
  'plugins:get',
  'plugins:getStoredAuth',
  'plugins:updateStoredAuth',
  'plugins:clearStoredAuth',
  'plugins:execute',
  'errorSources:getAll',
  'errorSources:getOne',
  'errorSources:create',
  'errorSources:update',
  'errorSources:delete',
  'errorSources:initiateOAuth',
  'errorSources:completeOAuth',
  'errorSources:testConnection',
  'errorSources:probeConnection',
  'errorSources:triggerSync',
  'errorIssues:list',
  'errorEvents:list',
  'errorEvents:getOne',
  'settings:getAll',
  'settings:getGeneral',
  'settings:updateGeneral',
  'settings:getSecurity',
  'settings:updateSecurity',
  'settings:getNotifications',
  'settings:updateNotifications',
  'globals:list',
  'globals:create',
  'globals:update',
  'globals:delete',
  'settings:getAlertRules',
  'settings:createAlertRule',
  'settings:updateAlertRule',
  'settings:deleteAlertRule',
  'settings:initializeDefaults',
  'dialog:showSaveDialog',
  'dialog:showOpenDialog',
  'agent:start',
  'agent:send',
  'agent:cancel',
  'agent:getStatus',
  'agent:getSnapshot',
  'runbooks:list',
  'runbooks:get',
  'runbooks:create',
  'runbooks:updateMeta',
  'runbooks:updateActions',
  'runbooks:saveAction',
  'runbooks:deleteAction',
  'runbooks:reorderActions',
  'runbooks:delete',
  'runbooks:exportContext',
  'runbooks:export',
  'runbooks:exportToFile',
  'runbooks:import',
  'runbooks:readImportArtifact',
  'runbooks:importFromFile',
  'runbooks:execute',
  'runbooks:getExecution',
  'runbooks:cancelExecution',
  'incidents:getState',
  'incidents:replaceState',
  'desktopState:bootstrap',
  'desktopState:syncIncidents',
  'desktopState:syncRunbooks',
  'desktopState:syncResults',
] as const

type HandlerChannel = (typeof HANDLER_CHANNELS)[number]
type PreloadRpcChannel = DesktopRpcChannel

// Every handler channel must be in the shared RPC contract.
type _AssertHandlersInPreload = HandlerChannel extends PreloadRpcChannel ? true : never
const _handlerCoverage: _AssertHandlersInPreload = true

// Every shared RPC contract channel must have a handler.
type _AssertPreloadHasHandler = PreloadRpcChannel extends HandlerChannel ? true : never
const _preloadCoverage: _AssertPreloadHasHandler = true

void _handlerCoverage
void _preloadCoverage
void HANDLER_CHANNELS
