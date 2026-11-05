import { formatUnits, isAddress, zeroAddress } from 'viem'
import { decodeActions } from './decode.js'
import { KNOWN_SPENDERS, NATIVE, TOKENS } from './registry.js'

// Deterministic rules decide the verdict. The LLM (see explain.js) only puts
// these facts into words. It never sees raw instructions it could follow,
// and it can't upgrade a "danger" to "ok".

export const SEVERITY = { danger: 3, warning: 2, info: 1 }
const UNLIMITED = 2n ** 255n // ≥ this is "unlimited" in practice (also catches uint160/uint256 max)
const UINT160_MAX = 2n ** 160n - 1n

const lc = (a) => (typeof a === 'string' ? a.toLowerCase() : a)

/**
 * @typedef {object} Context
 * @property {number} [chainId]                  the chain the wallet is on
 * @property {string} [from]                     the signer
 * @property {{ name: string, address: string }[]} [addressBook]
 * @property {string[]} [recentRecipients]
 * @property {Record<string,string>} [knownSpenders]  extra lowercase address → label
 * @property {Record<string,{symbol:string,decimals:number}>} [tokens] extra lowercase address → info
 * @property {(address: string) => Promise<boolean>} [isContract] optional chain lookup
 * @property {bigint} [largeNativeThreshold]     default 1 native unit
 */

export function tokenInfo (address, ctx = {}) {
  const a = lc(address)
  return ctx.tokens?.[a] ?? TOKENS[ctx.chainId ?? 1]?.[a] ?? null
}

export function spenderLabel (address, ctx = {}) {
  const a = lc(address)
  return ctx.knownSpenders?.[a] ?? KNOWN_SPENDERS[a] ?? null
}

export function fmtAmount (amount, token, ctx) {
  const info = token ? tokenInfo(token, ctx) : null
  if (amount >= UNLIMITED || amount === UINT160_MAX) return `UNLIMITED ${info?.symbol ?? 'tokens'}`
  if (!info) return `${amount} base units of ${short(token)}`
  return `${formatUnits(amount, info.decimals)} ${info.symbol}`
}

export function fmtNative (amount, ctx) {
  return `${formatUnits(amount, 18)} ${NATIVE[ctx.chainId ?? 1] ?? 'native'}`
}

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '?')

export function nameFor (address, ctx = {}, { full = false } = {}) {
  const a = lc(address)
  const book = ctx.addressBook?.find((e) => lc(e.address) === a)
  if (book) return `${book.name} (${short(a)})`
  const sp = spenderLabel(a, ctx)
  if (sp) return `${sp} (${short(a)})`
  const t = tokenInfo(a, ctx)
  if (t) return `${t.symbol} contract (${short(a)})`
  // Unknown recipients are shown in full: poisoning relies on shortened forms.
  return full ? a : short(a)
}

/**
 * Address poisoning: scammers send dust from an address that shares the
 * first and last characters with one you use, hoping you copy it from
 * history. Flag recipients that look like, but aren't, a known address.
 */
export function lookalike (address, ctx = {}) {
  const a = lc(address).slice(2)
  const known = [
    ...(ctx.addressBook ?? []).map((e) => ({ name: e.name, address: lc(e.address) })),
    ...(ctx.recentRecipients ?? []).map((r) => ({ name: 'a recent recipient', address: lc(r) }))
  ]
  for (const k of known) {
    const b = k.address.slice(2)
    if (a === b) return null
    const head = commonPrefix(a, b)
    const tail = commonPrefix([...a].reverse().join(''), [...b].reverse().join(''))
    if (head >= 3 && tail >= 3 && head + tail >= 7) return { ...k, head, tail }
  }
  return null
}

function commonPrefix (a, b) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

function isKnownRecipient (address, ctx) {
  const a = lc(address)
  return (ctx.addressBook ?? []).some((e) => lc(e.address) === a) || (ctx.recentRecipients ?? []).some((r) => lc(r) === a)
}

/**
 * Turn actions into findings.
 * @returns {Promise<object[]>}
 */
