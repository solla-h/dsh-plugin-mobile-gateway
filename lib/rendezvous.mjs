// Encrypted address-book publisher for the mobile gateway.
//
// The gateway never stores content keys anywhere except the device registry:
// each device gets its own 32-byte key, and the Worker only ever sees an
// opaque ciphertext under a path derived from that key. Publishing is
// best-effort; a failed PUT is retried on the next tick.
import crypto from 'node:crypto'

export const RENDEZVOUS_KEY_RE = /^[A-Za-z0-9_-]{43}$/
export const MAX_BODY_CHARS = 8192
const MAX_ENDPOINTS = 16
const MAX_ENDPOINT_CHARS = 2048
const PATH_INFO = 'dsh-rendezvous-path-v1'
const AES_INFO = 'dsh-rendezvous-blob-v1'

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

export function deriveLocator(key) {
  if (typeof key !== 'string' || !RENDEZVOUS_KEY_RE.test(key)) {
    throw new Error('invalid rendezvous key')
  }
  const keyBytes = Buffer.from(key, 'base64url')
  if (keyBytes.length !== 32) throw new Error('invalid rendezvous key length')
  const pathKey = Buffer.from(crypto.hkdfSync('sha256', keyBytes, Buffer.alloc(0), Buffer.from(PATH_INFO), 32))
  const aesKey = Buffer.from(crypto.hkdfSync('sha256', keyBytes, Buffer.alloc(0), Buffer.from(AES_INFO), 32))
  return { path: base64url(pathKey), aesKey }
}

/** Same envelope as the App decoder: 0x01 || nonce || ciphertext || tag. */
export function sealEnvelope({ key, plaintext, nonce = crypto.randomBytes(12) }) {
  if (!(nonce instanceof Uint8Array) || nonce.length !== 12) throw new Error('nonce must be 12 bytes')
  const { path, aesKey } = deriveLocator(key)
  const bytes = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext)
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, nonce)
  cipher.setAAD(Buffer.from(path, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()])
  const tag = cipher.getAuthTag()
  return base64url(Buffer.concat([Buffer.from([0x01]), Buffer.from(nonce), ciphertext, tag]))
}

export function encryptAddressBook({ key, rev, gatewayId, endpoints, nonce }) {
  return sealEnvelope({
    key,
    nonce,
    plaintext: JSON.stringify({ v: 1, rev, gatewayId, endpoints }),
  })
}

function normalizeEndpoints(value) {
  if (!Array.isArray(value)) return []
  const list = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > MAX_ENDPOINT_CHARS) continue
    if (!list.includes(item)) list.push(item)
    if (list.length === MAX_ENDPOINTS) break
  }
  return list
}

/**
 * Serialized publisher: PUTs and DELETEs share one promise chain, so a
 * retire() queued during an in-flight PUT can never be overtaken by it.
 */
