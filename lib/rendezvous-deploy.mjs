// Managed Cloudflare Worker deployment for the optional address book.
//
// The plugin ships the Worker source under rendezvous-worker/. This module
// drives `wrangler` only when the user explicitly enables the feature. It
// never reads or stores the Cloudflare OAuth token: wrangler owns that file.
// The only secret we handle is the Worker write secret, generated locally and
// kept in a 0600 state file next to the device registry.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import QRCode from 'qrcode'
import { normalizeWorkerUrl } from './rendezvous.mjs'

export const RENDEZVOUS_WORKER_VERSION = 1
const WRANGLER_SPEC = 'wrangler@4.119.0'
const MAX_LOG_LINES = 200
const WHOAMI_TIMEOUT_MS = 30_000
const DEPLOY_TIMEOUT_MS = 5 * 60_000
const SECRET_TIMEOUT_MS = 60_000
const ADOPT_TIMEOUT_MS = 10_000
const ANSI_RE = /\u001b\[[0-9;]*m/g
const ACCOUNT_RE = /^[a-f0-9]{32}$/i
const SCRIPT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const SECRET_MAX = 512

const stripAnsi = (text) => String(text || '').replace(ANSI_RE, '')
const nowMs = () => Date.now()

function readState(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!value || value.version !== 1) return null
    const url = normalizeWorkerUrl(value.url)
    if (!url || typeof value.writeSecret !== 'string' || !value.writeSecret ||
        value.writeSecret.length > SECRET_MAX || /\s/.test(value.writeSecret)) return null
    if (value.managed !== undefined && typeof value.managed !== 'boolean') return null
    if (value.scriptName !== undefined && value.scriptName !== null && !SCRIPT_RE.test(value.scriptName)) return null
    if (value.accountId !== undefined && value.accountId !== null && !ACCOUNT_RE.test(value.accountId)) return null
    if (value.secretReady !== undefined && typeof value.secretReady !== 'boolean') return null
    if (value.active !== undefined && typeof value.active !== 'boolean') return null
    fs.chmodSync(file, 0o600)
    return {
      version: 1,
      managed: value.managed !== false,
      url,
      writeSecret: value.writeSecret,
      accountId: value.accountId || null,
      scriptName: value.scriptName || null,
      deployedAt: Number.isFinite(value.deployedAt) ? value.deployedAt : null,
      workerVersion: Number.isInteger(value.workerVersion) ? value.workerVersion : null,
      // States written by older versions were only persisted after a successful
      // deploy + secret upload, so missing fields mean ready and active.
      secretReady: value.secretReady !== false,
      active: value.active !== false,
    }
  } catch (error) {
    return null
  }
}