export async function findingsForActions (actions, ctx = {}) {
  const out = []
  const add = (severity, id, title, detail) => out.push({ severity, id, title, detail })

  for (const act of actions) {
    switch (act.type) {
      case 'native-transfer':
      case 'token-transfer':
      case 'token-transfer-from':
      case 'nft-transfer': {
        const to = act.to
        if (!to || !isAddress(to, { strict: false })) break
        if (lc(to) === zeroAddress) add('danger', 'BURN', 'Sending to the zero address', 'Anything sent to 0x000…000 is gone forever.')
        const look = lookalike(to, ctx)
        if (look) {
          add('danger', 'ADDRESS_POISONING',
            `Recipient only looks like ${look.name}`,
            // Full addresses on purpose: the shortened forms look identical, which is the whole trick.
            `Recipient ${lc(to)} shares its first ${look.head} and last ${look.tail} characters with ${look.name} ${look.address} but is a different address. This is the classic address-poisoning scam. Copy the address from your address book, not from transaction history.`)
        } else if (ctx.addressBook && !isKnownRecipient(to, ctx) && act.type !== 'token-transfer-from') {
          add('info', 'NEW_RECIPIENT', 'First time sending to this address', `${short(to)} is not in your address book or recent recipients. Double-check it with the person you're paying.`)
        }
        if (act.type === 'token-transfer' && tokenInfo(to, ctx)) {
          add('danger', 'SEND_TO_TOKEN_CONTRACT', 'Sending tokens to a token contract', `The recipient is the ${tokenInfo(to, ctx).symbol} contract itself. Tokens sent there are almost always lost.`)
        }
        if (act.type === 'token-transfer' && lc(act.token) === lc(to)) {
          add('danger', 'SEND_TO_SELF_CONTRACT', 'Sending tokens to their own contract', 'The recipient is the token contract. These tokens would be lost.')
        }
        if (act.type === 'native-transfer' && act.amount >= (ctx.largeNativeThreshold ?? 10n ** 18n)) {
          add('warning', 'LARGE_VALUE', 'Large transfer', `You are sending ${fmtNative(act.amount, ctx)}.`)
        }
        if (act.type === 'token-transfer-from' && ctx.from && lc(act.from) !== lc(ctx.from)) {
          add('warning', 'PULLS_FROM_OTHER', 'Moves tokens from another account', `This pulls tokens from ${short(act.from)}, not from you.`)
        }
        break
      }

      case 'token-approve': {
        const label = spenderLabel(act.spender, ctx)
        const unlimited = act.amount >= UNLIMITED || act.amount === UINT160_MAX
        const what = fmtAmount(act.amount, act.token, ctx)
        if (act.amount === 0n) {
          add('info', 'REVOKE', 'Revokes an approval', `Sets the allowance for ${nameFor(act.spender, ctx)} to zero. This is a safe, protective action.`)
          break
        }
        let eoa = false
        if (ctx.isContract) {
          try { eoa = !(await ctx.isContract(act.spender)) } catch {}
        }
        if (eoa) {
          add('danger', 'APPROVE_EOA', 'Approval to a personal wallet', `The spender ${short(act.spender)} is not a contract. Legitimate apps approve contracts. Approving a personal wallet is how drainers take tokens.`)
        }
        if (unlimited && !label) {
          add('danger', 'UNLIMITED_APPROVAL_UNKNOWN', `Unlimited approval to an unknown spender`, `${short(act.spender)} could take ALL your ${tokenInfo(act.token, ctx)?.symbol ?? 'tokens of this kind'}, now or at any time later, without asking again.`)
        } else if (unlimited) {
          add('warning', 'UNLIMITED_APPROVAL', `Unlimited approval to ${label}`, `${label} could move all your ${tokenInfo(act.token, ctx)?.symbol ?? 'tokens'} at any time. Prefer approving only the amount you need.`)
        } else if (!label) {
          add('warning', 'APPROVAL_UNKNOWN', 'Approval to an unknown spender', `Allows ${short(act.spender)} to spend up to ${what}.`)
        }
        if (act.permit2 && act.expiration && Number(act.expiration) > Date.now() / 1000 + 90 * 86400) {
          add('info', 'LONG_EXPIRY', 'Long-lived approval', `This Permit2 approval stays valid until ${new Date(Number(act.expiration) * 1000).toISOString().slice(0, 10)}.`)
        }
        break
      }

      case 'nft-approve-all':
        if (!act.approved) {
          add('info', 'REVOKE', 'Revokes collection access', `Removes ${nameFor(act.operator, ctx)}'s access to this collection.`)
        } else {
          add(spenderLabel(act.operator, ctx) ? 'warning' : 'danger', 'APPROVAL_FOR_ALL',
            'Gives access to every NFT in the collection',
            `${nameFor(act.operator, ctx)} could transfer every item you own in ${short(act.collection)}, including ones you buy later. Marketplace listings need this, but drainers ask for it too.`)
        }
        break

      case 'contract-call':
        add('warning', 'UNKNOWN_CALL', 'Unrecognized contract call', `Calls ${nameFor(act.contract, ctx)} with function ${act.selector}, which Wallet Guardian can't decode. Only continue if you trust this app.`)
        break
    }
  }
  return out
}

