import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createRendezvousDeployer, deriveScriptName } from '../lib/rendezvous-deploy.mjs'

const ACCOUNT = '0123456789abcdef0123456789abcdef'
const WORKER_URL = 'https://dsh-rendezvous-test.workers.dev'
const DEVICE_LOGIN = 'https://dash.cloudflare.com/oauth2/device'
const CODE = 'ABCD-1234'
const GATEWAY_ID = '3f1b9c2e-7d4a-4b8f-9c1d-2e5a6b7c8d9f'
const SALT = 'A'.repeat(43)

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
    stableScriptName: () => deriveScriptName(GATEWAY_ID, SALT),
    log: () => {},
    ...extra,
  }
}

test('deriveScriptName: stable per gateway+salt, opaque and valid', () => {
  const name = deriveScriptName(GATEWAY_ID, SALT)
  assert.equal(name, deriveScriptName(GATEWAY_ID, SALT))
  assert.match(name, /^dsh-rendezvous-[a-f0-9]{16}$/)
  assert.notEqual(name, deriveScriptName(GATEWAY_ID, 'B'.repeat(43)))
  assert.notEqual(name, deriveScriptName('another-gateway', SALT))
  assert.throws(() => deriveScriptName(GATEWAY_ID, 'short'), /deploy salt/)
})

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
    assert.equal(status.scriptName, deriveScriptName(GATEWAY_ID, SALT))
    assert.equal(status.login, null)
    assert.equal(JSON.stringify(status).includes('writeSecret'), false)
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(state.managed, true)
    assert.equal(state.url, WORKER_URL)
    assert.equal(state.accountId, ACCOUNT)
    assert.ok(state.writeSecret.length >= 32)
    const secretCall = calls.find((call) => call.args.includes('secret'))
    assert.ok(secretCall)
    assert.equal(secretCall.args[secretCall.args.indexOf('--name') + 1], status.scriptName,
      'the secret must target the deployed Worker, not wrangler.toml\'s default name')
    assert.equal(secretCall.args[secretCall.args.indexOf('--config') + 1], path.resolve('rendezvous-worker/wrangler.toml'))
    assert.equal(secretCall.child.stdinData, `${state.writeSecret}\n`)
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    }

    // An active redeploy reuses the existing secret and Worker name.
    const redeployed = await deployer.start()
    assert.equal(redeployed.phase, 'ready')
    assert.equal(redeployed.scriptName, status.scriptName)
    assert.equal(calls.filter((call) => call.args.includes('deploy')).length, 2)
    assert.equal(calls.filter((call) => call.args.includes('secret')).length, 1)
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
    assert.equal(status.configured, true)
    assert.equal(status.url, WORKER_URL)
    assert.equal(deployer.config()?.url, WORKER_URL)
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

