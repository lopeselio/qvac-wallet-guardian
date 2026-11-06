// Build the hosted, rules-only demo into site/dist:
//   site/dist/guardian.js  the rule engine bundled for browsers
//   site/dist/index.html   ui/index.html with that bundle wired in
import { build } from 'esbuild'
import { readFile, writeFile, mkdir } from 'node:fs/promises'

const out = new URL('../site/dist/', import.meta.url)
await mkdir(out, { recursive: true })
await build({
  entryPoints: [new URL('../site/browser.js', import.meta.url).pathname],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  outfile: new URL('guardian.js', out).pathname,
  legalComments: 'none'
})
const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8')
const marker = '<script>\n\'use strict\''
if (!html.includes(marker)) throw new Error('ui/index.html: main script marker not found')
await writeFile(new URL('index.html', out), html.replace(marker, '<script src="guardian.js"></script>\n' + marker))
console.log('built site/dist')
