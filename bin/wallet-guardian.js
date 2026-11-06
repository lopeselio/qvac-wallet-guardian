#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  analyzeTransaction, analyzeTypedData, explainPlain, explainWithLlm, loadExplainer, rpcContext, describeFit, ModelTooLargeError
} from '../src/index.js'

const HELP = `wallet-guardian — understand a transaction or signature before you sign it

Usage:
  wallet-guardian tx --to <addr> [--data 0x..] [--value <wei>] [options]
  wallet-guardian sign <typed-data.json> [options]
  wallet-guardian demo [scenario] [options]     run the bundled scam scenarios
  wallet-guardian ui [--port 4321] [--no-llm]   open the local web UI

Options:
  --chain <id>        chain your wallet is on (default 1)
  --from <addr>       your address
  --book <file.json>  address book: [{ "name": "Alice", "address": "0x…" }]
  --rpc <url>         JSON-RPC URL, used to check whether spenders are contracts
  --explain           write a plain-language explanation with a local QVAC LLM
  --model <const>     QVAC model for --explain (default QWEN3_1_7B_INST_Q4)
  --lang <language>   explanation language for --explain (default English)
  --json              print the raw report as JSON
  --force             load the explanation model even if the memory check says it won't fit
  --port <n>          port for \`ui\` (default 4321, always bound to 127.0.0.1)
  --no-llm            \`ui\` without a model: rules and findings only
  --no-open           \`ui\` without opening a browser

Exit code: 0 = ok, 1 = warning, 2 = danger.
Everything runs locally. Nothing about your transaction is sent anywhere (except --rpc lookups).
`

const replacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v)

async function buildContext (v, extra = {}) {
  const ctx = { chainId: Number(v.chain ?? extra.chainId ?? 1), ...extra }
  if (v.from) ctx.from = v.from.toLowerCase()
  if (v.book) ctx.addressBook = JSON.parse(await readFile(v.book, 'utf8'))
  if (v.rpc) Object.assign(ctx, rpcContext(v.rpc))
  return ctx
}

let explainer = null
async function render (report, v) {
  if (v.json) return console.log(JSON.stringify(report, replacer, 2))
  if (!v.explain) return console.log(explainPlain(report))
  if (!explainer) {
    const sdk = await import('@qvac/sdk').catch(() => {
      throw new Error('--explain needs @qvac/sdk: npm install @qvac/sdk')
    })
    process.stderr.write('▸ loading local explanation model…\n')
    let modelId
    try {
      modelId = await loadExplainer(sdk, {
        model: v.model,
        force: v.force,
        onFit: (fit) => { for (const l of describeFit(fit)) process.stderr.write(`▸ memory check: ${l}\n`) },
        onProgress: (p) => process.stderr.write(`\r▸ downloading ${Math.floor(p.percentage ?? 0)}%   `)
      })
    } catch (err) {
      if (!(err instanceof ModelTooLargeError)) throw err
      // The verdict never depends on the model, so degrade to the plain explanation.
      process.stderr.write(`⚠ ${err.message}\n▸ using the plain explanation instead\n`)
      v.explain = false
      return console.log(explainPlain(report))
    }
    process.stderr.write('\r\x1b[K')
    explainer = { sdk, modelId }
  }
  const text = await explainWithLlm({ ...explainer, report, language: v.lang })
  console.log(text)
  // The plain fallback already lists every action and finding.
  if (text === explainPlain(report)) return
  console.log('\nDetails:')
  for (const s of report.summary) console.log(`  • ${s}`)
  for (const f of report.findings) console.log(`  ${f.severity === 'danger' ? '⛔' : f.severity === 'warning' ? '⚠️ ' : 'ℹ️ '} ${f.title}`)
}

const LABELS = {
  'pay-alice': 'Pay Alice',
  'address-poisoning': 'Look-alike address',
  'unlimited-approval': 'Airdrop drainer',
  'permit2-approval': 'Uniswap Permit2',
  'nft-approve-all': 'NFT approve-all',
  'gasless-permit': 'Gasless permit'
}