test('disable keeping the Worker retains state; re-enable reuses the same name and URL', async () => {
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
    const first = await deployer.start()
    const stopped = await deployer.remove({ deleteWorker: false })
    assert.equal(stopped.phase, 'idle')
    assert.equal(stopped.configured, false)
    assert.equal(stopped.retained, true)
    assert.equal(stopped.scriptName, first.scriptName)
    assert.equal(stopped.url, WORKER_URL)
    assert.equal(deployer.config(), null)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(saved.active, false)
    assert.equal(saved.secretReady, true)
    assert.equal(saved.scriptName, first.scriptName)
    assert.ok(!calls.some((call) => call.args.includes('delete')))

    // Process restart while retained: still off, still reusable.
    const reloaded = createRendezvousDeployer(baseOptions(file, spawnProcess))
    assert.equal(reloaded.status().configured, false)
    assert.equal(reloaded.status().retained, true)
    assert.equal(reloaded.config(), null)

    const again = await deployer.start()
    assert.equal(again.phase, 'ready')
    assert.equal(again.configured, true)
    assert.equal(again.scriptName, first.scriptName)
    const deploys = calls.filter((call) => call.args.includes('deploy'))
    assert.equal(deploys.length, 2)
    for (const call of deploys) {
      assert.equal(call.args[call.args.indexOf('--name') + 1], first.scriptName)
    }
    // Re-enable re-uploads the same secret (the Worker may have been changed
    // while off), but never generates a new one.
    const secrets = calls.filter((call) => call.args.includes('secret'))
    assert.equal(secrets.length, 2)
    assert.equal(secrets[0].child.stdinData, secrets[1].child.stdinData)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('deploy failure before state exists retries with the same stable name', async () => {
  const { dir, file } = tempState()
  try {
    let fail = true
    let loggedIn = true
    const { spawnProcess, calls } = fakeSpawn((args) => {
      if (args.includes('whoami')) return loggedIn ? { stdout: `You are logged in.\nAccount ID: ${ACCOUNT}\n` } : { code: 1 }
      if (args.includes('deploy')) return fail ? { code: 1, stderr: 'deploy failed' } : { stdout: `Deployed ${WORKER_URL}\n` }
      if (args.includes('secret')) return { code: 0 }
      return { code: 0 }
    })
    const deployer = createRendezvousDeployer(baseOptions(file, spawnProcess))
    const failed = await deployer.start()
    assert.equal(failed.phase, 'error')
    assert.equal(failed.configured, false)
    assert.equal(fs.existsSync(file), false)
    assert.equal(deployer.config(), null)

    fail = false
    const retried = await deployer.start()
    assert.equal(retried.phase, 'ready')
    const expected = deriveScriptName(GATEWAY_ID, SALT)
    assert.equal(retried.scriptName, expected)
    const deployments = calls.filter((call) => call.args.includes('deploy'))
    assert.equal(deployments.length, 2)
    for (const call of deployments) {
      assert.equal(call.args[call.args.indexOf('--name') + 1], expected)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('failed secret upload keeps the deployed Worker; retry reuses its name and re-uploads', async () => {
  const { dir, file } = tempState()
  try {
    let secretFails = true
    let loggedIn = true
    const { spawnProcess, calls } = fakeSpawn((args) => {
      if (args.includes('whoami')) return loggedIn ? { stdout: `You are logged in.\nAccount ID: ${ACCOUNT}\n` } : { code: 1 }
      if (args.includes('deploy')) return { stdout: `Deployed ${WORKER_URL}\n` }
      if (args.includes('secret')) return secretFails ? { code: 1, stderr: 'secret upload failed' } : { code: 0 }
      return { code: 0 }
    })
    const deployer = createRendezvousDeployer(baseOptions(file, spawnProcess))
    const failed = await deployer.start()
    assert.equal(failed.phase, 'error')
    assert.equal(failed.configured, false)
    assert.equal(failed.retained, true)
    assert.equal(deployer.config(), null)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(saved.active, false)
    assert.equal(saved.secretReady, false)
    assert.equal(saved.url, WORKER_URL)
    assert.match(saved.scriptName, /^dsh-rendezvous-[a-f0-9]{16}$/)

    secretFails = false
    const retried = await deployer.start()
    assert.equal(retried.phase, 'ready')
    assert.equal(retried.configured, true)
    assert.equal(retried.scriptName, saved.scriptName)
    const deployments = calls.filter((call) => call.args.includes('deploy'))
    assert.equal(deployments.length, 2)
    for (const call of deployments) {
      assert.equal(call.args[call.args.indexOf('--name') + 1], saved.scriptName,
        'retry must overwrite the Worker it already created, not create a new one')
    }
    assert.equal(calls.filter((call) => call.args.includes('secret')).length, 2)
    const finalState = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(finalState.active, true)
    assert.equal(finalState.secretReady, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy state without active/secretReady still counts as configured', () => {
  const { dir, file } = tempState()
  try {
    fs.writeFileSync(file, `${JSON.stringify({
      version: 1,
      managed: true,
      url: WORKER_URL,
      writeSecret: 'a'.repeat(32),
      accountId: ACCOUNT,
      scriptName: 'dsh-rendezvous-12345678',
      deployedAt: 1,
      workerVersion: 1,
    })}\n`)
    const deployer = createRendezvousDeployer(baseOptions(file, fakeSpawn(() => ({})).spawnProcess))
    assert.equal(deployer.status().configured, true)
    assert.equal(deployer.status().retained, false)
    assert.equal(deployer.config()?.url, WORKER_URL)
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
