import { decodeFunctionData, parseAbi, toFunctionSelector } from 'viem'

// The calls that actually move or unlock user funds. Anything else is shown
// as an "unknown contract call", which is itself a finding.
export const ABI = parseAbi([
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  'function increaseAllowance(address spender, uint256 addedValue)',
  'function setApprovalForAll(address operator, bool approved)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
  'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
  'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  // Permit2's on-chain approve: (token, spender, uint160 amount, uint48 expiration)
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function multicall(bytes[] data)',
  'function multicall(uint256 deadline, bytes[] data)'
])

export const SELECTORS = Object.fromEntries(
  ABI.filter((x) => x.type === 'function').map((f) => [toFunctionSelector(f), `${f.name}(${f.inputs.map((i) => i.type).join(',')})`])
)

const lc = (a) => (typeof a === 'string' ? a.toLowerCase() : a)

/**
 * Decode calldata into one or more high-level actions.
 * @param {{ to: string, data?: string, value?: bigint }} tx
 * @param {number} depth
 * @returns {object[]} actions
 */
export function decodeActions (tx, depth = 0) {
  const to = lc(tx.to)
  const value = BigInt(tx.value ?? 0)
  const data = tx.data && tx.data !== '0x' ? tx.data : null
  const actions = []

  if (value > 0n) actions.push({ type: 'native-transfer', to, amount: value })
  if (!data) return actions

  let decoded
  try {
    decoded = decodeFunctionData({ abi: ABI, data })
  } catch {
    actions.push({ type: 'contract-call', contract: to, selector: data.slice(0, 10) })
    return actions
  }
  const { functionName: fn, args } = decoded
  const sig = SELECTORS[data.slice(0, 10)]

  switch (sig) {
    case 'transfer(address,uint256)':
      actions.push({ type: 'token-transfer', token: to, to: lc(args[0]), amount: args[1] })
      break
    case 'transferFrom(address,address,uint256)':
      actions.push({ type: 'token-transfer-from', token: to, from: lc(args[0]), to: lc(args[1]), amount: args[2] })
      break
    case 'approve(address,uint256)':
      actions.push({ type: 'token-approve', token: to, spender: lc(args[0]), amount: args[1] })
      break
    case 'increaseAllowance(address,uint256)':
      actions.push({ type: 'token-approve', token: to, spender: lc(args[0]), amount: args[1], increase: true })
      break
    case 'setApprovalForAll(address,bool)':
      actions.push({ type: 'nft-approve-all', collection: to, operator: lc(args[0]), approved: args[1] })
      break
    case 'safeTransferFrom(address,address,uint256)':
    case 'safeTransferFrom(address,address,uint256,bytes)':
      actions.push({ type: 'nft-transfer', collection: to, from: lc(args[0]), to: lc(args[1]), tokenId: args[2] })
      break
    case 'safeTransferFrom(address,address,uint256,uint256,bytes)':
      actions.push({ type: 'nft-transfer', collection: to, from: lc(args[0]), to: lc(args[1]), tokenId: args[2], amount: args[3] })
      break
    case 'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)':
      actions.push({ type: 'nft-transfer', collection: to, from: lc(args[0]), to: lc(args[1]), tokenIds: args[2], amounts: args[3] })
      break
    case 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)':
      actions.push({ type: 'token-approve', token: to, owner: lc(args[0]), spender: lc(args[1]), amount: args[2], deadline: args[3], viaPermit: true })
      break
    case 'approve(address,address,uint160,uint48)':
      actions.push({ type: 'token-approve', via: to, token: lc(args[0]), spender: lc(args[1]), amount: args[2], expiration: args[3], permit2: true })
      break
    case 'multicall(bytes[])':
    case 'multicall(uint256,bytes[])': {
      const calls = fn === 'multicall' && args.length === 2 ? args[1] : args[0]
      if (depth >= 3) {
        actions.push({ type: 'contract-call', contract: to, selector: data.slice(0, 10), note: 'nested multicall too deep' })
        break
      }
      for (const inner of calls) actions.push(...decodeActions({ to, data: inner }, depth + 1).map((a) => ({ ...a, viaMulticall: to })))
      break
    }
    default:
      actions.push({ type: 'contract-call', contract: to, selector: data.slice(0, 10) })
  }
  return actions
}
