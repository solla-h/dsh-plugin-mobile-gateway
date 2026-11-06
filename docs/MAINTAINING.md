# Maintaining this fork

This repository is the maintained fork [`solla-h/dsh-plugin-mobile-gateway`](https://github.com/solla-h/dsh-plugin-mobile-gateway)
of upstream [`Clarklevis1995/dsh-plugin-mobile-gateway`](https://github.com/Clarklevis1995/dsh-plugin-mobile-gateway).
The npm package name `dsh-plugin-mobile-gateway`, the Cordis plugin id/name `mobile-gateway`, bin
names, bundle patch, protocol name, and on-disk state layout are intentionally unchanged so existing
hosts and phones keep working across the fork.

- Fork source: <https://github.com/solla-h/dsh-plugin-mobile-gateway>
- Upstream source: <https://github.com/Clarklevis1995/dsh-plugin-mobile-gateway>
- License: MIT. The upstream copyright in [`LICENSE`](../LICENSE) is preserved; fork changes are
  distributed under the same license.
- Canonical fork install (immutable tag, not npm):
  `dsh plugin --profile web add github:solla-h/dsh-plugin-mobile-gateway#v0.12.0-rdv.3`

## Distribution identity

The npm name `dsh-plugin-mobile-gateway` is published by the upstream project. Its `@latest` tag,
version ranges, and `init` command resolve the **upstream** release line, not this fork. The fork is
distributed only through exact GitHub tags in this repository. A new user who wants rendezvous
support must use the `github:solla-h/...#<tag>` command above.

Tags are immutable. Never move or replace a published tag, never publish a new gateway version as
part of routine maintenance, and never claim that an npm version is fork output. The current fork
version and tag are `0.12.0-rdv.3`, based on upstream `0.11.2`.

Documentation on `main` is authoritative. A README or guide packaged inside an immutable tag is a
historical snapshot; it may still contain upstream npm instructions such as `@latest` or `init`.
Never edit a tag to correct it. Correct the documentation on `main`, and correct the next tag when
one is created.

## Version and supported combinations

Three independent version axes must not be conflated:

- `dsh-mobile-v1`: the WebSocket subprotocol name.
- `hello.protocol: 3`: the mobile handshake version.
- DSH Session format `4`: the upstream persistent-log format.

The source declares DSH `0.2.1-rc.2` as its host-adapter baseline (`README`, `PROTOCOL.md`). The
only recorded app-verified combination, as of 2026-11-05, is in the companion app's
[`compatibility.json`](https://github.com/solla-h/dsh-mobile-app/blob/master/compatibility.json):
app `0.1.0` build `224d30c6` + gateway `0.12.0-rdv.3` + DSH `0.2.1-rc.5` + protocol `3`, Android
only. iOS and every other combination remain unverified.

Do not infer support from upstream commits or npm upstream versions. Upstream `main` has moved on to
DSH `0.2.2-rc.1` support; this fork has not merged it and does not support it. A commit merged into
this fork is an **integrated candidate**, not a supported combination, until a real host run, an app
journey, and an app `compatibility.json` entry exist. Do not add speculative rows here.

## Upstream relationship and review cadence

Review upstream at least once a week and before every release, security advisory, or DSH
compatibility change. The comparison is read-only: fetch, inspect, and decide. There is deliberately
no sync bot, automatic merge, issue creation, or external notification; the commands below are the
supported tooling.

```bash
git remote add upstream https://github.com/Clarklevis1995/dsh-plugin-mobile-gateway.git  # once
git remote set-url --push upstream no_push                                           # read-only upstream
git fetch upstream --tags
git log --oneline upstream/main..v0.12.0-rdv.3     # fork-only commits
git log --oneline v0.12.0-rdv.3..upstream/main     # upstream-only commits
git diff --stat v0.12.0-rdv.3...upstream/main
git rev-list --left-right --count upstream/main...v0.12.0-rdv.3
```

Review security fixes, DSH/protocol compatibility changes, packaging changes, and licence changes.
Record the reviewed upstream commit in the synchronization PR. Upstream npm releases are upstream
distribution, not fork tags.

Upstreamable fixes should be small and isolated. Send them upstream as focused pull requests; do not
mix fork-only features into them. Synchronize upstream into this fork **only through a pull request**
against fork `main`. Never merge or push directly to `main`, and never push to upstream.

## Change control

- All changes, including upstream synchronization, go through a pull request to fork `main`; CI must
  pass before merge.
- Preserve the package name, the Cordis plugin id/name `mobile-gateway`, bin names, `lib/index.mjs`
  entry, `cordis.patch.yml`, and existing protocol frames, fields, and capabilities. Protocol
  additions must be additive and capability-gated.
- Do not change the version, create a tag, or move a tag in a docs/test/CI change.
- Do not add credentials, production host access, automatic merges, issues, or notifications.
- Keep fork-only changes small and documented so they remain reviewable against upstream.

## Local validation

Node.js 22.13 or newer is required; CI uses Node 24. `npm` and `pnpm` 11.9.x must be on `PATH`
because the package test installs the tarball with both. The pnpm lockfile is authoritative; there
is no `package-lock.json`.

```bash
pnpm install --frozen-lockfile
npm test                 # source, protocol, fake-host integration tests
npm run test:package     # npm pack, then real npm and pnpm installs in temp projects
```

`npm test` includes `test/gateway-state.test.mjs`, which covers the `gatewayId`/`deploySalt`
identity invariants.

Run `npm run test:package` whenever `package.json`, `files`, `exports`, `bin`, dependencies,
install scripts, or packaged `lib` files change. The package test checks the real tarball contents,
that `werift` remains a regular pinned dependency, and that RTC stays disabled until opt-in.

The default suite uses fake hosts and local sockets; it is not real DSH integration. Tests named
`*-official.test.mjs` are not part of `npm test`; they fail fast unless `DSH_INSTALL_ROOT` points at
a real installed DSH. A passing default suite does not prove that a phone, voice, files, or a tunnel
work.

Real integration requires installing the exact tag into a DSH profile, fully restarting `dsh web`,
and walking the companion app journey: pairing, session list, send/reply, reconnect, then any
changed feature (voice, files, tunnel, rendezvous) and the exit path back to the list. Record the
observed result; do not describe a stub test as a device run.

CI is [`.github/workflows/ci.yml`](https://github.com/solla-h/dsh-plugin-mobile-gateway/blob/main/.github/workflows/ci.yml)
(the absolute GitHub URL is required because `.github` is excluded from the packed tarball): Ubuntu
24.04, Node 24, pnpm `11.9.0`, pinned `actions/checkout` and `actions/setup-node`, `npm test` and
`npm run test:package`. It needs no secrets and has read-only repository permission. A GitHub fork
must have Actions enabled in its Actions tab before these checks run.

Run the full suite on Linux or WSL; that is the reference environment. A native Windows checkout can
fail POSIX assertions (`0600` file modes, `python3`, shell fixtures) and invokes npm through
`npm.cmd`, which can change argument and exit behavior. Report such failures as environmental; do not
weaken the assertions to make a native Windows run green.

## Protocol 3 handshake limits

- `hello.protocol` is fixed at `3`. It is not a negotiation or downgrade mechanism. A client that
  cannot speak protocol 3 must refuse the connection; the gateway will not offer a lower version. Do
  not infer support from shared numeric values such as Session format `4`.
- New server behavior is advertised only through `hello.capabilities`. Clients must gate on the
  capability they need and ignore unknown capabilities. Do not rename or remove existing frames,
  fields, or capabilities.
- Authentication happens before `hello`; the `gatewayId` check does not replace TLS and address
  trust on the phone. Debug loopback connections may report `hello.authenticated: false`; never use
  that mode for public access.
- With `split-channels`, control and conversation connections each receive a `hello`; legacy
  clients without the capability keep the single-connection behavior. New clients must wait for the
  relevant hello before sending channel-specific requests.

## Identity, pairing, migration, and revert

The default state files are `~/.dsh/mobile-gateway-devices.json`, `<deviceFile>.gateway.json`,
`<deviceFile>.rendezvous.json`, and `<deviceFile>.cloudflare.json`. They contain device tokens,
tunnel credentials, or rendezvous secrets and are written with `0600` permissions. Never commit,
print, paste, or attach them.

`gatewayId` and the gateway mode live in `.gateway.json`. A malformed identity file fails startup
instead of silently generating a new identity; do not hand-edit it into a different `gatewayId`.
Pairing tokens are scoped to one gateway; a token from another gateway is not valid. A new
independent gateway must generate a new identity and pair again; do not copy another instance's
state or device registry.

Safe migration:

1. With the old instance still running, record `gatewayId`, mode, and endpoint from `GET /mgw/status`
   and back up the state files. Do not print tokens. Then stop the old instance.
2. Install the target immutable tag and fully restart `dsh web`.
3. Verify the same `gatewayId`, the same mode, and that the existing paired phone connects without
   re-pairing. Open a session, load history, send a message, and reconnect.
4. For changed features, verify voice, files, tunnel, or rendezvous explicitly. Quick Tunnel URLs
   may change; named Tunnel and Tailscale entries are stable.

Safe revert: install the previous immutable tag, fully restart, and repeat the same identity,
pairing, history, and send/reply checks. Restore a state backup only when it belongs to the same
version and identity; never copy state from another gateway. Tag moves are not a revert mechanism.

A full host restart means stopping and starting the `dsh web` OS process. Plugin code is loaded at
host startup; a phone reconnect, a mobile-route restart, or a plugin hot reload is not enough after
install, upgrade, or revert. Quick Tunnel users may also need a new QR code.

## Release checklist

1. Review upstream and record the reviewed commit, including security advisories.
2. Prepare the final candidate: update every version reference and install instruction in
   `package.json`, `README.md`, `README.en.md`, `README.zh-CN.md`, `docs/readme/README*.md`,
   `AGENTS.md`, and this guide. The localized READMEs are entry pages that defer to the canonical
   docs; do not repeat the tag there unless the duplication is intentional and searchable.
3. On the exact candidate commit, run `pnpm install --frozen-lockfile`, `npm test`, and
   `npm run test:package`.
4. Create an immutable candidate tag at that exact tested commit. Do not move or replace it.
5. Install the exact tag on a clean host, fully restart the `dsh web` OS process, and run the real
   host/app journey plus the migration and revert checks above.
6. Promote the app recommendation (`compatibility.json` and compatibility docs) only with recorded
   evidence from that exact tag. If a test requires a code or documentation change, return to
   step 2 and create a new tag; never reuse the failed candidate.

Do not publish to npm unless ownership and an explicit release decision exist.
