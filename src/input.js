// Parse a request as pasted in the UI ({ tx } or { typedData }) and analyze it.
// No Node built-ins, so the hosted browser demo bundles this same code.

import { analyzeTransaction } from './analyze.js'
import { analyzeTypedData } from './typed-data.js'
import { inferPrimaryType } from './guard.js'

/** Turn a pasted/scenario request into a report. Throws on malformed input. */
export async function analyzeInput (input, context) {
  if (!input || typeof input !== 'object') throw new TypeError('expected a JSON object')
  if (input.tx) {
    const { to, data, value } = input.tx
    if (typeof to !== 'string') throw new TypeError('tx.to must be an address')
    if (data != null && typeof data !== 'string') throw new TypeError('tx.data must be a hex string')
    let v = 0n
    if (value != null && value !== '') {
      try { v = BigInt(value) } catch { throw new TypeError('tx.value must be an integer amount in wei') }
    }
    return analyzeTransaction({ to, data, value: v }, context)
  }
  if (input.typedData) {
    const td = input.typedData
    if (!td.types || !td.message) throw new TypeError('typedData needs types and message')
    return analyzeTypedData(td.primaryType ? td : { ...td, primaryType: inferPrimaryType(td.types) }, context)
  }
  throw new TypeError('expected { tx: {...} } or { typedData: {...} }')
}
