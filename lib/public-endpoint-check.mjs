import dns from 'node:dns/promises'
import https from 'node:https'
import crypto from 'node:crypto'

const DOH_ENDPOINTS = [
  (hostname) => `https://dns.alidns.com/resolve?name=${encodeURIComponent(hostname)}&type=1`,
  (hostname) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
  (hostname) => `https://doh.pub/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
]

function withTimeout(promise, timeoutMs) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('DNS timeout'), { code: 'ETIMEDOUT' })), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

function defaultDohRequest(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'GET',
      headers: { accept: 'application/dns-json' },
      rejectUnauthorized: true,
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
        if (body.length > 64 * 1024) {
          response.destroy()
          reject(Object.assign(new Error('DoH response too large'), { code: 'DOH_RESPONSE' }))
        }
      })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(Object.assign(error, { code: 'DOH_RESPONSE' })) }
      })
      response.on('error', reject)
    })
    const timer = setTimeout(() => {
      request.destroy(Object.assign(new Error('DoH timeout'), { code: 'ETIMEDOUT' }))
    }, timeoutMs)
    request.on('response', () => clearTimeout(timer))
    request.on('error', (error) => { clearTimeout(timer); reject(error) })
    request.end()
  })
}

/**
 * Resolve a hostname through public DoH. The local resolver is the first place
 * GFW DNS poisoning shows up; the tunnel itself can still be reachable.
 */
export async function resolveViaDoh(hostname, { timeoutMs = 4000, request = defaultDohRequest } = {}) {
  let lastError = null
  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const data = await request(endpoint(hostname), timeoutMs)
      const answer = Array.isArray(data?.Answer)
        ? data.Answer.find((item) => item?.type === 1 && typeof item.data === 'string' &&
          /^(?:\d{1,3}\.){3}\d{1,3}$/.test(item.data))
        : null
      if (answer) return { address: answer.data, family: 4 }
      lastError = Object.assign(new Error('DoH returned no A record'), { code: 'ENODATA' })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? Object.assign(new Error('DoH lookup failed'), { code: 'ENOTFOUND' })
}

// No credentials, redirects or certificate exceptions. A 401 alone is ambiguous:
// require the gateway to echo our random probe nonce in its auth rejection.
export async function checkPublicEndpoint(endpoint, {
  timeoutMs = 8000,
  lookup = dns.lookup,
  dohLookup = resolveViaDoh,
  request = https.request,
} = {}) {
  const checkedAt = new Date().toISOString()
  const result = (state, message, extra = {}) => ({ state, message, checkedAt, ...extra })
  let url
  try {
    url = new URL(endpoint)
    if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash) throw new Error()
  } catch { return result('invalid-url', '公网入口必须是无凭证的 wss:// 地址。') }

  let resolved = null
  let dnsSource = 'system'
  try {
    resolved = await withTimeout(lookup(url.hostname), timeoutMs)
  } catch (error) {
    // Local DNS is commonly poisoned/blocked in China. DoH proves whether the
    // public record exists before we blame the tunnel or the Cloudflare config.
    if (!dohLookup) {
      return result('dns-error', ['ENOTFOUND', 'ENODATA'].includes(error.code)
        ? '本机无法解析公网域名，不代表公共 DNS 记录一定不存在。请核对域名、DNS 缓存、网络代理及 Cloudflare 已代理的 CNAME 记录；若刚保存配置，请稍后重试。'
        : 'DNS 查询失败或超时，请检查本机网络和 DNS 后重试。', { code: error.code || 'DNS_ERROR' })
    }
    try {
      resolved = await withTimeout(dohLookup(url.hostname), timeoutMs)
      dnsSource = 'doh'
    } catch (dohError) {
      return result('dns-error', '本机 DNS 查询失败，公共 DoH 也无法解析该域名；请核对域名、DNS 缓存、网络代理及 Cloudflare 已代理的 CNAME 记录。', {
        code: dohError.code || error.code || 'DNS_ERROR',
      })
    }
  }

  return new Promise((resolve) => {
    let done = false
    let deadline
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(deadline)
      resolve(value)
    }
    let req
    try {
      const key = crypto.randomBytes(16).toString('base64')
      const nonce = crypto.randomBytes(16).toString('hex')
      const address = resolved?.address || url.hostname
      req = request({ hostname: address, port: url.port || 443, path: url.pathname || '/', method: 'GET',
        servername: url.hostname, rejectUnauthorized: true,
        headers: { Host: url.hostname, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Protocol': 'dsh-mobile-v1', 'X-DSH-Gateway-Probe': nonce } })
      deadline = setTimeout(() => { finish(result('network-error', '公网 TLS/WebSocket 检测超时；请检查网络、代理和 Cloudflare 源站配置。', { code: 'ETIMEDOUT' })); req.destroy() }, timeoutMs)
      req.on('response', (res) => {
        const status = res.statusCode
        const reachableMessage = '本机检测：TLS 校验通过，移动网关路由已确认且要求鉴权；不代表手机网络可达或会话同步成功。'
        finish(status === 401 && res.headers['x-dsh-gateway-probe'] === nonce
          ? result('reachable', dnsSource === 'doh' ? `${reachableMessage}（本机 DNS 异常，已用公共 DoH 复核）` : reachableMessage, { httpStatus: status, dnsSource })
          : result('route-error', `公网返回 HTTP ${status}，未确认移动网关路由。命名 Tunnel 的 Service 应为 HTTP，指向本机专用源站端口；同时检查 Cloudflare Access/安全规则。`, { httpStatus: status }))
        res.destroy()
      })
      req.on('upgrade', (res, socket) => {
        finish(result('auth-warning', '公网 WebSocket 未提供凭证即被接受，请检查设备鉴权设置。', { httpStatus: res.statusCode }))
        socket.destroy()
      })
      req.on('error', (error) => {
        const tlsError = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code || '')
        finish(result(tlsError ? 'tls-error' : 'network-error', tlsError
          ? '公网 TLS 握手或证书校验失败；请检查域名证书、系统时间及网络代理，不要关闭证书校验。'
          : '公网连接失败；请检查 DNS、网络、代理及隧道源站配置。', { code: error.code || 'CONNECT_ERROR' }))
      })
      req.end()
    } catch { finish(result('network-error', '无法发起公网检测。')); req?.destroy() }
  })
}
