import pg from 'pg'

const FIRST_RETRY_MS = 1000
const MAX_RETRY_MS = 30_000

export type WakeLog = { warn(data: object, message: string): void }

export type Listener = {
  /** Settles after the first connection attempt, connected or not; later attempts go on in the background. */
  ready: Promise<void>
  close(): Promise<void>
}

/**
 * LISTENs on `channel` over one dedicated connection (not the pool: a pooled client would be handed back and lose the
 * LISTEN) and calls `onNotify` with each payload. A failed or lost connection is retried after 1 s, doubling up to
 * 30 s, and back to 1 s once connected. Notifications sent while it is down are lost, so `onConnect` runs after each
 * connect for the caller to catch up.
 */
export function listen(
  url: string,
  channel: string,
  onNotify: (payload: string) => void,
  log: WakeLog,
  onConnect: () => void = () => {},
): Listener {
  let closed = false
  let client: pg.Client | undefined
  let timer: NodeJS.Timeout | undefined
  let retryMs = FIRST_RETRY_MS
  // The connect in progress, if any; close waits for it so no client outlives close.
  let connecting: Promise<void> = Promise.resolve()

  const retry = (err: unknown) => {
    if (closed || timer) return
    log.warn({ err, retryMs }, 'scheduler LISTEN connection failed; the poll still runs')
    timer = setTimeout(() => {
      timer = undefined
      connecting = connect()
    }, retryMs)
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
  }

  const connect = async () => {
    const c = new pg.Client({ connectionString: url })
    client = c
    // A lost connection emits 'error' (and then 'end'); unhandled it would crash the process.
    // Only the current client reconnects; an old one ending late must not start a second connection.
    c.on('error', (err) => {
      if (client === c) retry(err)
    })
    c.on('end', () => {
      if (client === c) retry(new Error('connection ended'))
    })
    c.on('notification', (n) => {
      if (n.channel === channel && n.payload !== undefined) onNotify(n.payload)
    })
    try {
      await c.connect()
      await c.query(`listen ${c.escapeIdentifier(channel)}`)
    } catch (err) {
      client = undefined
      await c.end().catch(() => {})
      retry(err)
      return
    }
    if (closed) return
    retryMs = FIRST_RETRY_MS
    onConnect()
  }

  connecting = connect()
  return {
    ready: connecting,
    async close() {
      closed = true
      clearTimeout(timer)
      await connecting
      await client?.end().catch(() => {})
    },
  }
}
