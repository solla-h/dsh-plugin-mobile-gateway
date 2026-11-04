import { test } from 'node:test'
import assert from 'node:assert/strict'

import { handleBook, handleRequest, MAX_BODY, MAX_RECORDS } from '../src/handler.js'

class MemoryStorage {
  constructor() {
    this.map = new Map()
  }

  async get(key) {
    return this.map.get(key)
  }

  async put(key, value) {
    this.map.set(key, value)
  }

  async delete(key) {
    this.map.delete(key)
  }

  async list({ limit } = {}) {
    return new Map([...this.map].slice(0, limit ?? Infinity))
  }
}

function makeEnv(secret = 'write-secret') {
  const storage = new MemoryStorage()
  const stub = {
    fetch: (url, init) => handleBook({ storage }, new Request(url, init)),
  }
  return {
    storage,
    env: {
      WRITE_SECRET: secret,
      BOOK: { idFromName: () => 'book', get: () => stub },
    },
  }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const PATH = 'A'.repeat(43)
const pathFor = (index) => 'A'.repeat(41) + ALPHABET[Math.floor(index / 64)] + ALPHABET[index % 64]

const put = (env, path, body, secret = 'write-secret') =>
  handleRequest(new Request(`https://book.example.workers.dev/r/${path}`, {
    method: 'PUT',
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
    body,
  }), env)

const get = (env, path, method = 'GET') =>
  handleRequest(new Request(`https://book.example.workers.dev/r/${path}`, { method }), env)

const del = (env, path, secret = 'write-secret') =>
  handleRequest(new Request(`https://book.example.workers.dev/r/${path}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${secret}` },
  }), env)

test('help route and header hygiene', async () => {
  const { env } = makeEnv()
  const help = await handleRequest(new Request('https://book.example.workers.dev/'), env)
  assert.equal(help.status, 200)
  assert.match(await help.text(), /dsh-mobile-rendezvous/)
  assert.equal(help.headers.get('cache-control'), 'no-store')
  assert.equal(help.headers.get('x-content-type-options'), 'nosniff')
})

test('bad paths are indistinguishable from missing records', async () => {
  const { env } = makeEnv()
  for (const path of ['', 'short', 'A'.repeat(44), 'A'.repeat(42) + '+', 'A'.repeat(42) + '.']) {
    const response = await get(env, path)
    assert.equal(response.status, 404)
  }
  assert.equal((await get(env, PATH)).status, 404)
  assert.equal((await get(env, PATH, 'HEAD')).status, 404)
})

test('PUT requires the exact bearer secret', async () => {
  const { env } = makeEnv()
  assert.equal((await put(env, PATH, 'A'.repeat(16), null)).status, 401)
  assert.equal((await put(env, PATH, 'A'.repeat(16), 'wrong')).status, 401)
  assert.equal((await put(env, PATH, 'A'.repeat(16), '')).status, 401)
  assert.equal((await put(env, PATH, 'A'.repeat(16))).status, 204)
  assert.equal((await get(env, PATH)).status, 200)
})

test('GET returns the stored body with safety headers; HEAD has no body', async () => {
  const { env } = makeEnv()
  const body = 'B'.repeat(64)
  assert.equal((await put(env, PATH, body)).status, 204)
  const response = await get(env, PATH)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), body)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  const head = await get(env, PATH, 'HEAD')
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
})

test('body must be canonical base64url of 16..8192 chars', async () => {
  const { env } = makeEnv()
  assert.equal((await put(env, PATH, 'A'.repeat(15))).status, 400)
  assert.equal((await put(env, PATH, 'A'.repeat(15) + '=')).status, 400)
  assert.equal((await put(env, PATH, 'A'.repeat(15) + '!')).status, 400)
  assert.equal((await put(env, PATH, 'A'.repeat(16))).status, 204)
  assert.equal((await put(env, PATH, 'A'.repeat(MAX_BODY))).status, 204)
  assert.equal((await put(env, PATH, 'A'.repeat(MAX_BODY + 1))).status, 413)
})

test('oversize is rejected even without Content-Length', async () => {
  const { env } = makeEnv()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('A'.repeat(MAX_BODY + 1)))
      controller.close()
    },
  })
  const response = await handleRequest(new Request(`https://book.example.workers.dev/r/${PATH}`, {
    method: 'PUT',
    headers: { authorization: 'Bearer write-secret' },
    body: stream,
    duplex: 'half',
  }), env)
  assert.equal(response.status, 413)
})

test('only 64 records fit; overwriting an existing path still works when full', async () => {
  const { env } = makeEnv()
  for (let i = 0; i < MAX_RECORDS; i += 1) {
    assert.equal((await put(env, pathFor(i), 'A'.repeat(16))).status, 204)
  }
  assert.equal((await put(env, 'B'.repeat(43), 'A'.repeat(16))).status, 507)
  assert.equal((await put(env, pathFor(0), 'B'.repeat(16))).status, 204)
  assert.equal((await get(env, pathFor(0)).then((r) => r.text())), 'B'.repeat(16))
})

test('DELETE is idempotent and removes the record', async () => {
  const { env } = makeEnv()
  assert.equal((await del(env, PATH, 'wrong')).status, 401)
  assert.equal((await del(env, PATH)).status, 204)
  assert.equal((await put(env, PATH, 'C'.repeat(16))).status, 204)
  assert.equal((await del(env, PATH)).status, 204)
  assert.equal((await del(env, PATH)).status, 204)
  assert.equal((await get(env, PATH)).status, 404)
})

test('unsupported methods are rejected', async () => {
  const { env } = makeEnv()
  const response = await handleRequest(new Request(`https://book.example.workers.dev/r/${PATH}`, { method: 'POST' }), env)
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'GET, HEAD, PUT, DELETE')
})
