// Pure request handling for the zero-knowledge address book.
//
// The Worker only stores opaque ciphertext under a 43-char capability path.
// It never holds content keys and never logs paths or bodies. Requests are
// kept in this module (no `cloudflare:workers` import) so Node tests can drive
// the same code with an in-memory Durable Object storage stub.

const PATH_RE = /^[A-Za-z0-9_-]{43}$/
const BODY_RE = /^[A-Za-z0-9_-]{16,8192}$/
const MAX_BODY = 8192
const MAX_RECORDS = 64
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

const reply = (status, body = null, extra = {}) =>
  new Response(body, { status, headers: { ...HEADERS, ...extra } })

const notFound = () => reply(404)

async function digest(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

/**
 * Hash both sides first, then compare. Workers exposes the constant-time
 * `crypto.subtle.timingSafeEqual`; Node (used by the unit tests) does not, so
 * fall back to XOR-accumulating the digests without early exit.
 */
async function sameSecret(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected === '') return false
  const [a, b] = await Promise.all([digest(given), digest(expected)])
  if (typeof globalThis.crypto?.subtle?.timingSafeEqual === 'function') {
    return globalThis.crypto.subtle.timingSafeEqual(a, b)
  }
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i]
  return diff === 0
}

async function authorized(request, expected) {
  const header = request.headers.get('authorization') || ''
  const match = /^Bearer (.+)$/.exec(header)
  return sameSecret(match ? match[1] : '', expected)
}

/** Stream the body and stop at the cap — Content-Length is only a fast reject. */
async function readCapped(request, cap) {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > cap) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    all.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(all)
}

/**
 * Durable Object side. `ctx` only needs `storage.get/put/delete/list`, which
 * lets tests provide an in-memory Map-backed object.
 */
export async function handleBook(ctx, request) {
  const url = new URL(request.url)
  const path = url.searchParams.get('path') || ''
  if (!PATH_RE.test(path)) return notFound()

  if (request.method === 'GET' || request.method === 'HEAD') {
    const value = await ctx.storage.get(path)
    if (typeof value !== 'string') return notFound()
    return reply(200, request.method === 'HEAD' ? null : value,
      { 'content-type': 'text/plain; charset=utf-8' })
  }

  if (request.method === 'PUT') {
    const body = await request.text()
    if (typeof body !== 'string' || !BODY_RE.test(body)) return reply(400)
    const existing = await ctx.storage.get(path)
    if (existing === undefined || existing === null) {
      const rows = await ctx.storage.list({ limit: MAX_RECORDS + 1 })
      if (rows.size >= MAX_RECORDS) return reply(507)
    }
    await ctx.storage.put(path, body)
    return reply(204)
  }

  if (request.method === 'DELETE') {
    await ctx.storage.delete(path)
    return reply(204)
  }

  return reply(405, null, { allow: 'GET, HEAD, PUT, DELETE' })
}

/** Top-level Worker fetch: auth + body validation, then delegate to the DO. */
export async function handleRequest(request, env) {
  const url = new URL(request.url)
  if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
    return reply(200, 'dsh-mobile-rendezvous: encrypted address book\n',
      { 'content-type': 'text/plain; charset=utf-8' })
  }

  const match = /^\/r\/([^/]+)$/.exec(url.pathname)
  const path = match ? match[1] : ''
  // Bad paths are indistinguishable from missing ones.
  if (!PATH_RE.test(path)) return notFound()

  const method = request.method
  if (method === 'PUT' || method === 'DELETE') {
    if (!(await authorized(request, env.WRITE_SECRET))) return reply(401)
  } else if (method !== 'GET' && method !== 'HEAD') {
    return reply(405, null, { allow: 'GET, HEAD, PUT, DELETE' })
  }

  let body
  if (method === 'PUT') {
    const text = await readCapped(request, MAX_BODY)
    if (text === null) return reply(413)
    if (!BODY_RE.test(text)) return reply(400)
    body = text
  }

  const id = env.BOOK.idFromName('book')
  const stub = env.BOOK.get(id)
  const target = `https://book.internal/?path=${encodeURIComponent(path)}`
  return stub.fetch(target, body === undefined ? { method } : { method, body })
}

export { PATH_RE, BODY_RE, MAX_BODY, MAX_RECORDS }
