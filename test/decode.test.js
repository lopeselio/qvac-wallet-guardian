import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeFunctionData, maxUint256, parseAbi } from 'viem'
import { decodeActions, ABI } from '../src/decode.js'

const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const BOB = '0x1111111111111111111111111111111111111111'
const SPENDER = '0x2222222222222222222222222222222222222222'

const enc = (functionName, args, abi = ABI) => encodeFunctionData({ abi, functionName, args })

test('native transfer', () => {
  assert.deepEqual(decodeActions({ to: BOB, value: 10n ** 18n }), [{ type: 'native-transfer', to: BOB.toLowerCase(), amount: 10n ** 18n }])
})

test('ERC-20 transfer and approve', () => {
  assert.deepEqual(decodeActions({ to: USDT, data: enc('transfer', [BOB, 5_000_000n]) }), [
    { type: 'token-transfer', token: USDT.toLowerCase(), to: BOB.toLowerCase(), amount: 5_000_000n }
  ])
  const [a] = decodeActions({ to: USDT, data: enc('approve', [SPENDER, maxUint256]) })
  assert.equal(a.type, 'token-approve')
  assert.equal(a.amount, maxUint256)
})

test('Permit2 approve is distinguished from ERC-20 approve by selector', () => {
  const p2abi = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)'])
  const data = encodeFunctionData({ abi: p2abi, functionName: 'approve', args: [USDT, SPENDER, 2n ** 160n - 1n, 1_900_000_000] })
  const [a] = decodeActions({ to: '0x000000000022D473030F116dDEE9F6B43aC78BA3', data })
  assert.equal(a.permit2, true)
  assert.equal(a.token, USDT.toLowerCase())
  assert.equal(a.spender, SPENDER.toLowerCase())
})

test('setApprovalForAll and multicall flattening', () => {
  const inner = [enc('setApprovalForAll', [SPENDER, true]), enc('transfer', [BOB, 1n])]
  const mc = parseAbi(['function multicall(bytes[] data)'])
  const data = encodeFunctionData({ abi: mc, functionName: 'multicall', args: [inner] })
  const actions = decodeActions({ to: USDT, data })
  assert.deepEqual(actions.map((a) => a.type), ['nft-approve-all', 'token-transfer'])
  assert.ok(actions.every((a) => a.viaMulticall === USDT.toLowerCase()))
})

test('unknown selector becomes a contract-call, keeping attached value', () => {
  const actions = decodeActions({ to: SPENDER, data: '0xdeadbeef0000', value: 3n })
  assert.deepEqual(actions.map((a) => a.type), ['native-transfer', 'contract-call'])
  assert.equal(actions[1].selector, '0xdeadbeef')
})
