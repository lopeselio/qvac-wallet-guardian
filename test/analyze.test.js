import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeFunctionData, maxUint256 } from 'viem'
import { ABI } from '../src/decode.js'
import { analyzeTransaction, lookalike } from '../src/analyze.js'

const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const ALICE = '0xa11ce0000000000000000000000000000000beef'
const POISON = '0xa11ce9999999999999999999999999999990beef' // same head/tail as Alice
const DRAINER = '0x9999999999999999999999999999999999999999'
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const ctx = { chainId: 1, from: '0x5555555555555555555555555555555555555555', addressBook: [{ name: 'Alice', address: ALICE }] }
const enc = (functionName, args) => encodeFunctionData({ abi: ABI, functionName, args })
const ids = (r) => r.findings.map((f) => f.id)

test('plain USDT payment to a saved contact is OK and described in human units', async () => {
  const r = await analyzeTransaction({ to: USDT, data: enc('transfer', [ALICE, 25_500_000n]) }, ctx)
  assert.equal(r.verdict, 'ok')
  assert.deepEqual(r.summary, ['Send 25.5 USDT to Alice (0xa11c…beef)'])
})

test('address poisoning look-alike is DANGER', async () => {
  assert.ok(lookalike(POISON, ctx))
  const r = await analyzeTransaction({ to: USDT, data: enc('transfer', [POISON, 25_500_000n]) }, ctx)
  assert.equal(r.verdict, 'danger')
  assert.deepEqual(ids(r), ['ADDRESS_POISONING'])
  assert.match(r.findings[0].detail, /first 5 and last 5/)
  assert.ok(r.findings[0].detail.includes(POISON) && r.findings[0].detail.includes(ALICE), 'shows full addresses')
})

test('unlimited approval: unknown spender is DANGER, Permit2 is a WARNING', async () => {
  const bad = await analyzeTransaction({ to: USDT, data: enc('approve', [DRAINER, maxUint256]) }, ctx)
  assert.equal(bad.verdict, 'danger')
  assert.ok(ids(bad).includes('UNLIMITED_APPROVAL_UNKNOWN'))
  assert.match(bad.summary[0], /UNLIMITED USDT/)

  const p2 = await analyzeTransaction({ to: USDT, data: enc('approve', [PERMIT2, maxUint256]) }, ctx)
  assert.equal(p2.verdict, 'warning')
  assert.match(p2.findings[0].title, /Uniswap Permit2/)
})

test('approval to an EOA is DANGER when a chain lookup is available', async () => {
  const r = await analyzeTransaction({ to: USDT, data: enc('approve', [DRAINER, 1_000_000n]) }, { ...ctx, isContract: async () => false })
  assert.ok(ids(r).includes('APPROVE_EOA'))
  assert.equal(r.verdict, 'danger')
})

test('revoking (approve 0) is informational', async () => {
  const r = await analyzeTransaction({ to: USDT, data: enc('approve', [DRAINER, 0n]) }, ctx)
  assert.equal(r.verdict, 'ok')
  assert.deepEqual(ids(r), ['REVOKE'])
})

test('setApprovalForAll to unknown operator is DANGER', async () => {
  const r = await analyzeTransaction({ to: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', data: enc('setApprovalForAll', [DRAINER, true]) }, ctx)
  assert.equal(r.verdict, 'danger')
  assert.deepEqual(ids(r), ['APPROVAL_FOR_ALL'])
})

test('sending tokens to the token contract itself is DANGER', async () => {
  const r = await analyzeTransaction({ to: USDT, data: enc('transfer', [USDT, 1_000_000n]) }, { chainId: 1 })
  assert.ok(ids(r).includes('SEND_TO_TOKEN_CONTRACT'))
})

test('unknown call with value warns; wrong chain is DANGER; big ETH send warns', async () => {
  const r = await analyzeTransaction({ to: DRAINER, data: '0x12345678', value: 2n * 10n ** 18n, chainId: 137 }, ctx)
  assert.deepEqual(ids(r).sort(), ['CHAIN_MISMATCH', 'LARGE_VALUE', 'NEW_RECIPIENT', 'UNKNOWN_CALL'])
  assert.equal(r.verdict, 'danger')
  assert.equal(r.findings[0].severity, 'danger') // sorted most severe first
})

test('missing/invalid to is DANGER', async () => {
  assert.equal((await analyzeTransaction({ data: '0x6080' }, ctx)).verdict, 'danger')
})