export function verdictOf (findings) {
  const max = Math.max(0, ...findings.map((f) => SEVERITY[f.severity] ?? 0))
  return max >= 3 ? 'danger' : max >= 2 ? 'warning' : 'ok'
}

/** Describe each action in a single plain sentence. */
export function describeAction (a, ctx = {}) {
  const sym = (t) => tokenInfo(t, ctx)?.symbol ?? short(t)
  const via = `${a.permit2 ? ' (via Permit2)' : ''}${a.viaPermit ? ' (via permit)' : ''}`
  switch (a.type) {
    case 'native-transfer': return `Send ${fmtNative(a.amount, ctx)} to ${nameFor(a.to, ctx, { full: true })}`
    case 'token-transfer': return `Send ${fmtAmount(a.amount, a.token, ctx)} to ${nameFor(a.to, ctx, { full: true })}`
    case 'token-transfer-from': return `Move ${fmtAmount(a.amount, a.token, ctx)} from ${nameFor(a.from, ctx, { full: true })} to ${nameFor(a.to, ctx, { full: true })}`
    case 'token-approve':
      return a.amount === 0n
        ? `Revoke ${nameFor(a.spender, ctx)}'s permission to spend your ${sym(a.token)}${via}`
        : `Allow ${nameFor(a.spender, ctx)} to spend ${a.amount >= UNLIMITED || a.amount === UINT160_MAX ? '' : 'up to '}${fmtAmount(a.amount, a.token, ctx)} from your wallet${via}`
    case 'nft-approve-all': return `${a.approved ? 'Give' : 'Remove'} ${nameFor(a.operator, ctx)} ${a.approved ? 'control of' : 'from'} all your NFTs in ${short(a.collection)}`
    case 'nft-transfer': return `Transfer NFT${a.tokenIds ? 's' : ` #${a.tokenId}`} from ${short(a.collection)} to ${nameFor(a.to, ctx, { full: true })}`
    case 'contract-call': return `Call function ${a.selector} on ${nameFor(a.contract, ctx)}`
    default: return a.type
  }
}

/**
 * Analyze an unsigned EVM transaction.
 * @param {{ to: string, data?: string, value?: bigint|string|number, chainId?: number }} tx
 * @param {Context} ctx
 */
export async function analyzeTransaction (tx, ctx = {}) {
  if (!tx?.to || !isAddress(tx.to, { strict: false })) {
    return { kind: 'transaction', actions: [], findings: [{ severity: 'danger', id: 'CONTRACT_CREATION', title: 'Deploys a contract or has no valid recipient', detail: 'This transaction has no valid "to" address.' }], verdict: 'danger', summary: [] }
  }
  const actions = decodeActions({ ...tx, value: BigInt(tx.value ?? 0) })
  const findings = await findingsForActions(actions, ctx)
  if (tx.chainId && ctx.chainId && Number(tx.chainId) !== Number(ctx.chainId)) {
    findings.push({ severity: 'danger', id: 'CHAIN_MISMATCH', title: 'Wrong network', detail: `The request targets chain ${tx.chainId} but your wallet is on ${ctx.chainId}.` })
  }
  findings.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity])
  return { kind: 'transaction', actions, findings, verdict: verdictOf(findings), summary: actions.map((a) => describeAction(a, ctx)) }
}