async function startUi (v) {
  const { createUiServer, analyzeInput } = await import('../src/ui-server.js')
  const here = dirname(fileURLToPath(import.meta.url))
  const { context: demoCtx, scenarios } = JSON.parse(await readFile(join(here, '..', 'examples', 'scenarios.json'), 'utf8'))
  const context = await buildContext(v, demoCtx)
  const list = []
  for (const s of scenarios) {
    const report = await analyzeInput(s.tx ? { tx: s.tx } : { typedData: s.typedData }, context)
    list.push({ ...s, label: LABELS[s.name] ?? s.name, verdict: report.verdict })
  }
  const ui = createUiServer({
    loadSdk: v.llm ? () => import('@qvac/sdk') : undefined,
    model: v.model,
    force: v.force,
    context,
    scenarios: list,
    log: (l) => process.stderr.write(`▸ ${l}\n`)
  })
  const url = await ui.listen(Number(v.port ?? 4321))
  console.log(`Wallet Guardian UI: ${url}  (Ctrl+C to stop)`)
  if (v.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
    const { spawn } = await import('node:child_process')
    spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  }
  if (v.llm) {
    process.stderr.write('▸ loading local explanation model…\n')
    ui.startModel()
  }
  const stop = async () => { await ui.close(); process.exit(0) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

const exitCode = (verdict) => (verdict === 'danger' ? 2 : verdict === 'warning' ? 1 : 0)

async function main (argv) {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      to: { type: 'string' },
      data: { type: 'string' },
      value: { type: 'string' },
      chain: { type: 'string' },
      from: { type: 'string' },
      book: { type: 'string' },
      rpc: { type: 'string' },
      explain: { type: 'boolean' },
      model: { type: 'string' },
      lang: { type: 'string' },
      json: { type: 'boolean' },
      force: { type: 'boolean' },
      port: { type: 'string' },
      llm: { type: 'boolean', default: true },
      open: { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h' }
    }
  })
  const [cmd, arg] = positionals
  if (v.help || !cmd) return process.stdout.write(HELP)

  let worst = 'ok'
  const bump = (verdict) => { if (exitCode(verdict) > exitCode(worst)) worst = verdict }

  if (cmd === 'tx') {
    if (!v.to) throw new Error('usage: wallet-guardian tx --to <addr> [--data 0x..] [--value wei]')
    const report = await analyzeTransaction({ to: v.to, data: v.data, value: v.value ? BigInt(v.value) : 0n }, await buildContext(v))
    await render(report, v)
    bump(report.verdict)
  } else if (cmd === 'sign') {
    if (!arg) throw new Error('usage: wallet-guardian sign <typed-data.json>')
    const td = JSON.parse(await readFile(arg, 'utf8'))
    const report = await analyzeTypedData(td.primaryType ? td : { ...td, primaryType: (await import('../src/guard.js')).inferPrimaryType(td.types) }, await buildContext(v))
    await render(report, v)
    bump(report.verdict)
  } else if (cmd === 'demo') {
    const here = dirname(fileURLToPath(import.meta.url))
    const { context, scenarios } = JSON.parse(await readFile(join(here, '..', 'examples', 'scenarios.json'), 'utf8'))
    const list = arg ? scenarios.filter((s) => s.name === arg) : scenarios
    if (!list.length) throw new Error(`No scenario "${arg}". Options: ${scenarios.map((s) => s.name).join(', ')}`)
    for (const s of list) {
      console.log(`\n━━━ ${s.name}: ${s.note} ━━━`)
      const ctx = await buildContext(v, context)
      const report = s.tx
        ? await analyzeTransaction({ ...s.tx, value: s.tx.value ? BigInt(s.tx.value) : 0n }, ctx)
        : await analyzeTypedData(s.typedData, ctx)
      await render(report, v)
      bump(report.verdict)
    }
  } else if (cmd === 'ui') {
    return startUi(v)
  } else {
    throw new Error(`Unknown command "${cmd}". Run wallet-guardian --help.`)
  }

  if (explainer) await explainer.sdk.unloadModel({ modelId: explainer.modelId, clearStorage: false })
  process.exit(cmd === 'demo' ? 0 : exitCode(worst))
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`✖ ${err.message}`)
  process.exit(3)
})
