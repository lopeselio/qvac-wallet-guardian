// Local web UI for Wallet Guardian.
//
// A tiny node:http server (no dependencies) that serves one static page and
// four JSON endpoints. QVAC runs in Node, so the browser never touches the
// model: it posts the raw request here and gets the report and a streamed
// explanation back.
//
// It only ever listens on 127.0.0.1, rejects foreign Host headers (DNS
// rebinding) and only accepts application/json POSTs (a cross-site form
// can't send that content type without a CORS preflight we never answer).

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { analyzeInput } from './input.js'
import { explainPlain, explainWithLlm, loadExplainer, verdictLine } from './explain.js'
import { describeFit, ModelTooLargeError } from './fit.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_BODY = 64 * 1024
export { analyzeInput }

const json = (_k, v) => (typeof v === 'bigint' ? v.toString() : v)

/**
 * @param {object} opts
 * @param {() => Promise<any>} [opts.loadSdk] returns @qvac/sdk; omit for rules-only mode
 * @param {string} [opts.model] QVAC model constant for explanations
 * @param {boolean} [opts.force] load even if the memory check says it won't fit
 * @param {object} [opts.context] analysis context (chainId, addressBook…)
 * @param {object[]} [opts.scenarios] demo scenarios shown in the picker
 * @param {(line: string) => void} [opts.log]
 */
export function createUiServer ({ loadSdk, model = 'QWEN3_1_7B_INST_Q4', force = false, context = { chainId: 1 }, scenarios = [], log = () => {} } = {}) {
  const llm = { status: loadSdk ? 'idle' : 'off', model, fit: [], progress: 0, error: null }
  let explainer = null
  let loading = null
  let queue = Promise.resolve() // one completion at a time on one model

  function startModel () {
    if (!loadSdk || loading) return loading
    llm.status = 'loading'
    loading = (async () => {
      try {
        const sdk = await loadSdk()
        const modelId = await loadExplainer(sdk, {
          model,
          force,
          onFit: (fit) => { llm.fit = describeFit(fit); log(`memory check: ${llm.fit.join('; ')}`) },
          onProgress: (p) => { llm.progress = Math.floor(p.percentage ?? 0) }
        })
        explainer = { sdk, modelId }
        llm.status = 'ready'
        log(`explanation model ready (${model})`)
      } catch (err) {
        llm.status = 'unavailable'
        llm.error = err instanceof ModelTooLargeError ? 'This device likely can\'t hold the model.' : err.message
        log(`explanation model unavailable: ${err.message}`)
      }
    })()
    return loading
  }

  async function page () {
    return readFile(join(ROOT, 'ui', 'index.html'))
  }

  function send (res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...(type.startsWith('text/html')
        ? { 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'" }
        : {})
    })
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, json))
  }

  async function readJson (req) {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      throw Object.assign(new Error('expected application/json'), { status: 415 })
    }
    let size = 0
    const chunks = []
    for await (const c of req) {
      size += c.length
      if (size > MAX_BODY) throw Object.assign(new Error('request too large'), { status: 413 })
      chunks.push(c)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }) }
  }

  async function explain (req, res) {
    const { input, lang } = await readJson(req)
    const report = await analyzeInput(input, context) // never trust a client-side report
    const language = typeof lang === 'string' && /^[\p{L} ()-]{2,30}$/u.test(lang) ? lang : 'English'
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    const emit = (ev) => res.write(JSON.stringify(ev) + '\n')

    if (llm.status !== 'ready') {
      // The page already lists the rule findings; nothing more to say without a model.
      emit({ type: 'done', source: 'rules', text: null, reason: llm.status })
      return res.end()
    }
    const job = queue.then(async () => {
      const text = await explainWithLlm({
        ...explainer,
        report,
        language,
        onText: (t) => emit({ type: 'delta', text: t }),
        onRetry: () => emit({ type: 'retry' })
      })
      if (text === explainPlain(report)) {
        // Every answer contradicted the verdict (or the model failed): show only the rules.
        emit({ type: 'done', source: 'rules', text: null, reason: 'rejected' })
      } else {
        // Strip our verdict line: the page renders the verdict itself.
        emit({ type: 'done', source: 'llm', text: text.slice(verdictLine(report.verdict).length).trim() })
      }
    })
    queue = job.catch(() => {})
    await job
    res.end()
  }

  const server = createServer(async (req, res) => {
    try {
      const { port } = server.address()
      const okHosts = [`127.0.0.1:${port}`, `localhost:${port}`]
      if (!okHosts.includes(req.headers.host)) return send(res, 421, { error: 'unexpected Host header' })

      const url = new URL(req.url, `http://127.0.0.1:${port}`)
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, await page(), 'text/html; charset=utf-8')
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { llm, addressBook: context.addressBook ?? [], chainId: context.chainId })
      if (req.method === 'GET' && url.pathname === '/api/scenarios') return send(res, 200, scenarios)
      if (req.method === 'POST' && url.pathname === '/api/analyze') {
        const { input } = await readJson(req)
        return send(res, 200, await analyzeInput(input, context))
      }
      if (req.method === 'POST' && url.pathname === '/api/explain') return await explain(req, res)
      return send(res, 404, { error: 'not found' })
    } catch (err) {
      if (res.headersSent) return res.end()
      return send(res, err.status ?? (err instanceof TypeError ? 400 : 500), { error: err.message })
    }
  })

  return {
    server,
    state: llm,
    startModel,
    /** Listen on 127.0.0.1 only. Resolves to the URL. */
    listen (port = 4321) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`))
      })
    },
    async close () {
      await new Promise((resolve) => server.close(resolve))
      if (explainer) await explainer.sdk.unloadModel({ modelId: explainer.modelId, clearStorage: false }).catch(() => {})
    }
  }
}
