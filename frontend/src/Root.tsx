import { useMemo } from 'react'
import { SpacetimeDBProvider } from 'spacetimedb/react'
import App from './App'
import { DbConnection } from './module_bindings'
import { STDB_DATABASE, STDB_URI } from './config'

export default function Root() {
  // Memoised so the provider does not reconnect on every render.
  const connectionBuilder = useMemo(
    () =>
      DbConnection.builder()
        .withUri(STDB_URI)
        .withDatabaseName(STDB_DATABASE)
        .onConnect((_conn, identity) => {
          console.info('[stdb] connected as', identity.toHexString())
        })
        .onConnectError((_ctx, err) => {
          console.error('[stdb] connection error', err)
        }),
    [],
  )

  return (
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <App />
    </SpacetimeDBProvider>
  )
}
