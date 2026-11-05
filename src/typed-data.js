import { findingsForActions, describeAction, verdictOf, nameFor, short, SEVERITY } from './analyze.js'

// Off-chain signatures are how most modern drainers work: no gas, no
// transaction in your history, and the wallet often shows a wall of hex.
// We recognise the common "spend permission" shapes and map them onto the
// same actions as on-chain approvals so the same rules apply.

const lc = (a) => (typeof a === 'string' ? a.toLowerCase() : a)
const big = (v) => { try { return BigInt(v) } catch { return 0n } }

function permit2Details (d, spender, kind, via) {
  return { type: 'token-approve', token: lc(d.token), spender: lc(spender), amount: big(d.amount), expiration: d.expiration, permit2: true, signature: kind, via }
}

/**
 * @param {{ domain?: object, types?: object, primaryType: string, message: object }} td
 * @returns {object[]} actions
 */
export function typedDataActions (td) {
  const { domain = {}, primaryType, message: m = {} } = td
  const verifying = lc(domain.verifyingContract)
  const name = String(domain.name ?? '')

  // EIP-2612 permit (USDC, DAI v2-style tokens, most modern ERC-20s)
  if (primaryType === 'Permit' && 'spender' in m && 'value' in m) {
    return [{ type: 'token-approve', token: verifying, owner: lc(m.owner), spender: lc(m.spender), amount: big(m.value), deadline: m.deadline, viaPermit: true, signature: 'EIP-2612 Permit' }]
  }
  // DAI's original permit: allowed=true means unlimited
  if (primaryType === 'Permit' && 'allowed' in m) {
    return [{ type: 'token-approve', token: verifying, owner: lc(m.holder), spender: lc(m.spender), amount: m.allowed ? 2n ** 256n - 1n : 0n, deadline: m.expiry, viaPermit: true, signature: 'DAI Permit' }]
  }
  // Uniswap Permit2 allowance signatures
  if (name === 'Permit2' && primaryType === 'PermitSingle') {
    return [permit2Details(m.details ?? {}, m.spender, 'Permit2 PermitSingle', verifying)]
  }
  if (name === 'Permit2' && primaryType === 'PermitBatch') {
    return (m.details ?? []).map((d) => permit2Details(d, m.spender, 'Permit2 PermitBatch', verifying))
  }
  // Permit2 signature transfers: the spender can pull tokens immediately
  if (name === 'Permit2' && /^Permit(Batch)?(Witness)?TransferFrom$/.test(primaryType)) {
    const permitted = Array.isArray(m.permitted) ? m.permitted : [m.permitted ?? {}]
    return permitted.map((p) => ({ type: 'token-approve', token: lc(p.token), spender: lc(m.spender), amount: big(p.amount), permit2: true, signature: `Permit2 ${primaryType}`, immediate: true }))
  }
  // Seaport (OpenSea) orders: what you offer vs what you get back
  if (/seaport/i.test(name) && primaryType === 'OrderComponents') {
    const offerer = lc(m.offerer)
    const offer = (m.offer ?? []).map((o) => ({ itemType: Number(o.itemType), token: lc(o.token), amount: big(o.endAmount ?? o.startAmount) }))
    const toOfferer = (m.consideration ?? []).filter((c) => lc(c.recipient) === offerer)
    const receive = toOfferer.map((c) => ({ itemType: Number(c.itemType), token: lc(c.token), amount: big(c.endAmount ?? c.startAmount) }))
    return [{ type: 'seaport-order', offerer, offer, receive, endTime: m.endTime }]
  }
  return [{ type: 'unknown-signature', primaryType, domainName: name, verifyingContract: verifying }]
}

/**
 * Analyze an eth_signTypedData_v4 request.
 * @param {object} td typed data
 * @param {import('./analyze.js').Context} ctx
 */
export async function analyzeTypedData (td, ctx = {}) {
  const actions = typedDataActions(td)
  const findings = await findingsForActions(actions.filter((a) => a.type === 'token-approve'), ctx)

  for (const a of actions) {
    if (a.type === 'token-approve') {
      findings.push(a.immediate
        ? { severity: 'danger', id: 'SIGNATURE_TRANSFER', title: 'Signature lets someone take tokens right now', detail: `Signing lets ${nameFor(a.spender, ctx)} pull these tokens immediately, with no further transaction from you. Only sign this inside a swap you started yourself.` }
        : { severity: 'warning', id: 'OFFCHAIN_APPROVAL', title: 'Gasless approval signature', detail: `This ${a.signature} costs no gas and won't appear as a transaction, but it grants spending rights just like an on-chain approval.` })
    }
    if (a.type === 'seaport-order') {
      const gives = a.offer.length
      const gets = a.receive.reduce((s, r) => s + r.amount, 0n)
      if (gives > 0 && gets === 0n) {
        findings.push({ severity: 'danger', id: 'ZERO_PRICE_LISTING', title: 'Listing your items for nothing', detail: `This marketplace order gives away ${gives} item(s) and pays you nothing. This is a common NFT-drainer trick.` })
      } else {
        findings.push({ severity: 'info', id: 'MARKETPLACE_ORDER', title: 'Marketplace order', detail: `You offer ${gives} item(s) and receive ${a.receive.length} payment item(s). Check the price carefully.` })
      }
    }
    if (a.type === 'unknown-signature') {
      findings.push({ severity: 'warning', id: 'UNKNOWN_SIGNATURE', title: 'Unrecognized signature request', detail: `"${a.primaryType}" from ${a.domainName || 'an unnamed app'} (${short(a.verifyingContract)}). Signatures can authorize transfers. Only sign if you understand what this is.` })
    }
  }

  const tdChain = td.domain?.chainId != null ? Number(td.domain.chainId) : null
  if (tdChain && ctx.chainId && tdChain !== Number(ctx.chainId)) {
    findings.push({ severity: 'danger', id: 'CHAIN_MISMATCH', title: 'Signature for a different network', detail: `The request is for chain ${tdChain} but your wallet is on ${ctx.chainId}.` })
  }

  findings.sort((x, y) => SEVERITY[y.severity] - SEVERITY[x.severity])
  const summary = actions.map((a) => {
    if (a.type === 'seaport-order') return `Sign a marketplace order offering ${a.offer.length} item(s)`
    if (a.type === 'unknown-signature') return `Sign "${a.primaryType}" for ${a.domainName || short(a.verifyingContract)}`
    return `${describeAction(a, ctx)} — by signature (${a.signature})`
  })
  return { kind: 'signature', actions, findings, verdict: verdictOf(findings), summary }
}
