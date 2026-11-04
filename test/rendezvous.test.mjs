import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createRequire } from 'node:module'

import { createTestConnection } from './helpers/peer.mjs'
import {
  deriveLocator,
  encryptAddressBook,
  sealEnvelope,
  createRendezvousPublisher,
} from '../lib/rendezvous.mjs'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const plugin = (await import('../lib/index.mjs')).default
const { createRegistry } = require('../lib/devices.js')

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const KEY_RE = /^[A-Za-z0-9_-]{43}$/
const GATEWAY_ID = '3f1b9c2e-7d4a-4b8f-9c1d-2e5a6b7c8d9f'
const VECTOR_BODY =
  'AQABAgMEBQYHCAkKC2o9ixs6CrlWNdCqYJujnipSZYB1j0sz5t82XX8Su-FrC8YpOXSsYbkM3N3BIpt2ZwvLEVXkIpzzvJ24ZQ5T2JZG2t4cRP9us4GHPDYsBOOtYbTmzqr7IXRB2LlrK06nw9AhZRfAxXldWIyzgLXGPvFW9siaH6kXprVGGwInS0hXLir8cFeF3KwcisSqb5u6eWz2OgMcOfJoK-g6vMXekd1Hc5vSloBXbyj9acQOIKZfietXgjZjt9q0ZkibAIitqDB_j_pBUhbADYxPUbyWtevfZTaTPA'
const VECTOR_PLAINTEXT =
  '{"v":1,"rev":7,"ts":1762000000000,"gatewayId":"3f1b9c2e-7d4a-4b8f-9c1d-2e5a6b7c8d9f","name":"Test Gateway","endpoints":["wss://abc.trycloudflare.com/ws/mobile","ws://192.168.10.12:3081/ws/mobile"]}'

function openBody(key, body, aadOverride) {
  const raw = Buffer.from(body, 'base64url')
  const { path: derived, aesKey } = deriveLocator(key)
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, raw.subarray(1, 13))
  decipher.setAAD(Buffer.from(aadOverride ?? derived, 'utf8'))
  decipher.setAuthTag(raw.subarray(raw.length - 16))
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(13, raw.length - 16)), decipher.final()]).toString('utf8'))
}

const settle = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    return handler(url, init, calls.length)
  }
  return { fetchImpl, calls }
}

const ok = () => ({ status: 204 })

test('crypto: fixed key+nonce reproduces the §4.2 vector byte for byte', () => {
  const body = sealEnvelope({
    key: KEY,
    nonce: Buffer.from('000102030405060708090a0b', 'hex'),
    plaintext: VECTOR_PLAINTEXT,
  })
  assert.equal(body, VECTOR_BODY)
})

test('crypto: wrong key or wrong AAD cannot decrypt', () => {
  const body = encryptAddressBook({
    key: KEY,
    rev: 7,
    gatewayId: GATEWAY_ID,
    endpoints: ['wss://a.example.com/ws/mobile'],
  })
  assert.equal(openBody(KEY, body).rev, 7)
  assert.throws(() => openBody(KEY, body, 'some-other-path'))
  assert.throws(() => openBody('B'.repeat(43), body))
})

