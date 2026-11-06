// Entry point for the hosted demo (GitHub Pages). Bundles the same rule
// engine the CLI uses, so analysis runs in the visitor's browser. QVAC needs
// Node and local hardware, so the hosted page has no explanation model.

import { analyzeInput } from '../src/input.js'
import demo from '../examples/scenarios.json' with { type: 'json' }

const plain = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)))

async function boot () {
  const context = { chainId: 1, ...demo.context }
  const scenarios = []
  for (const s of demo.scenarios) {
    const report = await analyzeInput(s.tx ? { tx: s.tx } : { typedData: s.typedData }, context)
    scenarios.push({ ...s, verdict: report.verdict })
  }
  return {
    scenarios,
    addressBook: context.addressBook,
    analyze: async (input) => plain(await analyzeInput(input, context))
  }
}

window.WalletGuardianStatic = boot()
