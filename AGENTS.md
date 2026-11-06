# AGENTS

Guidance for agents and contributors working in the maintained fork
`solla-h/dsh-plugin-mobile-gateway`. The canonical maintenance policy is
[`docs/MAINTAINING.md`](docs/MAINTAINING.md); read it before upstream synchronization, packaging,
release, migration, or protocol changes.

## What this repository is

- A maintained fork of `Clarklevis1995/dsh-plugin-mobile-gateway`. Upstream is not merged
  automatically and upstream `main` may support DSH versions this fork does not.
- The npm package name remains `dsh-plugin-mobile-gateway`; the Cordis plugin id/name is
  `mobile-gateway` (the bundle patch row id is `mobile-gateway`, and its `name` field identifies the
  package). The entry is `lib/index.mjs`, the DSH bundle patch is `cordis.patch.yml`, and bin names
  remain unchanged.
- Current version/tag: `0.12.0-rdv.3`, based on upstream `0.11.2`.
- Mobile protocol: `dsh-mobile-v1`, pairing version `2`, `hello.protocol: 3`.
- Source host baseline: DSH `0.2.1-rc.2`, Session format `4`. The only app-verified combination is
  recorded in `solla-h/dsh-mobile-app` `compatibility.json` (DSH `0.2.1-rc.5`, Android). Do not
  generalize it.
- Fork install is the immutable GitHub tag
  `github:solla-h/dsh-plugin-mobile-gateway#v0.12.0-rdv.3`. npm `@latest` is upstream, not this
  fork. Never publish to npm, move tags, or change the version as part of a routine change.

## Non-negotiable invariants

- Keep `hello.protocol` at `3`. New behavior is additive and advertised through
  `hello.capabilities`; never rename or remove existing frames, fields, or capabilities.
  `dsh-mobile-v1`, `hello.protocol`, and DSH Session format are independent version axes.
- Authenticate before `hello`. Never move identity checks before authentication, never expose
  pairing tokens, QR payloads, tunnel tokens, or rendezvous secrets in logs, tests, or reports.
- Keep `gatewayId` stable. A malformed gateway state file must fail startup; do not silently
  regenerate identity, and do not copy state or the device registry between independent gateways.
- Keep RTC disabled by default. `werift` stays a regular dependency pinned to `0.25.2`, not an
  optional dependency.
- The published tarball must keep `lib`, `bin`, `helper`, `docs`, `rendezvous-worker`,
  `cordis.patch.yml`, `PROTOCOL.md`, and `test/fixtures/transport-v1`.
- The app's session connection is legacy (no `X-DSH-Channel` header), so it may send both
  conversation and control frames. Do not add the channel header casually.
- Plugin management uses the control connection and correlates by `requestId`, not frame kind.
  Never auto-approve `pendingBuilds`.
- Preserve the MIT upstream copyright in `LICENSE` and upstream attribution in the READMEs.

## Workflow

- Node.js 22.13 or newer and pnpm 11.9.0. Install with `pnpm install --frozen-lockfile`; `pnpm-lock.yaml` is the
  authoritative lockfile (there is no `package-lock.json`).
- Run `npm test` for every code change.
- Run `npm run test:package` when changing `package.json`, `files`, `exports`, `bin`, dependencies,
  install scripts, or packaged `lib` files. It performs a real `npm pack` plus npm and pnpm installs
  in temporary projects.
- Full host validation requires installing the exact tag and fully restarting `dsh web`. A phone
  reconnect or gateway restart is not enough after a plugin change.
- Default tests use fake hosts. `test/*-official.test.mjs` need a real installed DSH, are not part
  of `npm test`, and fail fast unless `DSH_INSTALL_ROOT` points at that installation. Never report a
  stub test as a real-device or real-host run.
- CI is `.github/workflows/ci.yml` on Ubuntu 24.04 with Node 24 and pnpm `11.9.0`; keep its
  checkout/setup-node actions pinned by commit.
- Some tests assert POSIX modes (`0600`) or require `python3`; a Windows checkout can fail those for
  environmental reasons. Report that honestly instead of weakening Linux assertions.
- All changes, including upstream synchronization, go through a pull request to fork `main`. Never
  merge or push directly to `main`, never push to upstream, and do not commit or push unless asked.
- Do not add secrets, production access, automatic merges, issue creation, or external
  notifications. Prefer reusing existing modules and adding no dependency.

## Where to look

- [`docs/MAINTAINING.md`](docs/MAINTAINING.md): fork identity, upstream review cadence, migration
  and revert, release checklist, CI enablement.
- [`PROTOCOL.md`](PROTOCOL.md): mobile frames, capabilities, and app integration contracts.
- [`README.md`](README.md) / [`README.zh-CN.md`](README.zh-CN.md): install and user-facing behavior.
- `lib/index.mjs`: gateway entry, handshake, routes, and state wiring.
- `test/package-install.test.mjs`: packaging and install contract.
