import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createRendezvousDeployer } from '../lib/rendezvous-deploy.mjs'

const ACCOUNT = '0123456789abcdef0123456789abcdef'
const WORKER_URL = 'https://dsh-rendezvous-test.workers.dev'
const DEVICE_LOGIN = 'https://dash.cloudflare.com/oauth2/device'
const CODE = 'ABCD-1234'

function fakeSpawn(script) {
  const calls = []
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = new EventEmitter()
    child.stdinData = ''
    child.stdin.write = (chunk) => { child.stdinData += String(chunk) }
    child.stdin.end = () => {}
    child.kill = () => { child.emit('exit', null, 'SIGTERM') }
    calls.push({ command, args, options, child })
    const step = script(args) || {}
    setImmediate(() => {
      if (step.stdout) child.stdout.emit('data', step.stdout)
      if (step.stderr) child.stderr.emit('data', step.stderr)
      if (step.hang) return
      if (step.delay) setTimeout(() => child.emit('exit', step.code ?? 0, null), step.delay)
      else child.emit('exit', step.code ?? 0, null)
    })
    return child
  }
  return { spawnProcess, calls }
}

function tempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdv-deploy-'))
  return { dir, file: path.join(dir, 'rendezvous.json') }
}

function baseOptions(stateFile, spawnProcess, extra = {}) {
  return {
    stateFile,
    workerDir: path.resolve('rendezvous-worker'),
    spawnProcess,
    log: () => {},
    ...extra,
  }
}

test('deploy: whoami -> deploy -> secret, state is 0600 and secret never appears in status', async () => {
  const { dir, file } = tempState()
  try {
    let loggedIn = true
    const { spawnProcess, calls } = fakeSpawn((args) => {
      if (args.includes('whoami')) {
        return loggedIn
          ? { stdout: `You are logged in.\nAccount ID: ${ACCOUNT}\n` }
          : { code: 1, stdout: 'You are not logged in.\n' }
      }
      if (args.includes('deploy')) return { stdout: `Deployed ${WORKER_URL}\n` }
      if (args.includes('secret')) return { code: 0 }
      return { code: 0 }
    })
    const deployer = createRendezvousDeployer(baseOptions(file, spawnProcess))
    const status = await deployer.start()
    assert.equal(status.phase, 'ready')
    assert.equal(status.configured, true)
    assert.equal(status.managed, true)
    assert.equal(status.url, WORKER_URL)
    assert.equal(status.accountId, ACCOUNT)
    assert.match(status.scriptName, /^dsh-rendezvous-[a-f0-9]{8}$/)
    assert.equal(status.login, null)
    assert.equal(JSON.stringify(status).includes('writeSecret'), false)
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(state.managed, true)
    assert.equal(state.url, WORKER_URL)
    assert.equal(state.accountId, ACCOUNT)
    assert.ok(state.writeSecret.length >= 32)
    const secretCall = calls.find((call) => call.args.includes('secret'))
    assert.ok(secretCall)
    assert.equal(secretCall.child.stdinData, `${state.writeSecret}\n`)
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('login: device flow exposes URL/code, then deploys', async () => {
  const { dir, file } = tempState()
  try {
    let loggedIn = false
    const { spawnProcess } = fakeSpawn((args) => {
      if (args.includes('whoami')) {
        return loggedIn
          ? { stdout: `You are logged in.\nAccount ID: ${ACCOUNT}\n` }
          : { code: 1, stdout: 'You are not logged in.\n' }
      }
      if (args.includes('login')) {
        loggedIn = true
        return { stdout: `Open ${DEVICE_LOGIN}\nCode: ${CODE}\n`, delay: 50 }
      }
      if (args.includes('deploy')) return { stdout: `Deployed ${WORKER_URL}\n` }
      if (args.includes('secret')) return { code: 0 }
      return { code: 0 }
    })
    const deployer = createRendezvousDeployer(baseOptions(file, spawnProcess))
    const seen = []
    const timer = setInterval(() => {
      const value = deployer.status()
      if (value.login?.url) seen.push({ url: value.login.url, code: value.login.code })
    }, 1)
    const status = await deployer.start()
    clearInterval(timer)
    assert.equal(status.phase, 'ready')
    assert.equal(status.url, WORKER_URL)
    assert.ok(seen.some((entry) => entry.url === DEVICE_LOGIN && entry.code === CODE))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('cancel during device login returns to idle without touching state', async () => {
  const { dir, file } = tempState()
  try {
    const { spawnProcess } = fakeSpawn((args) => {
      if (args.includes('whoami')) return { code: 1, stdout: 'You are not logged in.\n' }
      if (args.includes('login')) return { hang: true, stdout: `Open ${DEVICE_LOGIN}\nCode: ${CODE}\n` }
      return { code: 0 }
    })
    const deployer = createRendezvousDeployer(baseOptions(file, spawnProcess))
    const pending = deployer.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    deployer.cancel()
    await pending
    const status = deployer.status()
    assert.equal(status.phase, 'idle')
    assert.equal(status.configured, false)
    assert.equal(fs.existsSync(file), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('adopt: validates the write secret with an idempotent DELETE and stores a non-managed state', async () => {
  const { dir, file } = tempState()
  try {
    const requests = []
    const fetchImpl = async (url, init) => {
      requests.push({ url, init })
      return { status: 204 }
    }
    const deployer = createRendezvousDeployer(baseOptions(file, fakeSpawn(() => ({})).spawnProcess, { fetchImpl }))
    const status = await deployer.adopt({ url: WORKER_URL, writeSecret: 'a'.repeat(32) })
    assert.equal(status.phase, 'ready')
    assert.equal(status.managed, false)
    assert.equal(status.url, WORKER_URL)
    assert.equal(requests.length, 1)
    assert.match(requests[0].url, /^https:\/\/dsh-rendezvous-test\.workers\.dev\/r\/[A-Za-z0-9_-]{43}$/)
    assert.equal(requests[0].init.method, 'DELETE')
    assert.equal(requests[0].init.headers.authorization, `Bearer ${'a'.repeat(32)}`)
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(state.managed, false)
    assert.equal(state.scriptName, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('adopt rejects a Worker that refuses the write secret', async () => {
  const { dir, file } = tempState()
  try {
    const deployer = createRendezvousDeployer(baseOptions(file, fakeSpawn(() => ({})).spawnProcess, {
      fetchImpl: async () => ({ status: 401 }),
    }))
    await assert.rejects(() => deployer.adopt({ url: WORKER_URL, writeSecret: 'a'.repeat(32) }), /401/)
    assert.equal(fs.existsSync(file), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('remove deletes a managed Worker and the state file', async () => {
  const { dir, file } = tempState()
  try {
    let loggedIn = true
    const { spawnProcess, calls } = fakeSpawn((args) => {
      if (args.includes('whoami')) return loggedIn ? { stdout: `You are logged in.\nAccount ID: ${ACCOUNT}\n` } : { code: 1 }
      if (args.includes('deploy')) return { stdout: `Deployed ${WORKER_URL}\n` }
      if (args.includes('secret')) return { code: 0 }
      if (args.includes('delete')) return { code: 0 }
      return { code: 0 }
    })
    const deployer = createRendezvousDeployer(baseOptions(file, spawnProcess))
    await deployer.start()
    const status = await deployer.remove({ deleteWorker: true })
    assert.equal(status.phase, 'idle')
    assert.equal(status.configured, false)
    assert.ok(calls.some((call) => call.args.includes('delete')))
    assert.equal(fs.existsSync(file), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