test('devices: rendezvous key is lazy, idempotent, survives reload, and stays private', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rendezvous-devices-'))
  const file = path.join(temp, 'devices.json')
  const registry = createRegistry(file, { pairingTtlMs: 60_000 })
  const claimed = registry.claimPairing(registry.createPairing('Phone').code, 'client-device-0001', 'Phone')
  const deviceId = claimed.device.id

  assert.equal(registry.peekRendezvousKey(deviceId), undefined)
  const key = registry.ensureRendezvousKey(deviceId)
  assert.match(key, KEY_RE)
  assert.equal(registry.ensureRendezvousKey(deviceId), key)
  assert.deepEqual(registry.rendezvousEntries(), [{ id: deviceId, key }])

  // publicDevice()/list() must never expose the read capability.
  assert.equal(JSON.stringify(registry.list()).includes(key), false)
  assert.equal(JSON.stringify(registry.authenticate(claimed.token)).includes(key), false)

  // load() rebuilds each row field by field: the key must survive a restart.
  const reloaded = createRegistry(file, { pairingTtlMs: 60_000 })
  assert.equal(reloaded.peekRendezvousKey(deviceId), key)
  assert.deepEqual(reloaded.rendezvousEntries(), [{ id: deviceId, key }])

  // Re-pairing keeps the stable device record (and therefore the key).
  const repaired = reloaded.claimPairing(reloaded.createPairing('Phone').code, 'client-device-0001', 'Phone')
  assert.equal(repaired.device.id, deviceId)
  assert.equal(reloaded.peekRendezvousKey(deviceId), key)

  assert.equal(reloaded.revoke(deviceId), true)
  assert.equal(reloaded.peekRendezvousKey(deviceId), undefined)
  assert.deepEqual(reloaded.rendezvousEntries(), [])
})

test('publisher: publishes on start, decryptable, secret only in Authorization', async () => {
  const { fetchImpl, calls } = fakeFetch(ok)
  const now = 1_762_000_000_000
  const publisher = createRendezvousPublisher({
    url: 'https://book.example.workers.dev/',
    writeSecret: 'write-secret',
    gatewayId: GATEWAY_ID,
    getEndpoints: () => ['wss://abc.trycloudflare.com/ws/mobile', 'ws://192.168.10.12:3081/ws/mobile'],
    getEntries: () => [{ id: 'd1', key: KEY }],
    fetchImpl,
    now: () => now,
    tickMs: 60_000,
    republishMs: 30 * 60_000,
  })
  publisher.start()
  await settle()

  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.equal(call.init.method, 'PUT')
  assert.equal(call.url, `https://book.example.workers.dev/r/${deriveLocator(KEY).path}`)
  assert.equal(call.init.headers.authorization, 'Bearer write-secret')
  const plaintext = openBody(KEY, call.init.body)
  assert.deepEqual(plaintext, {
    v: 1,
    rev: now,
    gatewayId: GATEWAY_ID,
    endpoints: ['wss://abc.trycloudflare.com/ws/mobile', 'ws://192.168.10.12:3081/ws/mobile'],
  })
  assert.equal(JSON.stringify(publisher.status()).includes('write-secret'), false)
  publisher.stop()
})

test('publisher: unchanged endpoints are not republished; a change is', async () => {
  let endpoints = ['wss://a.example.com/ws/mobile']
  const { fetchImpl, calls } = fakeFetch(ok)
  const publisher = createRendezvousPublisher({
    url: 'https://book.example.workers.dev',
    writeSecret: 's',
    gatewayId: GATEWAY_ID,
    getEndpoints: () => endpoints,
    getEntries: () => [{ id: 'd1', key: KEY }],
    fetchImpl,
    tickMs: 5,
    republishMs: 60 * 60_000,
  })
  publisher.start()
  await settle(30)
  assert.equal(calls.length, 1)

  endpoints = ['wss://b.example.com/ws/mobile']
  await settle(30)
  assert.equal(calls.length, 2)
  assert.deepEqual(openBody(KEY, calls[1].init.body).endpoints, endpoints)
  publisher.stop()
})

test('publisher: republishMs forces a fresh PUT', async () => {
  const { fetchImpl, calls } = fakeFetch(ok)
  const publisher = createRendezvousPublisher({
    url: 'https://book.example.workers.dev',
    writeSecret: 's',
    gatewayId: GATEWAY_ID,
    getEndpoints: () => ['wss://a.example.com/ws/mobile'],
    getEntries: () => [{ id: 'd1', key: KEY }],
    fetchImpl,
    tickMs: 5,
    republishMs: 10,
  })
  publisher.start()
  await settle(50)
  assert.ok(calls.length >= 2)
  const revs = calls.map((call) => openBody(KEY, call.init.body).rev)
  assert.equal(new Set(revs).size, revs.length, 'rev must strictly increase even within one millisecond')
  publisher.stop()
})