function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
    fs.chmodSync(file, 0o600)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function parseLoginOutput(text) {
  const cleaned = stripAnsi(text)
  const urls = cleaned.match(/https:\/\/[^\s"'<>]+/g) || []
  const url = urls.map((value) => value.replace(/[),.;]+$/, ''))
    .find((value) => /dash\.cloudflare\.com\/(?:oauth2\/)?device/i.test(value)) || null
  const code = cleaned.match(/(?:code|Code|码)[^\S\r\n]*[:：]?\s*([A-Za-z0-9-]{4,16})/)?.[1] || null
  return { url, code }
}

function parseWorkerUrl(text) {
  const cleaned = stripAnsi(text)
  const urls = cleaned.match(/https:\/\/[^\s"'<>]+/g) || []
  const candidates = []
  for (const raw of urls) {
    const normalized = normalizeWorkerUrl(raw.replace(/[),.;]+$/, ''))
    if (!normalized) continue
    if (/^https:\/\/(?:dash|developers)\.cloudflare\.com$/i.test(normalized)) continue
    candidates.push(normalized)
  }
  return candidates.find((value) => /\.workers\.dev$/i.test(new URL(value).hostname)) || candidates[0] || null
}

function isLoggedIn(result) {
  const text = `${result?.stdout || ''}\n${result?.stderr || ''}`
  return /logged in/i.test(text) && !/not logged in|not authenticated|no account/i.test(text)
}

function parseAccountId(text) {
  return stripAnsi(text).match(/\b[a-f0-9]{32}\b/i)?.[0]?.toLowerCase() || null
}

function randomScriptName() {
  return `dsh-rendezvous-${crypto.randomBytes(4).toString('hex')}`
}

/**
 * Stable managed Worker name. The salt lives in the gateway identity state, so
 * deleting only the rendezvous state reuses the same Worker URL; gatewayId is
 * mixed in so cloning a salt alone does not produce a predictable name.
 */
export function deriveScriptName(gatewayId, salt) {
  if (typeof gatewayId !== 'string' || !gatewayId) throw new TypeError('gatewayId is required')
  if (typeof salt !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(salt)) throw new TypeError('deploy salt is invalid')
  const digest = crypto.createHmac('sha256', Buffer.from(salt, 'base64url'))
    .update(`dsh-rendezvous-script-v1\n${gatewayId}`)
    .digest('hex')
  const name = `dsh-rendezvous-${digest.slice(0, 16)}`
  if (!SCRIPT_RE.test(name)) throw new Error('derived Worker name is invalid')
  return name
}

function normalizeSecret(value) {
  if (typeof value !== 'string') return null
  const secret = value.trim()
  if (!secret || secret.length > SECRET_MAX || /\s/.test(secret)) return null
  return secret
}

/**
 * Create the managed deployment state machine.
 *
 * status()/summary() never expose the write secret. The state file is the only
 * place it lives (besides the Worker secret itself).
 */
export function createRendezvousDeployer(options = {}) {
  const {
    stateFile,
    workerDir,
    spawnProcess = spawn,
    fetchImpl = fetch,
    log = () => {},
    onConfigured = () => {},
    onStopped = () => {},
    stableScriptName = null,
    wranglerSpec = WRANGLER_SPEC,
    now = nowMs,
  } = options || {}
  if (typeof stateFile !== 'string' || !stateFile) throw new TypeError('stateFile is required')
  if (typeof workerDir !== 'string' || !workerDir) throw new TypeError('workerDir is required')
  if (stableScriptName !== null && typeof stableScriptName !== 'function') {
    throw new TypeError('stableScriptName must be a function')
  }

  let state = readState(stateFile)
  let phase = state ? (state.active ? 'ready' : 'idle') : 'idle'
  let login = null
  let error = null
  let logs = []
  let accountId = state?.accountId || null
  let running = false
  let cancelRequested = false
  let child = null
  let disposed = false

  const pushLog = (line) => {
    const text = stripAnsi(line).trim()
    if (!text) return
    for (const part of text.split(/\r?\n/)) {
      if (!part.trim()) continue
      logs.push(part.trim())
      while (logs.length > MAX_LOG_LINES) logs.shift()
    }
  }

  const setError = (cause) => {
    error = cause && cause.message ? cause.message : String(cause || 'unknown error')
    pushLog(`error: ${error}`)
    log(`[rendezvous-deploy] ${error}`)
  }

  const config = () => state && state.active
    ? { url: state.url, writeSecret: state.writeSecret, managed: state.managed }
    : null

  const summary = () => ({
    phase,
    configured: !!state && state.active,
    retained: !!state && !state.active,
    managed: state ? state.managed : false,
    url: state?.url || null,
    accountId: state?.accountId || null,
    scriptName: state?.scriptName || null,
    workerVersion: state?.workerVersion || null,
    deployedAt: state?.deployedAt || null,
    running,
    error,
  })

  const status = () => ({
    ...summary(),
    login: phase === 'login' && login ? { ...login } : null,
    log: logs.slice(-MAX_LOG_LINES),
  })

  const runWrangler = (args, { input, timeoutMs = SECRET_TIMEOUT_MS, onOutput } = {}) => new Promise((resolve, reject) => {
    if (disposed) {
      reject(new Error('deployer is disposed'))
      return
    }
    const win = process.platform === 'win32'
    const command = win ? 'npx.cmd' : 'npx'
    const env = {
      ...process.env,
      NO_COLOR: '1',
      ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
    }
    let proc
    try {
      proc = spawnProcess(command, ['-y', wranglerSpec, ...args], {
        cwd: workerDir,
        env,
        shell: win,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (cause) {
      reject(new Error(`failed to start wrangler: ${cause.message}`))
      return
    }
    child = proc
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (child === proc) child = null
      fn(value)
    }
    const collect = (stream) => (chunk) => {
      const text = stripAnsi(String(chunk))
      if (stream === 'stdout') stdout += text
      else stderr += text
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        pushLog(`wrangler: ${line.trim()}`)
        if (onOutput) onOutput(line)
      }
    }
    proc.stdout?.on('data', collect('stdout'))
    proc.stderr?.on('data', collect('stderr'))
    proc.on?.('error', (cause) => finish(reject, new Error(`wrangler failed to start: ${cause.message}`)))
    proc.on?.('exit', (code, signal) => finish(resolve, { code, signal, stdout, stderr }))
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { proc.kill('SIGTERM') } catch {}
        finish(reject, new Error(`wrangler ${args[0] || ''} timed out`))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    }
    if (proc.stdin) {
      proc.stdin.on?.('error', () => {})
      if (input !== undefined) proc.stdin.write(input)
      proc.stdin.end()
    }
  })

  const updateLogin = (line) => {
    const parsed = parseLoginOutput(line)
    if (!parsed.url && !parsed.code) return
    const next = { url: login?.url || null, code: login?.code || null, qrDataUrl: login?.qrDataUrl || null }
    if (parsed.url) next.url = parsed.url
    if (parsed.code) next.code = parsed.code
    login = next
    if (next.url && !next.qrDataUrl) {
      const url = next.url
      void QRCode.toDataURL(url, { margin: 1, width: 260 }).then((qr) => {
        if (login?.url === url) login = { ...login, qrDataUrl: qr }
      }).catch(() => {})
    }
  }

  const loginFlow = async () => {
    phase = 'login'
    login = { url: 'https://dash.cloudflare.com/oauth2/device', code: null, qrDataUrl: null }
    pushLog('需要 Cloudflare 登录；请打开面板中的地址并输入短码。')
    const result = await runWrangler(['login', '--device'], {
      timeoutMs: 0,
      onOutput: updateLogin,
    })
    if (cancelRequested) return
    if (result.code !== 0) throw new Error('Cloudflare 登录未完成或被取消')
    phase = 'checking'
    pushLog('Cloudflare 登录完成，正在确认账号…')
    const who = await runWrangler(['whoami'], { timeoutMs: WHOAMI_TIMEOUT_MS })
    if (!isLoggedIn(who)) throw new Error('Cloudflare 登录后仍未检测到有效账号')
    accountId = accountId || parseAccountId(`${who.stdout}\n${who.stderr}`)
    login = null
  }

  const deployFlow = async () => {
    phase = 'deploying'
    error = null
    const scriptName = state?.scriptName || (stableScriptName ? stableScriptName() : randomScriptName())
    if (!SCRIPT_RE.test(scriptName)) throw new Error('Worker 名称不合法')
    pushLog(`部署 Worker：${scriptName}`)
    const deploy = await runWrangler(['deploy', '--name', scriptName, '--config', path.join(workerDir, 'wrangler.toml')], {
      timeoutMs: DEPLOY_TIMEOUT_MS,
      input: undefined,
    })
    if (deploy.code !== 0) throw new Error(`wrangler deploy 失败（退出码 ${deploy.code}）`)
    const url = parseWorkerUrl(`${deploy.stdout}\n${deploy.stderr}`)
    if (!url) throw new Error('Worker 已部署，但无法从 wrangler 输出中解析地址；请在 Cloudflare 面板复制地址后使用“连接到已有 Worker”')
    const writeSecret = state?.writeSecret || crypto.randomBytes(24).toString('base64url')
    // Re-enabling a retained Worker re-uploads the same secret: it may have been
    // deleted or altered in Cloudflare while off. An active redeploy keeps its
    // existing secret so a transient secret failure cannot take a working
    // address book down.
    const secretReady = Boolean(state?.secretReady && state?.active)
    // Persist as soon as the Worker exists. If the secret upload fails or the
    // process dies, the retry reuses this name/URL instead of orphaning it.
    const deployed = {
      version: 1,
      managed: true,
      url,
      writeSecret,
      accountId: accountId || null,
      scriptName,
      deployedAt: now(),
      workerVersion: RENDEZVOUS_WORKER_VERSION,
      secretReady,
      active: secretReady,
    }
    writeState(stateFile, deployed)
    state = deployed
    if (cancelRequested) return
    if (!secretReady) {
      pushLog('上传地址簿写密钥…')
      const secret = await runWrangler([
        'secret', 'put', 'WRITE_SECRET',
        '--name', scriptName,
        '--config', path.join(workerDir, 'wrangler.toml'),
      ], {
        input: `${writeSecret}\n`,
        timeoutMs: SECRET_TIMEOUT_MS,
      })
      if (cancelRequested) return
      if (secret.code !== 0) throw new Error(`上传 WRITE_SECRET 失败（退出码 ${secret.code}）`)
    }
    const next = { ...deployed, secretReady: true, active: true }
    writeState(stateFile, next)
    state = next
    phase = 'ready'
    login = null
    error = null
    pushLog(`地址簿已就绪：${url}`)
    await onConfigured(config())
  }

  const ensureIdle = (message) => {
    if (running) {
      const cause = new Error(message)
      cause.status = 409
      throw cause
    }
  }

  const start = async ({ accountId: selectedAccountId } = {}) => {
    ensureIdle('地址簿部署正在进行中')
    if (selectedAccountId !== undefined && selectedAccountId !== null && selectedAccountId !== '') {
      if (typeof selectedAccountId !== 'string' || !ACCOUNT_RE.test(selectedAccountId)) {
        const cause = new Error('accountId 必须是 32 位十六进制 Cloudflare Account ID')
        cause.status = 400
        throw cause
      }
      accountId = selectedAccountId.toLowerCase()
    }
    if (state && !state.managed) {
      const cause = new Error('当前连接的是已有 Worker；请先停用后再自动部署，或继续使用已有 Worker')
      cause.status = 409
      throw cause
    }
    running = true
    cancelRequested = false
    error = null
    logs = []
    login = null
    phase = 'checking'
    try {
      pushLog('检查 Cloudflare 登录状态…')
      const who = await runWrangler(['whoami'], { timeoutMs: WHOAMI_TIMEOUT_MS })
      if (cancelRequested) return status()
      if (!isLoggedIn(who)) await loginFlow()
      else {
        accountId = accountId || parseAccountId(`${who.stdout}\n${who.stderr}`)
        phase = 'checking'
        login = null
      }
      if (cancelRequested) return status()
      await deployFlow()
    } catch (cause) {
      if (cancelRequested) {
        phase = 'idle'
        error = null
      } else {
        phase = 'error'
        setError(cause)
      }
    } finally {
      running = false
    }
    return status()
  }

  const cancel = () => {
    if (!running) return status()
    cancelRequested = true
    try { child?.kill('SIGTERM') } catch {}
    phase = 'idle'
    login = null
    pushLog('已取消')
    return status()
  }

  const adopt = async ({ url, writeSecret } = {}) => {
    ensureIdle('地址簿部署正在进行中')
    const normalized = normalizeWorkerUrl(url)
    const secret = normalizeSecret(writeSecret)
    if (!normalized) {
      const cause = new Error('Worker 地址必须是 https 源站，不能带路径、查询或账号信息')
      cause.status = 400
      throw cause
    }
    if (!secret) {
      const cause = new Error('写密钥不能为空，且不能包含空白字符')
      cause.status = 400
      throw cause
    }
    running = true
    cancelRequested = false
    error = null
    login = null
    phase = 'checking'
    logs = []
    try {
      pushLog('验证已有 Worker 和写密钥…')
      const response = await fetchImpl(`${normalized}/r/${crypto.randomBytes(32).toString('base64url')}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(ADOPT_TIMEOUT_MS),
      })
      if (response.status === 401 || response.status === 403) throw new Error('Worker 拒绝了写密钥（401/403）')
      if (response.status !== 204 && response.status !== 404) throw new Error(`Worker 返回了意外状态 HTTP ${response.status}`)
      const next = {
        version: 1,
        managed: false,
        url: normalized,
        writeSecret: secret,
        accountId: null,
        scriptName: null,
        deployedAt: now(),
        workerVersion: null,
        secretReady: true,
        active: true,
      }
      writeState(stateFile, next)
      state = next
      phase = 'ready'
      pushLog(`已连接到已有 Worker：${normalized}`)
      await onConfigured(config())
    } catch (cause) {
      phase = 'error'
      setError(cause)
      throw cause
    } finally {
      running = false
    }
    return status()
  }

  const remove = async ({ deleteWorker = false } = {}) => {
    ensureIdle('地址簿部署正在进行中')
    const previous = state
    // Managed + keep Worker: preserve name/URL/secret so re-enabling reuses the
    // same Worker. Manual Workers are not ours to manage, so disconnecting them
    // still clears local state (and lets the user switch to managed deployment).
    if (!deleteWorker && previous?.managed) {
      const next = { ...previous, active: false }
      writeState(stateFile, next)
      state = next
      phase = 'idle'
      login = null
      error = null
      logs = []
      pushLog('地址簿已停用；Worker 与本地写密钥已保留，可随时重新启用。')
      await onStopped()
      return status()
    }
    if (deleteWorker && previous?.managed && previous.scriptName) {
      phase = 'removing'
      pushLog(`删除 Worker：${previous.scriptName}`)
      const result = await runWrangler(['delete', '--name', previous.scriptName], { timeoutMs: DEPLOY_TIMEOUT_MS })
      if (result.code !== 0) {
        phase = state?.active ? 'ready' : 'idle'
        throw new Error(`删除 Worker 失败（退出码 ${result.code}）；本地配置未删除`)
      }
    } else if (deleteWorker && previous && !previous.managed) {
      pushLog('这是手动连接的 Worker；只断开本地配置，不删除 Cloudflare 上的 Worker。')
    }
    fs.rmSync(stateFile, { force: true })
    state = null
    phase = 'idle'
    login = null
    error = null
    logs = []
    await onStopped()
    return status()
  }

  const dispose = () => {
    disposed = true
    cancelRequested = true
    try { child?.kill('SIGTERM') } catch {}
  }

  return {
    config,
    summary,
    status,
    start,
    cancel,
    adopt,
    remove,
    dispose,
  }
}
