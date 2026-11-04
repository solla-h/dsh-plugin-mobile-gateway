# 地址簿对接（`rendezvous-v1`）

地址簿解决一个具体问题：Cloudflare Quick Tunnel 重启或局域网地址变化后，
已经配对过的手机如何**不再扫码**就找回网关。

网关把当前入口列表加密后写进**用户自己的** Cloudflare Worker；手机连续连接
失败时读回并解密，换成新地址重连。Worker 是零知识的：它只看到随机路径和
不透明密文。

- 协议：`hello.capabilities` 中的 `rendezvous-v1`（仅已认证设备、仅网关启用时）。
- 配置帧：手机发 `{type:'rendezvous-config', requestId}`，网关回
  `{kind:'rendezvous-config', requestId, url, key, gatewayId}`。
- Worker：随插件发布的 `rendezvous-worker/`（约 100 行 + 一个 SQLite Durable Object），面板可代为部署。

## 1. 信任模型

| 角色 | 持有的秘密 |
|---|---|
| 网关 | 每台设备一把 32 字节 `key`；Worker 写密钥（只用于 PUT/DELETE） |
| 手机 | 自己的 `key`（通过已认证连接领取） |
| Worker | 无。读过路径的人可读密文，但没有 `key` 解不开 |

- 配置走**已认证请求**，不放进二维码或 `paired` 帧：老设备不用重扫；二维码
  过期或截图泄漏也不会留下长期读取能力。
- `key` 与设备绑定；撤销设备时网关删除对应 Worker 记录。
- 为了读回旧记录，攻击者必须同时知道 43 字符路径和 `key`——两者都由 `key`
  派生，Worker 侧无法枚举。

## 2. 加密格式

```
key        32 random bytes, base64url no padding = 43 chars
pathKey    HKDF-SHA256(ikm=key, salt=empty, info=utf8("dsh-rendezvous-path-v1"), L=32)
path       base64url(pathKey)                                  // 43 chars
aesKey     HKDF-SHA256(ikm=key, salt=empty, info=utf8("dsh-rendezvous-blob-v1"), L=32)
nonce      12 fresh random bytes per publish (never reused)
AAD        utf8(path)
envelope   0x01 || nonce || AES-256-GCM ciphertext || tag(16)
body       base64url(envelope)                                 // <= 8192 chars
```

明文（发布时）：

```json
{"v":1,"rev":1762000000123,"gatewayId":"<uuid>","endpoints":["wss://...","ws://192.168.10.12:3081/ws/mobile"]}
```

- `rev = max(上次发布的 rev + 1, Date.now())`，只保存在网关内存里。
- `endpoints` 是网关 `advertisedEndpoints()` 的当前快照，1~16 项，每项 ≤2048 字符。
- 体积上限：`body ≤ 8192` ⇔ envelope ≤ 6144 字节 ⇔ 明文 ≤ 6115 字节。超限时
  网关从末尾逐项丢弃 endpoints，并在 `/mgw/status` 的 `rendezvous.lastError` 记录。

### 测试向量

```
key(hex)   = 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
nonce(hex) = 000102030405060708090a0b
pathKey    = 121566a9133a858e3167092a8362a0b0cb5a9b3417df72b6ac9741f1181f9d8f
path       = EhVmqRM6hY4xZwkqg2KgsMtamzQX33K2rJdB8RgfnY8
aesKey     = 2b614eec74828fcad0771ca475138a77163ec47d6cd4a5de0ff625ed48e32e7d
plaintext  = {"v":1,"rev":7,"ts":1762000000000,"gatewayId":"3f1b9c2e-7d4a-4b8f-9c1d-2e5a6b7c8d9f","name":"Test Gateway","endpoints":["wss://abc.trycloudflare.com/ws/mobile","ws://192.168.10.12:3081/ws/mobile"]}
tag(hex)   = 5216c00d8c4f51bc96b5ebdf6536933c
body(302)  = AQABAgMEBQYHCAkKC2o9ixs6CrlWNdCqYJujnipSZYB1j0sz5t82XX8Su-FrC8YpOXSsYbkM3N3BIpt2ZwvLEVXkIpzzvJ24ZQ5T2JZG2t4cRP9us4GHPDYsBOOtYbTmzqr7IXRB2LlrK06nw9AhZRfAxXldWIyzgLXGPvFW9siaH6kXprVGGwInS0hXLir8cFeF3KwcisSqb5u6eWz2OgMcOfJoK-g6vMXekd1Hc5vSloBXbyj9acQOIKZfietXgjZjt9q0ZkibAIitqDB_j_pBUhbADYxPUbyWtevfZTaTPA
```

