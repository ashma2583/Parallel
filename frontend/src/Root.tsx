import { useEffect, useMemo } from 'react'
import { SpacetimeDBProvider } from 'spacetimedb/react'
import App from './App'
import { DbConnection } from './module_bindings'
import { STDB_DATABASE, STDB_URI } from './config'
import { setStdbConnection, watchActions } from './lib/actions'

const TOKEN_KEY = 'stdb_token'

// One identity per browser window: sessionStorage is not shared between tabs,
// so two windows are two directors. Storage can throw (private mode): carry on.
function readToken(): string | undefined {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function saveToken(token: string) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* identity is per page load then */
  }
}

// The SDK's reconnect backoff grows from 1 s to 30 s. After a connection that
// worked has dropped, nudge it with an `online` event so it retries within ~2 s.
// Never starts if SpacetimeDB was not reachable in the first place.
let everConnected = false
let connected = false

export default function Root() {
  // Memoised so the provider does not reconnect on every render.
  const connectionBuilder = useMemo(
    () =>
      DbConnection.builder()
        .withUri(STDB_URI)
        .withDatabaseName(STDB_DATABASE)
        .withToken(readToken())
        .onConnect((conn, identity, token) => {
          saveToken(token)
          everConnected = true
          connected = true
          setStdbConnection(conn, true)
          watchActions(conn)
          console.info('[stdb] connected as', identity.toHexString())
          // Presence rows are dropped on disconnect, so join on every (re)connect.
          conn.reducers
            .join({ name: `Director ${identity.toHexString().slice(0, 4)}`, role: '' })
            .catch((err: unknown) => console.warn('[stdb] join failed', err))
        })
        .onDisconnect(() => {
          connected = false
          setStdbConnection(null, false)
        })
        .onConnectError((_ctx, err) => {
          connected = false
          setStdbConnection(null, false)
          console.error('[stdb] connection error', err)
        }),
    [],
  )

  useEffect(() => {
    const timer = setInterval(() => {
      if (everConnected && !connected) window.dispatchEvent(new Event('online'))
    }, 2000)
    return () => clearInterval(timer)
  }, [])

  return (
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <App />
    </SpacetimeDBProvider>
  )
}