export function createRendezvousPublisher(options) {
  const {
    url,
    writeSecret,
    gatewayId,
    getEndpoints,
    getEntries,
    fetchImpl = fetch,
    now = Date.now,
    log = () => {},
    tickMs = 60_000,
    republishMs = 30 * 60_000,
    timeoutMs = 10_000,
  } = options || {}

  const base = String(url || '').replace(/\/+$/, '')
  const published = new Map() // deviceId -> { path, endpointsKey, rev, at }
  const retired = new Set() // path values retired in this process
  let timer = null
  let stopped = true
  let lastRev = 0
  let lastPublishAt = 0
  let lastError = null
  let dirty = true
  let chain = Promise.resolve()

  const redact = (message) => String(message || '').replace(/\/r\/[A-Za-z0-9_-]+/g, '/r/<redacted>')
  const recordError = (error) => {
    lastError = redact(error && error.message ? error.message : error)
    log(`[rendezvous] ${lastError}`)
  }

  const enqueue = (task) => {
    chain = chain.then(task, task)
    return chain
  }

  const buildBody = (key, endpoints, rev) => {
    let list = endpoints.slice()
    let dropped = 0
    for (;;) {
      const body = encryptAddressBook({ key, rev, gatewayId, endpoints: list })
      if (body.length <= MAX_BODY_CHARS) return { body, endpoints: list, dropped }
      if (list.length <= 1) throw new Error('rendezvous body exceeds 8192 characters')
      list = list.slice(0, -1)
      dropped += 1
    }
  }

  const request = async (method, path, body) => {
    const response = await fetchImpl(`${base}/r/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${writeSecret}`,
        ...(body === undefined ? {} : { 'content-type': 'text/plain' }),
      },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (method === 'DELETE') {
      if (response.status !== 204 && response.status !== 404) {
        throw new Error(`DELETE failed: HTTP ${response.status}`)
      }
      return
    }
    if (response.status !== 204) throw new Error(`PUT failed: HTTP ${response.status}`)
  }

  const publishPass = async () => {
    if (stopped || !base || !writeSecret) return
    // A poke forces one full pass; ordinary ticks only publish what changed.
    const force = dirty
    dirty = false
    const entries = typeof getEntries === 'function' ? getEntries() : []
    let endpoints = []
    try {
      endpoints = normalizeEndpoints(typeof getEndpoints === 'function' ? getEndpoints() : [])
    } catch (error) {
      recordError(error)
      return
    }
    if (endpoints.length === 0) {
      recordError(new Error('no endpoints to publish'))
      return
    }
    const endpointsKey = JSON.stringify(endpoints)
    for (const entry of entries) {
      if (stopped) return
      if (!entry || typeof entry.id !== 'string' || !RENDEZVOUS_KEY_RE.test(entry.key || '')) continue
      let path
      try {
        path = deriveLocator(entry.key).path
      } catch {
        continue
      }
      if (retired.has(path)) continue
      const previous = published.get(entry.id)
      const due =
        force ||
        !previous ||
        previous.path !== path ||
        previous.endpointsKey !== endpointsKey ||
        now() - previous.at >= republishMs
      if (!due) continue
      // Re-check at send time: a revoke may have landed while this pass waited
      // in the queue, and a retired path must never be resurrected.
      const stillListed = (typeof getEntries === 'function' ? getEntries() : []).some(
        (candidate) => candidate && candidate.id === entry.id && candidate.key === entry.key,
      )
      if (!stillListed || retired.has(path)) continue
      lastRev = Math.max(lastRev + 1, now())
      try {
        const built = buildBody(entry.key, endpoints, lastRev)
        if (built.dropped > 0) {
          recordError(new Error(`rendezvous body too large; dropped ${built.dropped} endpoint(s)`))
        }
        await request('PUT', path, built.body)
        // A successful PUT supersedes any earlier error; kept failures (and
        // oversized-body warnings) re-record it on the next pass.
        if (built.dropped === 0) lastError = null
        published.set(entry.id, {
          path,
          // Compare against the full endpoint snapshot, not the tail-dropped
          // one, or an oversized payload would be republished on every tick.
          endpointsKey,
          rev: lastRev,
          at: now(),
        })
        lastPublishAt = now()
      } catch (error) {
        recordError(error)
      }
    }
    // Forget devices that no longer have a key (revoked or removed).
    const live = new Set(entries.map((entry) => entry && entry.id))
    for (const id of published.keys()) {
      if (!live.has(id)) published.delete(id)
    }
  }

  const retirePass = async (path) => {
    if (!base || !writeSecret) return
    try {
      await request('DELETE', path)
    } catch (error) {
      recordError(error)
    }
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      dirty = true
      enqueue(publishPass)
      timer = setInterval(() => enqueue(publishPass), tickMs)
      if (typeof timer.unref === 'function') timer.unref()
    },

    stop() {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },

    /** Ask for an immediate republish (e.g. a device just got its first key). */
    poke() {
      dirty = true
      if (!stopped) enqueue(publishPass)
    },

    /** Retire a device's path: queued behind any in-flight PUT, never retried. */
    retire(key) {
      if (typeof key !== 'string' || !RENDEZVOUS_KEY_RE.test(key)) return
      let path
      try {
        path = deriveLocator(key).path
      } catch {
        return
      }
      retired.add(path)
      enqueue(() => retirePass(path))
    },

    status() {
      return {
        configured: true,
        url: base || null,
        devices: typeof getEntries === 'function' ? getEntries().length : 0,
        lastPublishAt: lastPublishAt || null,
        lastError,
      }
    },
  }
}

