import { test } from 'node:test'
import assert from 'node:assert/strict'
import { maxUint256 } from 'viem'
import { WalletAccountEvm } from '@tetherto/wdk-wallet-evm'
import { guard, GuardianBlockedError, inferPrimaryType } from '../src/guard.js'

const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const ALICE = '0xa11ce0000000000000000000000000000000beef'
const POISON = '0xa11ce9999999999999999999999999999990beef'
const DRAINER = '0x9999999999999999999999999999999999999999'
// Well-known public test mnemonic (Hardhat/Anvil). Never use for real funds.
const TEST_MNEMONIC = 'test test test test test test test test test test test junk'

function fakeAccount () {
  const calls = []
  return {
    calls,
    async getAddress () { return '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' },
    async sendTransaction (tx) { calls.push(['sendTransaction', tx]); return { hash: '0xabc', fee: 1n } },
    async transfer (o) { calls.push(['transfer', o]); return { hash: '0xdef', fee: 1n } },
    async approve (o) { calls.push(['approve', o]); return { hash: '0x123', fee: 1n } },
    async signTypedData (td) { calls.push(['signTypedData', td]); return '0xsig' },
    async getBalance () { return 42n }
  }
}

const ctx = { chainId: 1, addressBook: [{ name: 'Alice', address: ALICE }] }

test('safe transfer passes through to the account', async () => {
  const acct = fakeAccount()
  const g = guard(acct, { context: ctx })
  const r = await g.transfer({ token: USDT, recipient: ALICE, amount: 1_000_000n })
  assert.equal(r.hash, '0xdef')
  assert.equal(acct.calls.length, 1)
  assert.equal(await g.getBalance(), 42n) // untouched methods proxy through
})

test('poisoned transfer is blocked by default and never reaches the signer', async () => {
  const acct = fakeAccount()
  const reports = []
  const g = guard(acct, { context: ctx, onReport: (r) => reports.push(r) })
  await assert.rejects(g.transfer({ token: USDT, recipient: POISON, amount: 1_000_000n }), (err) => {
    assert.ok(err instanceof GuardianBlockedError)
    assert.equal(err.report.findings[0].id, 'ADDRESS_POISONING')
    return true
  })
  assert.equal(acct.calls.length, 0)
  assert.equal(reports[0].verdict, 'danger')
})

test('review callback decides; the signer address is filled into the context', async () => {
  const acct = fakeAccount()
  const seen = []
  const g = guard(acct, {
    context: ctx,
    review: async (report, req) => { seen.push([report.verdict, req.method]); return true }
  })
  await g.approve({ token: USDT, spender: DRAINER, amount: maxUint256 })
  assert.deepEqual(seen, [['danger', 'approve']])
  assert.equal(acct.calls[0][0], 'approve')
})

test('signTypedData without primaryType (WDK style) is analyzed', async () => {
  const acct = fakeAccount()
  const g = guard(acct, { context: ctx })
  const td = {
    domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
    types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    message: { owner: ALICE, spender: DRAINER, value: maxUint256.toString(), nonce: 0, deadline: 9999999999 }
  }
  await assert.rejects(g.signTypedData(td), GuardianBlockedError)
  assert.equal(acct.calls.length, 0)
})

test('inferPrimaryType picks the root struct', () => {
  assert.equal(inferPrimaryType({
    EIP712Domain: [],
    PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }],
    PermitDetails: [{ name: 'token', type: 'address' }]
  }), 'PermitSingle')
  assert.throws(() => inferPrimaryType({ A: [], B: [] }), /Ambiguous/)
})

test('works with a real Tether WDK WalletAccountEvm (no provider: blocked before signing)', async () => {
  const account = new WalletAccountEvm(TEST_MNEMONIC, {})
  const g = guard(account, { context: { chainId: 1, addressBook: [{ name: 'Alice', address: ALICE }] } })
  assert.equal((await g.getAddress()).toLowerCase(), '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')
  await assert.rejects(g.transfer({ token: USDT, recipient: POISON, amount: 1n }), GuardianBlockedError)
  // A clean request reaches WDK, which then complains about the missing provider.
  await assert.rejects(g.transfer({ token: USDT, recipient: ALICE, amount: 1n }), /provider/i)
  account.dispose?.()
})
