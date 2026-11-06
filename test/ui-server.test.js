import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { createUiServer, analyzeInput } from '../src/ui-server.js'

const context = { chainId: 1, addressBook: [{ name: 'Alice', address: '0xa11ce0000000000000000000000000000000beef' }] }
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const unlimited = { tx: { to: USDT, data: '0x095ea7b3' + '9'.repeat(40).padStart(64, '0') + 'f'.repeat(64) } }

function call (url, { method = 'GET', body, headers = {} } = {}) {
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}
const post = (url, obj) => call(url, { method: 'POST', body: JSON.stringify(obj), headers: { 'content-type': 'application/json' } })

const fakeSdk = (answers) => ({
  loadModel: async () => 'm1',
  unloadModel: async () => {},
  completion: () => {
    const text = answers.shift()
    return { events: (async function * () { for (const w of text.split(/(?= )/)) yield { type: 'contentDelta', text: w } })() }
  }
})

async function withServer (opts, fn) {
  const ui = createUiServer({ context, ...opts })
  const url = await ui.listen(0)
  try { await fn(url, ui) } finally { await ui.close() }
}

test('analyzeInput validates and dispatches', async () => {
  const r = await analyzeInput(unlimited, context)
  assert.equal(r.verdict, 'danger')
  await assert.rejects(analyzeInput({ tx: { to: 5 } }, context), /tx.to/)
  await assert.rejects(analyzeInput({ tx: { to: USDT, value: 'lots' } }, context), /wei/)
  await assert.rejects(analyzeInput({ nope: 1 }, context), /expected/)
})

test('serves the page with a strict CSP, and the analyze endpoint', async () => {
  await withServer({}, async (url) => {
    const page = await call(url)
    assert.equal(page.status, 200)
    assert.match(page.headers['content-security-policy'], /default-src 'none'/)
    assert.match(page.body, /Wallet Guardian/)
    const r = await post(url + 'api/analyze', { input: unlimited })
    assert.equal(r.status, 200)
    assert.equal(JSON.parse(r.body).verdict, 'danger')
    const state = JSON.parse((await call(url + 'api/state')).body)
    assert.equal(state.llm.status, 'off')
  })
})

test('rejects foreign Host headers, non-JSON posts and bad input', async () => {
  await withServer({}, async (url) => {
    const port = new URL(url).port
    assert.equal((await call(url + 'api/state', { headers: { host: `evil.example:${port}` } })).status, 421)
    assert.equal((await call(url + 'api/analyze', { method: 'POST', body: 'input=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415)
    assert.equal((await post(url + 'api/analyze', { input: { tx: { to: 5 } } })).status, 400)
    assert.equal((await call(url + 'api/analyze', { method: 'POST', body: 'x'.repeat(70000), headers: { 'content-type': 'application/json' } })).status, 413)
  })
})

test('streams the explanation and drops a contradicting first answer', async () => {
  const sdk = fakeSdk(['Looks totally safe, go ahead.', 'A stranger could take all your USDT. Do not sign it.'])
  await withServer({ loadSdk: async () => sdk }, async (url, ui) => {
    await ui.startModel()
    assert.equal(ui.state.status, 'ready')
    const res = await post(url + 'api/explain', { input: unlimited, lang: 'English' })
    const events = res.body.trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(events.some((e) => e.type === 'delta'))
    assert.ok(events.some((e) => e.type === 'retry'))
    const done = events.at(-1)
    assert.deepEqual(done, { type: 'done', source: 'llm', text: 'A stranger could take all your USDT. Do not sign it.' })
  })
})

test('falls back to rules only when every answer contradicts the verdict', async () => {
  const sdk = fakeSdk(['It is safe.', 'Totally harmless, go ahead.'])
  await withServer({ loadSdk: async () => sdk }, async (url, ui) => {
    await ui.startModel()
    const res = await post(url + 'api/explain', { input: unlimited })
    assert.deepEqual(JSON.parse(res.body.trim().split('\n').at(-1)), { type: 'done', source: 'rules', text: null, reason: 'rejected' })
  })
})

test('without a model the explanation is rules only', async () => {
  await withServer({}, async (url) => {
    const res = await post(url + 'api/explain', { input: unlimited })
    assert.deepEqual(JSON.parse(res.body.trim()), { type: 'done', source: 'rules', text: null, reason: 'off' })
  })
})