客户端解密时应**忽略**明文里的 `ts` / `name` 等未知字段。

## 3. 手机端校验（按顺序，任何一步失败 = 没有数据，静默回退）

1. `body` 长度 ≤ 8192，且是规范 base64url（解码后再编码与原文完全一致）。
2. envelope ≥ `1+12+16+2` 字节，首字节 `0x01`。
3. 用本地派生的 `aesKey`、AAD = `utf8(本地派生的 path)` 解密。
4. `JSON.parse`；`v === 1`；`rev` 是正安全整数且 `rev ≤ 本机时间 + 7 天`；
   `gatewayId` 严格等于本地保存的 `rendezvous.gatewayId`；`endpoints` 是 1~16 个字符串。
5. 逐项过客户端已有的配对地址安全门（本 App 的 `isPairingUrlAllowed`）并去重；
   过滤后为空 = 失败。
6. `rev > seenRev`（`seenRev` 缺省视为 0）。

> **诚实边界**：`rev` 只提供「相对本机已见版本不回退」。第一次读取时拿到一份
> 真实但过期的旧记录仍会被接受；后果只是尝试一个失效地址，下一轮刷新自然
> 会被新记录取代。不要宣称它是防重放。

## 4. 采纳配置（防冒充）

手机每次 control 连接收到 `hello` 且 `authenticated` 后，如果能力里有
`rendezvous-v1`，发一次 `rendezvous-config`（一帧很便宜）。收到响应后：

| 本地状态 | 收到的配置 | 动作 |
|---|---|---|
| 无 | 合法 | 保存（`seenRev` 留空） |
| 有 | url/key/gatewayId 都相同 | 什么都不做 |
| 有 | url 相同、key 不同 | 更新 key，**清空 `seenRev`**（新 key 是新的 rev 作用域） |
| 有 | url 不同 | **拒绝覆盖**，只在菜单里显示一行灰字提示重新扫码 |
| 有 | `gatewayId` 与配对载荷里的不同 | 整帧丢弃，同上 |

`url` 相同而 `key` 不同是安全的：攻击者即使塞新 key，指向的仍是原来可信的
Worker，没有写密钥的人写不进那条新路径，手机只会读到 404。

重新配对会整体替换本地记录（包括清掉旧 `rendezvous`），这正是「换 Worker
必须重新配对」的实现机制。

## 5. 刷新时机（建议）

- 只在**连续第 2 次**连接失败后触发，且必须有网、距上次刷新 ≥60 秒、没有在途请求。
- 刷新与原有退避并行，不阻塞重连；拿到不同 URL 时立刻用它重连并把退避计数清零。
- 收到 4003/4004（设备被撤销/网关关闭）后停止重连，天然不会触发刷新。
- 每次 `await` 之后重新确认当前网关仍是发起刷新时的那一个；切换网关或重新配对后，
  迟到结果必须丢弃，不能写存储、不能重连。

## 6. Worker 接口

Worker 源码随插件发布在 `rendezvous-worker/`。用户可在“连接与配对 → 地址簿”中完成 Cloudflare 设备登录与托管部署，或用手动配置连接已有 Worker；独立仓库 `dsh-mobile-rendezvous` 仅作参考。摘要：

```
GET    /r/<43-char path>   无鉴权，路径即能力；200 密文 / 404
PUT    /r/<43-char path>   Authorization: Bearer <WRITE_SECRET>；204
DELETE /r/<43-char path>   同上；204，幂等
```

记录上限 64；body 必须匹配 `^[A-Za-z0-9_-]{16,8192}$`，流式读取超限 413；
所有响应带 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`。
Worker 不记录路径与 body。