test('publisher: PUT failure records lastError and retries on the next tick', async () => {
  const { fetchImpl, calls } = fakeFetch((url, init, n) =>
    init.method === 'PUT' && n <= 2 ? { status: 500 } : { status: 204 })
  const publisher = createRendezvousPublisher({
    url: 'https://book.example.workers.dev',
    writeSecret: 's',
    gatewayId: GATEWAY_ID,
    getEndpoints: () => ['wss://a.example.com/ws/mobile'],
    getEntries: () => [{ id: 'd1', key: KEY }],
    fetchImpl,
    tickMs: 10,
    republishMs: 60 * 60_000,
  })
  publisher.start()
  await settle(10)
  assert.match(publisher.status().lastError, /PUT failed: HTTP 500/)
  await settle(40)
  assert.ok(calls.filter((call) => call.init.method === 'PUT').length >= 2)
  assert.equal(publisher.status().lastError, null, 'a later successful PUT clears the stale error')
  publisher.stop()
})

test('publisher: retire queues DELETE behind an in-flight PUT and never resurrects', async () => {
  let entries = [{ id: 'd1', key: KEY }]
  let releasePut
  const { fetchImpl, calls } = fakeFetch((url, init) => {
    if (init.method === 'PUT') {
      return new Promise((resolve) => {
        releasePut = () => resolve({ status: 204 })
      })
    }
    return { status: 204 }
  })
  const publisher = createRendezvousPublisher({
    url: 'https://book.example.workers.dev',
    writeSecret: 's',
    gatewayId: GATEWAY_ID,
    getEndpoints: () => ['wss://a.example.com/ws/mobile'],
    getEntries: () => entries,
    fetchImpl,
    tickMs: 60_000,
    republishMs: 60 * 60_000,
  })
  publisher.start()
  await settle()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.method, 'PUT')

  entries = []
  publisher.retire(KEY)
  assert.equal(calls.length, 1, 'DELETE must wait for the in-flight PUT')

  releasePut()
  await settle()
  assert.equal(calls.length, 2)
  assert.equal(calls[1].init.method, 'DELETE')
  assert.equal(calls[1].url, calls[0].url)

  publisher.poke()
  await settle()
  assert.equal(calls.filter((call) => call.init.method === 'PUT').length, 1)
  publisher.stop()
})

test('publisher: oversized bodies drop endpoints from the tail', async () => {
  const endpoints = Array.from({ length: 16 }, (_, i) => `wss://a${i}.example.com/${'a'.repeat(2000)}`)
  const { fetchImpl, calls } = fakeFetch(ok)
  const publisher = createRendezvousPublisher({
    url: 'https://book.example.workers.dev',
    writeSecret: 's',
    gatewayId: GATEWAY_ID,
    getEndpoints: () => endpoints,
    getEntries: () => [{ id: 'd1', key: KEY }],
    fetchImpl,
    tickMs: 60_000,
  })
  publisher.start()
  await settle()
  assert.equal(calls.length, 1)
  assert.ok(calls[0].init.body.length <= 8192)
  const published = openBody(KEY, calls[0].init.body).endpoints
  assert.ok(published.length < endpoints.length)
  assert.match(publisher.status().lastError, /dropped/)
  publisher.stop()
})

// ---- frame-level integration -------------------------------------------------

function waitForFrame(socket, predicate, label = 'frame') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error(`timed out waiting for ${label}`))
    }, 3000)
    const onMessage = (data) => {
      const frame = JSON.parse(data.toString())
      if (!predicate(frame)) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(frame)
    }
    socket.on('message', onMessage)
  })
}

const waitForKind = (socket, kind) => waitForFrame(socket, (frame) => frame.kind === kind, kind)

