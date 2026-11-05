import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeTypedData } from '../src/typed-data.js'

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const ME = '0x5555555555555555555555555555555555555555'
const DRAINER = '0x9999999999999999999999999999999999999999'
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const ROUTER = '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad'
const ctx = { chainId: 1, from: ME }
const ids = (r) => r.findings.map((f) => f.id)

test('EIP-2612 unlimited permit to unknown spender is DANGER', async () => {
  const r = await analyzeTypedData({
    domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC },
    primaryType: 'Permit',
    message: { owner: ME, spender: DRAINER, value: (2n ** 256n - 1n).toString(), nonce: 0, deadline: 9999999999 }
  }, ctx)
  assert.equal(r.verdict, 'danger')
  assert.ok(ids(r).includes('UNLIMITED_APPROVAL_UNKNOWN'))
  assert.ok(ids(r).includes('OFFCHAIN_APPROVAL'))
  assert.match(r.summary[0], /UNLIMITED USDC.*by signature \(EIP-2612 Permit\)/)
})

test('Permit2 PermitSingle to Universal Router is a WARNING', async () => {
  const r = await analyzeTypedData({
    domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
    primaryType: 'PermitSingle',
    message: { details: { token: USDC, amount: '1000000', expiration: 1900000000, nonce: 0 }, spender: ROUTER, sigDeadline: 1900000000 }
  }, ctx)
  assert.equal(r.verdict, 'warning')
  assert.match(r.summary[0], /1 USDC/)
})

test('Permit2 signature transfer to unknown spender is DANGER', async () => {
  const r = await analyzeTypedData({
    domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
    primaryType: 'PermitBatchTransferFrom',
    message: { permitted: [{ token: USDC, amount: '50000000' }], spender: DRAINER, nonce: 1, deadline: 1900000000 }
  }, ctx)
  assert.equal(r.verdict, 'danger')
  assert.ok(ids(r).includes('SIGNATURE_TRANSFER'))
})

test('Seaport zero-price listing is DANGER', async () => {
  const r = await analyzeTypedData({
    domain: { name: 'Seaport', version: '1.6', chainId: 1, verifyingContract: '0x0000000000000068f116a894984e2db1123eb395' },
    primaryType: 'OrderComponents',
    message: {
      offerer: ME,
      offer: [{ itemType: 2, token: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', identifierOrCriteria: '1', startAmount: '1', endAmount: '1' }],
      consideration: [{ itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: '0', startAmount: '1', endAmount: '1', recipient: DRAINER }]
    }
  }, ctx)
  assert.equal(r.verdict, 'danger')
  assert.deepEqual(ids(r), ['ZERO_PRICE_LISTING'])
})

test('unknown typed data warns; wrong chain is DANGER', async () => {
  const r = await analyzeTypedData({ domain: { name: 'SomeGame', chainId: 137 }, primaryType: 'Login', message: { nonce: 1 } }, ctx)
  assert.deepEqual(ids(r).sort(), ['CHAIN_MISMATCH', 'UNKNOWN_SIGNATURE'])
  assert.equal(r.verdict, 'danger')
})
