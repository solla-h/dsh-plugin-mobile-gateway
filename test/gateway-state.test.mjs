import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGatewayState } from '../lib/gateway-state.mjs'

test('deploySalt: lazy, stable across reload, and invalid values fail closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-state-'))
  const file = path.join(dir, 'state.json')
  try {
    const state = createGatewayState(file)
    assert.equal(state.deploySalt, null)
    const salt = state.ensureDeploySalt()
    assert.match(salt, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(state.ensureDeploySalt(), salt)

    const reloaded = createGatewayState(file)
    assert.equal(reloaded.gatewayId, state.gatewayId)
    assert.equal(reloaded.deploySalt, salt)

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    raw.deploySalt = 'short'
    fs.writeFileSync(file, JSON.stringify(raw))
    assert.throws(() => createGatewayState(file), /failed to load gateway state/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
