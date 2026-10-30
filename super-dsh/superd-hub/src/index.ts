/**
 * @pgmi-builds/superd-hub — host half public surface (Super D line).
 *
 * The line owns the switch and the gateway (per super-dsh/AGENTS.md):
 * the world inventory control plane + the foreign agent roster + the world
 * spawner, and (AW-B) the per-world mount carrier.
 *
 * DL7 (2026-09-16): the app-level selector value is GONE. World ownership is
 * per-request: the addressed world is the mount path of the request
 * (`/<label>/...`). `/api/*` stays ctx0/native and untouched.
 *
 * Path separation T-D (2026-09-26): the world-page faces left the surface —
 * the client mount shim, the mount HTML pass (`rewriteIndexHtml`) and the
 * retired `mountWorld` no-op are gone (git history keeps them), and worlds
 * compose as pure data planes (no webui rows).
 */
export { handleMeshMachines, registerMeshRpc, MESH_API_BASE, type MeshDeps, type MachinePublicRow } from './mesh-rpc.js'
export { handleAgentRuntime, registerSelectorRpc, AGENT_RUNTIME_RPC_PATH, registryTargets, type RuntimeTargetSource } from './rpc.js'
export { registerForeignTarget, unregisterForeignTarget, getTarget, listRuntimeKeys, type ForeignTarget, type GatewayFace } from './targets.js'
export { registerAgent, unregisterAgent, setReady, setFailed, listAgents, onRosterChanged, type RosterEntry } from './roster.js'
export { spawnWorld, type SpawnWorldOptions } from './spawn-world.js'
export { provisionWorldProfile, resolveInstallAnchor, type ProvisionWorldOptions } from './world-provision.js'
export { WorldWebServer, stripLabelFromUrl, type WorldWebRoute, type WorldWebUpgradeRoute, type RealWebServerFace } from './world-web-server.js'
export { parseClientRequest, serverResponse, serverError, serverResult, wireErrorOf, EnvelopeError, type ClientRequestEnvelope, type WireError } from './envelope.js'
export { WorldMuxServer, parseClientMessage, defaultFailure, type MuxOpen, type MuxFailure, type WorldMuxOptions } from './world-mux.js'
export { createRemoteGateway, defaultWsFactory, type RemoteGateway, type RemoteGatewayOptions, type MuxClientSocket } from './mesh-gateway.js'
export {
  federateAgents,
  defederateMachine,
  defederateStaleMachine,
  degradeMachine,
  federatedGatewayOf,
  startMeshFederation,
  type FederatedAgent,
  type FederatedMachine,
  type FederationWireDeps,
} from './mesh-federate.js'
export {
  cookieOf,
  onMeshFederationEvent,
  emitMachineRemoved,
  versionWarningFor,
  runReprobeSweep,
  startReprobeSweep,
  REPROBE_SWEEP_DEFAULT_SEC,
  REPROBE_SWEEP_MIN_SEC,
  type MeshFederationEvent,
  type ProbeAgent,
  type ProbeResult,
  type PairOutcome,
  type MachineStatusEntry,
  type ReprobeSweepDeps,
} from './mesh-link.js'
export { forwardApiCall, forwardWorldFetch, worldMuxOf, writeJson, type CarrierGatewayFace, type ForwardOptions } from './carrier.js'
export { registerHubRoute, HUB_MOUNT_PATH, HUB_MUX_PATH, type HubRouteOptions } from './hub-route.js'
export { renderFusionTransport, FUSION_FLAG_GLOBAL, type FusionConfig } from './fusion-transport.js'
export { createSwitchController, parseLandingTarget, namespacedKey, storageNamespace, seatClickDecision, NATIVE_AGENT, SESSIONS_CURRENT_KEY, SWITCH_FALLBACK_MS, type SwitchHost, type SwitchController, type SwitchOptions, type SeatClickInput, type SeatClickDecision } from './switch-core.js'
export { ensureAgentId, agentIdMap, type AgentIdMap } from './agent-ids.js'
export { agentLinks, agentRosterRow, AGENT_ROSTER_GLOBAL, type AgentLink } from './agent-roster.js'
export { createOwnershipIndex, type OwnershipIndex, type OwnershipRow } from './ownership.js'
export { registerHostMount, takeHostMount, listHostMounts, noteWorldServer, worldServerOf, type HostMount } from './world-host.js'
export {
  worldMountPatches,
  superdTrustedHosts,
  WORLD_WAVE1_DISABLED_ROWS,
  WORLD_WAVE2_DISABLED_ROWS,
  WORLD_MOUNT_PLUGIN,
  WORLD_MOUNT_ROW_ID,
  WORLD_HUB_PLUGIN,
  WORLD_HUB_ROW_ID,
  type WorldPatchLayer,
} from './world-mount.js'
export { withSystemHead, type HeadAwareSessionFace, type HeadPlaceholder, type WithSystemHead } from './system-head.js'
export {
  createAgentModelFace,
  recordedModelSelection,
  type AgentModelFaceParts,
  type BridgeModelFace,
  type ModelSelectionLike,
  type ModelSessionFace,
} from './agent-model-face.js'
export { default as worldApply, name as worldPluginName, type Config as WorldEntryConfig } from './world-entry.js'
export { default as joinApply, name as worldJoinPluginName, type Config as WorldJoinConfig } from './world-join.js'
export {
  createA2aService,
  A2A_MESSAGE_TEMPLATE,
  A2A_UNTITLED,
  A2A_BUFFER_MAX,
  A2A_NO_SESSION_CLOSE_REASON,
  A2A_NO_TURN_ACTIVE_NOTE,
  renderA2aEnvelope,
  loadConversations,
  saveConversations,
  shortIdFor,
  isDegenerateShortId,
  migrateConversations,
  type A2aService,
  // (A2aAddressError re-exported via the a2a-wire block below — postoffice R1)
  subscribeSessionCompletion,
  sessionRpc,
  turnLivenessOf,
  addressErrorBody,
  type A2aSessionSource,
  type A2aGateway,
  type A2aAddress,
  type A2aInitiator,
  type A2aDelivery,
  type A2aSendRequest,
  type A2aReceipt,
  type A2aReceiptOutcome,
  type A2aReceiptError,
  type A2aConversationRef,
  type A2aCompletion,
  type A2aCompletionCb,
  type A2aErrorCb,
  type A2aSubscribeOptions,
  type A2aStopScope,
  type A2aStopResult,
  type A2aBufferedMessage,
  type A2aBufferInput,
  type ConversationRow,
  type ConversationsFile,
} from './a2a-service.js'
export {
  A2A_WIRE_VERSION,
  A2A_TITLE_PLACEHOLDER,
  A2A_ENDPOINT_PATH,
  A2A_OUTBOX_PATH,
  A2A_WIRE_TIMEOUT_MS,
  A2aAddressError,
  a2aWireFrameOf,
  isA2aEnvelope,
  isA2aWireFrame,
  decodeA2aWireFrame,
  normalizeA2aTitle,
  a2aAddressOf,
  postA2aEnvelope,
  fetchA2aOutbox,
  type A2aWireTarget,
  type A2aWireOrigin,
  type A2aWireDelivery,
  type A2aNewConversationEnvelope,
  type A2aMessageEnvelope,
  type A2aStopEnvelope,
  type A2aReplyEnvelope,
  type A2aNoticeEnvelope,
  type A2aEnvelope,
  type A2aWireFrame,
  type A2aSendReceipt,
  type A2aStopReceipt,
  type A2aWireReceipt,
  type A2aWireOptions,
} from './a2a-wire.js'
export {
  createA2aIngest,
  type A2aIngest,
  type A2aIngestDeps,
  type A2aReturnRoute,
} from './a2a-ingest.js'
export {
  loadAgentStatus,
  recordMachineCollection,
  recordMachineFailure,
  collectRemoteMachine,
  collectLocalMachine,
  pullOutboxFor,
  statusSweepLegs,
  federatedFaceOf,
  AGENT_STATUS_ROWS_MAX,
  type AgentStatusRow,
  type AgentStatusAgent,
  type AgentStatusMachine,
  type AgentStatusFile,
  type RemoteFaceOf,
  type StatusSweepLegs,
} from './agent-status.js'
export {
  registerA2aRpc,
  handleA2aIngestPost,
  handleA2aOutboxGet,
} from './mesh-rpc.js'
export {
  deliverReply,
  deliverNotice,
  wireCompletionToDelivery,
  renderA2aRelayText,
  boundNoticeSummary,
  A2A_NOTICE_SUMMARY_MAX,
  type A2aRelaySource,
  type A2aNoticeSource,
  type A2aNoticeReason,
  type A2aDeliveredMessage,
  type A2aAgentHandle,
  type A2aDeliveryCtx,
  type A2aReplyMeta,
  type A2aNoticeMeta,
  type A2aReplyDelivery,
  type A2aDeliveryOutcome,
  type A2aCompletionSource,
} from './a2a-delivery.js'
export {
  resolveA2aGatewayFor,
  localA2aInitiator,
  createA2aHost,
  bridgeTypertGateway,
  type A2aHostOptions,
  type RawTypertGatewayFace,
} from './a2a-host.js'
export {
  createSuperdHubTool,
  parseAgentAddress,
  RECENT_CONVERSATIONS_MAX,
  AGENT_STATUS_WINDOW_MAX,
  HUB_A2A_TITLE_MARKER,
  UNHOSTED_TITLE,
  shapeAgentStatusWindow,
  type AgentStatusEntryRow,
  EXEC_PLACEHOLDER_NOTE,
  type HubToolDeps,
  type HubToolService,
  type HubRosterView,
  type HubMachineEntry,
  type HubAgentEntry,
} from './hub-tool.js'
export {
  wireHubToolRow,
  name as a2aRowName,
  default as a2aRow,
  type HubToolRowOptions,
} from './a2a-row.js'
export { default, type HubConfig } from './gateway.js'
