import { createPublicClient, encodeFunctionData, http, parseAbi } from 'viem'
import { analyzeTransaction } from './analyze.js'
import { analyzeTypedData } from './typed-data.js'

const ERC20 = parseAbi(['function transfer(address to, uint256 amount)', 'function approve(address spender, uint256 amount)'])

export class GuardianBlockedError extends Error {
  constructor (report) {
    super(`Wallet Guardian blocked this request: ${report.findings.filter((f) => f.severity === 'danger').map((f) => f.title).join('; ') || report.verdict}`)
    this.name = 'GuardianBlockedError'
    this.report = report
  }
}

/** EIP-712 primary type = the struct no other struct references (ethers' rule). */
export function inferPrimaryType (types) {
  const names = Object.keys(types).filter((t) => t !== 'EIP712Domain')
  const referenced = new Set()
  for (const t of names) {
    for (const field of types[t]) referenced.add(field.type.replace(/\[\d*\]$/, ''))
  }
  const roots = names.filter((n) => !referenced.has(n))
  if (roots.length !== 1) throw new Error(`Ambiguous EIP-712 primary type: ${roots.join(', ') || 'none'}`)
  return roots[0]
}

/** Context helper that answers "is this address a contract?" via JSON-RPC. */
export function rpcContext (rpcUrl) {
  const client = createPublicClient({ transport: http(rpcUrl) })
  return {
    isContract: async (address) => {
      const code = await client.getCode({ address })
      return Boolean(code && code !== '0x')
    }
  }
}

/**
 * Wrap a Tether WDK EVM account (WalletAccountEvm) so every transaction,
 * token transfer, approval and typed-data signature is analyzed first.
 *
 * @param {object} account WDK account (or anything with the same methods)
 * @param {object} opts
 * @param {import('./analyze.js').Context | (() => Promise<import('./analyze.js').Context>)} [opts.context]
 * @param {(report: object, request: { method: string, args: any[] }) => Promise<boolean>|boolean} [opts.review]
 *        Called for every request with a warning or danger verdict (or for all, with confirmAll).
 *        Return true to proceed. Without a review callback, danger is blocked and warnings pass.
 * @param {boolean} [opts.confirmAll] also call review for "ok" requests
 * @param {(report: object) => void} [opts.onReport]
 */
export function guard (account, { context = {}, review, confirmAll = false, onReport } = {}) {
  const ctxOf = async () => {
    const base = typeof context === 'function' ? await context() : context
    if (!base.from && account.getAddress) {
      try { return { ...base, from: (await account.getAddress()).toLowerCase() } } catch {}
    }
    return base
  }

  async function check (method, args, report) {
    onReport?.(report)
    const needsReview = confirmAll || report.verdict !== 'ok'
    if (!needsReview) return
    const ok = review ? await review(report, { method, args }) : report.verdict !== 'danger'
    if (!ok) throw new GuardianBlockedError(report)
  }

  const wrapped = {
    async sendTransaction (tx) {
      const ctx = await ctxOf()
      await check('sendTransaction', [tx], await analyzeTransaction(tx, ctx))
      return account.sendTransaction(tx)
    },
    async transfer (opts) {
      const ctx = await ctxOf()
      const data = encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [opts.recipient, BigInt(opts.amount)] })
      await check('transfer', [opts], await analyzeTransaction({ to: opts.token, data }, ctx))
      return account.transfer(opts)
    },
    async approve (opts) {
      const ctx = await ctxOf()
      const data = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [opts.spender, BigInt(opts.amount)] })
      await check('approve', [opts], await analyzeTransaction({ to: opts.token, data }, ctx))
      return account.approve(opts)
    },
    async signTypedData (td) {
      const ctx = await ctxOf()
      const primaryType = td.primaryType ?? inferPrimaryType(td.types)
      await check('signTypedData', [td], await analyzeTypedData({ ...td, primaryType }, ctx))
      return account.signTypedData(td)
    }
  }

  // Everything else (getAddress, getBalance, quote*, sign, dispose…) passes through.
  return new Proxy(account, {
    get (target, prop, receiver) {
      if (Object.hasOwn(wrapped, prop)) return wrapped[prop]
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
}
