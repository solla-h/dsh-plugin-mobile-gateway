#!/usr/bin/env node
// CLI for the optional address book. The management UI is the primary path;
// this exists for headless servers and manual testing.
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createRendezvousDeployer } from '../lib/rendezvous-deploy.mjs'

const DEFAULT_STATE = path.join(os.homedir(), '.dsh', 'mobile-gateway-devices.json.rendezvous.json')
const WORKER_DIR = fileURLToPath(new URL('../rendezvous-worker', import.meta.url))

function usage() {
  console.log(`Usage:
  dsh-mobile-gateway-rendezvous setup [--state-file <file>] [--account-id <id>]
  dsh-mobile-gateway-rendezvous status [--json] [--state-file <file>]
  dsh-mobile-gateway-rendezvous adopt --url <https://...workers.dev> --write-secret <secret> [--state-file <file>]
  dsh-mobile-gateway-rendezvous remove [--delete-worker] [--state-file <file>]

setup uses \`wrangler login --device\`; open the printed URL on any device and
enter the short code. The write secret stays in the 0600 state file and is
never printed.`)
}

function parseArgs(argv) {
  const values = { command: 'status', stateFile: DEFAULT_STATE, json: false, deleteWorker: false }
  const args = argv.slice()
  if (args[0] && !args[0].startsWith('-')) values.command = args.shift()
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--state-file') values.stateFile = args[++index] || ''
    else if (arg === '--account-id') values.accountId = args[++index] || ''
    else if (arg === '--url') values.url = args[++index] || ''
    else if (arg === '--write-secret') values.writeSecret = args[++index] || ''
    else if (arg === '--delete-worker') values.deleteWorker = true
    else if (arg === '--json') values.json = true
    else if (arg === '--help' || arg === '-h') values.command = 'help'
    else throw new Error(`unknown argument: ${arg}`)
  }
  return values
}

function printStatus(value) {
  const lines = [
    `phase:      ${value.phase}`,
    `configured: ${value.configured ? 'yes' : 'no'}`,
    `managed:    ${value.managed ? 'yes' : 'no'}`,
    `url:        ${value.url || '-'}`,
    `script:     ${value.scriptName || '-'}`,
    `account:    ${value.accountId || '-'}`,
    `error:      ${value.error || '-'}`,
  ]
  if (value.login?.url) {
    lines.push(`login URL:  ${value.login.url}`)
    lines.push(`login code: ${value.login.code || '(see the URL page)'}`)
  }
  console.log(lines.join('\n'))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === 'help') {
    usage()
    return
  }
  if (!options.stateFile) throw new Error('--state-file cannot be empty')
  const deployer = createRendezvousDeployer({
    stateFile: options.stateFile,
    workerDir: WORKER_DIR,
    log: (line) => console.error(line),
  })
  if (options.command === 'status') {
    const value = deployer.status()
    if (options.json) console.log(JSON.stringify(value, null, 2))
    else printStatus(value)
    return
  }
  if (options.command === 'setup') {
    let last = ''
    const timer = setInterval(() => {
      const value = deployer.status()
      if (value.login?.url && value.login.url !== last) {
        last = value.login.url
        console.error(`\nOpen on your phone: ${value.login.url}`)
        if (value.login.code) console.error(`Code: ${value.login.code}`)
      }
    }, 1_000)
    try {
      const value = await deployer.start({ accountId: options.accountId })
      printStatus(value)
      if (!value.configured) process.exitCode = 1
    } finally {
      clearInterval(timer)
    }
    return
  }
  if (options.command === 'adopt') {
    if (!options.url || !options.writeSecret) throw new Error('adopt requires --url and --write-secret')
    printStatus(await deployer.adopt({ url: options.url, writeSecret: options.writeSecret }))
    return
  }
  if (options.command === 'remove') {
    printStatus(await deployer.remove({ deleteWorker: options.deleteWorker }))
    return
  }
  throw new Error(`unknown command: ${options.command}`)
}

main().catch((error) => {
  console.error(`Error: ${error && error.message ? error.message : String(error)}`)
  process.exitCode = 1
})