async function startGateway(options = {}) {
  const { rendezvousState, ...pluginOptions } = options
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rendezvous-gw-'))
  const deviceFile = path.join(temp, 'devices.json')
  if (rendezvousState) fs.writeFileSync(`${deviceFile}.rendezvous.json`, JSON.stringify(rendezvousState))
  let managementRoute
  let upgradeRoute
  const disposers = []
  const events = {}
  const server = http.createServer((req, res) => {
    if (managementRoute && (req.url === managementRoute.path || req.url.startsWith(`${managementRoute.path}/`))) {
      managementRoute.handler(req, res)
      return
    }
    res.writeHead(404).end()
  })
  const webServer = {
    port: 0,
    register(route) { managementRoute = route; return () => { managementRoute = undefined } },
    registerUpgrade(route) { upgradeRoute = route; return () => { upgradeRoute = undefined } },
  }
  server.on('upgrade', (req, socket, head) => {
    if (upgradeRoute) upgradeRoute.handler(req, socket, head)
    else socket.destroy()
  })
  const ctx = {
    webServer,
    connection: createTestConnection(),
    typertGateway: {
      async invoke() { throw new Error('unexpected Remote invocation') },
      async stream(request) {
        return (async function* () {
          if (request.namespace === 'workspace' && request.method === 'follow') {
            yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
            while (!request.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
          }
          if (request.namespace === 'session' && request.method === 'control') {
            yield { type: 'baseline', value: { projections: {} } }
            while (!request.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
          }
        })()
      },
    },
    agentDefaultModel: {},
    on(name, listener) { events[name] = listener; return () => {} },
    effect(factory) { disposers.push(factory()) },
  }
  plugin.apply(ctx, {
    requireAuth: true,
    gatewayEnabled: true,
    gatewayWaitTimeoutMs: 1_000,
    adminLoopbackOnly: true,
    pairingTtlMs: 60_000,
    deviceFile,
    publicUrl: 'wss://gw.example.com/ws/mobile',
    ...pluginOptions,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  webServer.port = server.address().port
  const base = `http://127.0.0.1:${webServer.port}`
  return {
    base,
    wsUrl: `ws://127.0.0.1:${webServer.port}/ws/mobile`,
    async close() {
      for (const dispose of disposers) await dispose()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function pairDevice(gateway, clientDeviceId = 'integration-device-0001') {
  const response = await fetch(`${gateway.base}/mgw/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: gateway.base },
    body: JSON.stringify({ name: 'Test Phone', publicUrl: gateway.wsUrl }),
  })
  assert.equal(response.status, 201)
  const body = await response.json()
  const socket = new WebSocket(
    gateway.wsUrl,
    ['dsh-mobile-v1', `dsh-pair.${body.payload.pairingCode}`],
    { headers: { 'X-DSH-Device-ID': clientDeviceId } },
  )
  const hello = waitForKind(socket, 'hello')
  const paired = waitForKind(socket, 'paired')
  await once(socket, 'open')
  return { socket, hello: await hello, paired: await paired }
}

function installFakeWorker() {
  const realFetch = globalThis.fetch
  const puts = []
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://book.example.workers.dev/')) {
      puts.push({ url, init })
      return new Response(null, { status: 204 })
    }
    return realFetch(url, init)
  }
  return { puts, restore() { globalThis.fetch = realFetch } }
}

test('frames: capability is authenticated-only; config is stable and decryptable', async () => {
  const worker = installFakeWorker()
  const gateway = await startGateway({
    rendezvousUrl: 'https://book.example.workers.dev',
    rendezvousWriteSecret: 'integration-write-secret',
  })
  try {
    const { socket, hello, paired } = await pairDevice(gateway)
    assert.equal(hello.authenticated, true)
    assert.equal(hello.capabilities.includes('rendezvous-v1'), true)

    socket.send(JSON.stringify({ type: 'rendezvous-config', requestId: 'req-1' }))
    const first = await waitForKind(socket, 'rendezvous-config')
    assert.equal(first.requestId, 'req-1')
    assert.equal(first.url, 'https://book.example.workers.dev')
    assert.match(first.key, KEY_RE)
    assert.equal(first.gatewayId, hello.gatewayId)

    socket.send(JSON.stringify({ type: 'rendezvous-config', requestId: 'req-2' }))
    const second = await waitForKind(socket, 'rendezvous-config')
    assert.equal(second.requestId, 'req-2')
    assert.equal(second.key, first.key)

    // poke() should have published the first key without waiting for the tick.
    await settle(50)
    assert.ok(worker.puts.length >= 1)
    const body = worker.puts.at(-1).init.body
    assert.equal(worker.puts.at(-1).url, `https://book.example.workers.dev/r/${deriveLocator(first.key).path}`)
    const plaintext = openBody(first.key, body)
    assert.equal(plaintext.gatewayId, hello.gatewayId)
    assert.deepEqual(plaintext.endpoints, ['wss://gw.example.com/ws/mobile'])

    const status = await (await fetch(`${gateway.base}/mgw/status`)).json()
    assert.equal(status.rendezvous.configured, true)
    assert.equal(status.rendezvous.devices, 1)
    assert.equal(JSON.stringify(status).includes('integration-write-secret'), false)

    // Revocation deletes the Worker record.
    const deviceId = paired.device.id
    const revoked = await fetch(`${gateway.base}/mgw/devices/${encodeURIComponent(deviceId)}/revoke`, {
      method: 'POST',
      headers: { Origin: gateway.base },
    })
    assert.equal(revoked.status, 200)
    await settle(30)
    assert.equal(worker.puts.at(-1).init.method, 'DELETE')
    socket.close()
  } finally {
    worker.restore()
    await gateway.close()
  }
})

test('frames: a managed state file returns the deployed Worker URL', async () => {
  const worker = installFakeWorker()
  const gateway = await startGateway({
    rendezvousState: {
      version: 1,
      managed: true,
      url: 'https://book.example.workers.dev',
      writeSecret: 's'.repeat(32),
      accountId: null,
      scriptName: null,
      deployedAt: 1,
      workerVersion: 1,
    },
  })
  try {
    const { socket, hello } = await pairDevice(gateway, 'integration-device-0003')
    assert.equal(hello.capabilities.includes('rendezvous-v1'), true)
    socket.send(JSON.stringify({ type: 'rendezvous-config', requestId: 'managed-1' }))
    const config = await waitForKind(socket, 'rendezvous-config')
    assert.equal(config.url, 'https://book.example.workers.dev')
    assert.equal(config.requestId, 'managed-1')
    socket.close()
  } finally {
    worker.restore()
    await gateway.close()
  }
})

test('frames: unauthenticated requests get authentication-required', async () => {
  const worker = installFakeWorker()
  const gateway = await startGateway({
    requireAuth: false,
    rendezvousUrl: 'https://book.example.workers.dev',
    rendezvousWriteSecret: 'integration-write-secret',
  })
  try {
    const anonymous = new WebSocket(gateway.wsUrl)
    const hello = waitForKind(anonymous, 'hello')
    await once(anonymous, 'open')
    const helloFrame = await hello
    assert.equal(helloFrame.authenticated, false)
    assert.equal(helloFrame.capabilities.includes('rendezvous-v1'), false)
    anonymous.send(JSON.stringify({ type: 'rendezvous-config', requestId: 'anon' }))
    const denied = await waitForKind(anonymous, 'error')
    assert.equal(denied.code, 'authentication-required')
    assert.equal(denied.requestId, 'anon')
    anonymous.close()
  } finally {
    worker.restore()
    await gateway.close()
  }
})

test('frames: rendezvous/disabled when the gateway is not configured', async () => {
  const gateway = await startGateway()
  try {
    const { socket, hello } = await pairDevice(gateway, 'integration-device-0002')
    assert.equal(hello.capabilities.includes('rendezvous-v1'), false)
    socket.send(JSON.stringify({ type: 'rendezvous-config', requestId: 'req-3' }))
    const denied = await waitForKind(socket, 'error')
    assert.equal(denied.code, 'rendezvous/disabled')
    assert.equal(denied.requestId, 'req-3')
    const status = await (await fetch(`${gateway.base}/mgw/status`)).json()
    assert.equal(status.rendezvous.configured, false)
    assert.equal(status.rendezvous.deploy.phase, 'idle')
    socket.close()
  } finally {
    await gateway.close()
  }
})
