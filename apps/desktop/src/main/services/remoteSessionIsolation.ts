import type { RemoteConnectionConfig, RemoteRouteBinding } from '@spark/protocol'

export function remoteConnectionsForSession(
  connections: readonly RemoteConnectionConfig[],
  sessionId: string | undefined,
  exceptConnectionId?: string,
): RemoteConnectionConfig[] {
  if (sessionId == null) return []
  return connections.filter(
    (connection) =>
      connection.id !== exceptConnectionId && connection.defaultSessionId === sessionId,
  )
}

export function canShareRemoteSession(
  connection: Pick<RemoteConnectionConfig, 'allowSharedSession'>,
  others: readonly Pick<RemoteConnectionConfig, 'allowSharedSession'>[],
): boolean {
  return (
    connection.allowSharedSession === true &&
    others.every((item) => item.allowSharedSession === true)
  )
}

export function canUseConfiguredRemoteSession(
  connections: readonly RemoteConnectionConfig[],
  connection: RemoteConnectionConfig,
): boolean {
  if (connection.defaultSessionId == null) return false
  const others = remoteConnectionsForSession(
    connections,
    connection.defaultSessionId,
    connection.id,
  )
  return others.length === 0 || canShareRemoteSession(connection, others)
}

export function remoteRouteKey(connectionId: string, externalId: string): string {
  return `${connectionId}\u0000${externalId}`
}

export function withRemoteRouteDefaults(
  connection: RemoteConnectionConfig,
  route: RemoteRouteBinding,
): RemoteConnectionConfig {
  const result = { ...connection }
  delete result.defaultSessionId
  delete result.defaultWorkspaceId
  delete result.defaultProviderProfileId
  delete result.defaultModelId
  delete result.defaultAgentId
  delete result.defaultPermissionMode
  delete result.defaultReasoningEffort
  const { externalId: _externalId, ...defaults } = route
  return { ...result, ...defaults }
}

export function remoteRouteSessionOwners(
  connections: readonly RemoteConnectionConfig[],
  sessionId: string | undefined,
  except?: { connectionId: string; externalId: string },
): Array<{ connection: RemoteConnectionConfig; route: RemoteRouteBinding }> {
  if (sessionId == null) return []
  return connections.flatMap((connection) =>
    (connection.routeBindings ?? [])
      .filter(
        (route) =>
          route.defaultSessionId === sessionId &&
          !(connection.id === except?.connectionId && route.externalId === except.externalId),
      )
      .map((route) => ({ connection, route })),
  )
}

export function canBindRemoteRouteSession(
  connections: readonly RemoteConnectionConfig[],
  connection: RemoteConnectionConfig,
  externalId: string,
  sessionId: string | undefined,
): boolean {
  const owners = remoteRouteSessionOwners(connections, sessionId, {
    connectionId: connection.id,
    externalId,
  })
  const legacyOwners = connections.filter(
    (owner) =>
      owner.id !== connection.id &&
      owner.defaultSessionId === sessionId &&
      (owner.routeBindings?.length ?? 0) === 0,
  )
  return (
    owners.every(
      ({ connection: owner }) =>
        owner.id !== connection.id &&
        connection.allowSharedSession === true &&
        owner.allowSharedSession === true,
    ) &&
    legacyOwners.every(
      (owner) => connection.allowSharedSession === true && owner.allowSharedSession === true,
    )
  )
}

export function resolveScheduledRemoteRoute(
  connections: readonly RemoteConnectionConfig[],
  sessionId: string,
): { connectionId: string; externalId: string } | null {
  const routes = remoteRouteSessionOwners(connections, sessionId).filter(
    ({ connection }) => connection.enabled,
  )
  if (routes.length !== 1) return null
  const target = routes[0]
  if (target == null) return null
  return { connectionId: target.connection.id, externalId: target.route.externalId }
}
