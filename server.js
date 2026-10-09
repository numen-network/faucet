import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { html } from 'hono/html'
import ipaddr from 'ipaddr.js'
import { ApiPromise, Keyring, WsProvider } from '@polkadot/api'
import { checkAddress, cryptoWaitReady, encodeAddress, evmToAddress, isEthereumAddress } from '@polkadot/util-crypto'

const HOUR = 60 * 60 * 1000
const ROWS = 25

export function readConfig(env) {
  const get = (name) => {
    if (!env[name]) throw new Error(`${name} is not set`)
    return env[name]
  }
  const whole = (name) => {
    if (!/^\d+$/.test(get(name))) throw new Error(`${name} must be a whole number`)
    return BigInt(get(name))
  }
  return {
    suri: get('FAUCET_SURI'),
    rpc: get('NUMEN_RPC'),
    port: Number(whole('PORT')),
    limitCoins: whole('IP_LIMIT_COIN'),
    windowHours: Number(whole('IP_WINDOW_HOURS')),
    explorer: get('EXPLORER_URL'),
  }
}

// an IPv6 subscriber gets a whole /64, so the /64 counts as one address
export function ipKey(ip) {
  const addr = ipaddr.process(ip)
  return addr.kind() === 'ipv6' ? `${ipaddr.IPv6.networkAddressFromCIDR(`${addr}/64`)}/64` : addr.toString()
}

// every address under a prefix opens with what the smallest and largest keys share
export function addressLead(ss58) {
  const low = encodeAddress(new Uint8Array(32), ss58)
  const high = encodeAddress(new Uint8Array(32).fill(255), ss58)
  let i = 0
  while (low[i] === high[i]) i++
  return low.slice(0, i)
}

// pallet-evm keeps an H160's balance on the account HashedAddressMapping derives from it
export function recipient(address, ss58) {
  if (isEthereumAddress(address)) return evmToAddress(address, ss58)
  return checkAddress(address, ss58)[0] ? address : null
}

// two decimals, cut and never rounded, with ≈ in front once the cut loses a nonzero digit
export function formatAmount(units, unit) {
  const step = unit / 100n
  const cents = units / step
  const frac = String(cents % 100n).padStart(2, '0').replace(/0+$/, '')
  return `${units % step ? '≈' : ''}${(cents / 100n).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`
}

function ago(at, now) {
  const s = Math.max(0, Math.floor((now - Date.parse(at)) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function loadSends(path) {
  if (!existsSync(path)) return []
  return JSON.parse(readFileSync(path, 'utf8')).map((send) => ({ ...send, amount: BigInt(send.amount) }))
}

function saveSends(path, sends) {
  writeFileSync(`${path}.tmp`, JSON.stringify(sends, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
  renameSync(`${path}.tmp`, path)
}

const ok = (text) => ({ tone: 'ok', text })
const bad = (text) => ({ tone: 'bad', text })

// caddy appends the peer it saw, so only the last x-forwarded-for entry can be trusted
const clientKey = (c) => ipKey(String(c.req.header('x-forwarded-for') ?? '').split(',').pop().trim())

export function createApp(chain, { limitCoins, windowHours, explorer, sendsPath }) {
  const unit = 10n ** BigInt(chain.decimals)
  const limit = limitCoins * unit
  const windowMs = windowHours * HOUR
  const lead = addressLead(chain.ss58)
  const coins = (units) => `${formatAmount(units, unit)} ${chain.symbol}`
  let sends = loadSends(sendsPath)
  let queue = Promise.resolve()

  function left(key) {
    const now = Date.now()
    const spent = sends.filter((send) => send.ip === key && now - Date.parse(send.at) < windowMs)
    return spent.reduce((sum, send) => sum - send.amount, limit)
  }

  // one claim at a time, so each sees every send before it and reads its nonce
  // after the previous send reached the pool
  function serial(job) {
    const run = queue.then(job)
    queue = run.catch(() => {})
    return run
  }

  async function claim(key, address, amountText) {
    const to = recipient(address, chain.ss58)
    if (!to) return bad(`Not a ${lead} or 0x address.`)
    const amount = /^\d+$/.test(amountText) ? BigInt(amountText) * unit : 0n
    if (!amount) return bad(`Enter a whole number of ${chain.symbol}.`)
    const available = left(key)
    if (amount > available) return bad(`Only ${coins(available)} left for this IP.`)
    if (amount > chain.live.balance) return bad('The faucet holds less than that.')
    const hash = await chain.send(to, amount)
    const now = Date.now()
    sends = [...sends, { at: new Date(now).toISOString(), ip: key, address, amount, hash }].filter(
      (send, i, all) => i >= all.length - ROWS || now - Date.parse(send.at) < windowMs,
    )
    saveSends(sendsPath, sends)
    console.log(`sent ${coins(amount)} to ${to} for ${key} in ${hash}`)
    return ok(html`Sent ${coins(amount)}. <a href="${explorer}/extrinsic/${hash}">View transaction</a>`)
  }

  const state = (key) => ({ chain, unit, lead, limit, windowHours, explorer, left: left(key), sends, now: Date.now() })

  const app = new Hono()
  app.get('/', (c) => {
    const key = clientKey(c)
    return c.html(page(state(key), { address: '', amount: String(left(key) / unit) }, null))
  })
  app.post('/', async (c) => {
    const key = clientKey(c)
    const body = await c.req.parseBody()
    const form = { address: String(body.address ?? '').trim(), amount: String(body.amount ?? '').trim() }
    const verdict = await serial(() => claim(key, form.address, form.amount)).catch((error) => {
      console.error(error)
      return bad(`Send failed. ${error.message}`)
    })
    const next = verdict.tone === 'ok' ? { address: form.address, amount: String(left(key) / unit) } : form
    return c.html(page(state(key), next, verdict))
  })
  return app
}

const MARK = html`<svg class="mark" viewBox="0 0 1024 1024" aria-hidden="true"><circle cx="510.5" cy="512" r="430.5" fill="none" stroke="currentColor" stroke-width="42"/><circle cx="510.5" cy="512" r="379.5" fill="none" stroke="currentColor" stroke-width="19"/><path fill="currentColor" d="M428 476L655 678L717.5 635L717.5 301L810 372L810 698L655 805L428 602Z"/><path fill="currentColor" d="M251.5 290L407 179L644 391L644 514L407 299L343 345L343 729L251.5 657Z"/></svg>`

const HEAD = html`<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;500;700&family=IBM+Plex+Mono:wght@400&display=swap" rel="stylesheet">
<style>
:root { --accent: #22d3ee; --bg: #121216; --page: #26262a; --ink: #eef1f7; --lead: #9aa3b5; --body: #8b93a7; --line: #33333b; --line2: #3d3d46; --mono: 'IBM Plex Mono', monospace; }
body { margin: 0; background: var(--page); color: var(--ink); font-family: 'Space Grotesk', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
a { color: var(--accent); }
main { position: relative; display: grid; grid-template-columns: 1fr 1fr; grid-template-areas: "balance form" "txs form"; grid-template-rows: auto 1fr; gap: 2.5rem 5rem; max-width: 76rem; margin: 0 auto; padding: 3.5rem 2rem; }
section { position: relative; min-width: 0; }
.mark { position: absolute; left: 0; top: 4rem; width: 34rem; color: var(--accent); opacity: .05; pointer-events: none; }
.balance { grid-area: balance; }
.form { grid-area: form; }
.txs { grid-area: txs; }
.caption { color: var(--lead); font-size: .95rem; margin: 0 0 .3rem; }
.big { font-size: clamp(2rem, 4vw, 2.9rem); font-weight: 300; letter-spacing: -.01em; line-height: 1.1; overflow-wrap: anywhere; }
.big small { font-size: .6em; color: var(--lead); }
.chain { display: flex; gap: 2rem; margin-top: .9rem; font-family: var(--mono); }
.chain span { display: block; }
.chain span, th { font-size: .68rem; font-weight: 400; letter-spacing: .12em; color: var(--body); }
.chain b { font-weight: 400; font-size: .9rem; color: var(--lead); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; font-family: var(--mono); font-size: .8rem; color: var(--body); white-space: nowrap; }
th { text-align: left; padding: 0 1.4rem .5rem 0; }
td { padding: .22rem 1.4rem .22rem 0; }
th.age, td.age { padding-right: .5rem; }
.num { text-align: right; }
.pipe { color: var(--line2); }
td a { color: var(--body); text-decoration: none; }
td a:hover { color: var(--accent); }
h1 { font-size: 1.6rem; font-weight: 500; margin: 0 0 1.4rem; }
.spec { display: flex; justify-content: space-between; gap: 1rem; padding: .7rem 0; border-top: 1px solid var(--line); font-size: .85rem; color: var(--body); }
.spec .val { font-family: var(--mono); font-size: .8rem; color: var(--ink); text-align: right; overflow-wrap: anywhere; }
.spec .copy { user-select: all; }
fieldset { margin: 1.4rem 0 0; padding: .1rem .9rem .7rem; background: var(--bg); border: 1px solid var(--accent); border-radius: 8px; box-shadow: 0 0 10px rgba(34, 211, 238, .25); }
fieldset:focus-within { box-shadow: 0 0 16px rgba(34, 211, 238, .5); }
legend { font-family: var(--mono); font-size: .7rem; color: var(--ink); padding: .1rem .5rem; background: var(--bg); border: 1px solid var(--accent); border-radius: 5px; }
input { width: 100%; box-sizing: border-box; padding: .35rem 0 0; background: transparent; border: 0; outline: 0; color: var(--ink); font-family: var(--mono); font-size: .95rem; }
button { margin-top: 1.6rem; padding: .85rem 1.9rem; background: var(--accent); color: var(--bg); border: 0; border-radius: 8px; font: 700 .95rem 'Space Grotesk', system-ui, sans-serif; cursor: pointer; }
button:hover { filter: brightness(1.12); }
.banner { margin: 1.2rem 0 0; padding: .75rem 1rem; border-radius: 8px; font-size: .9rem; overflow-wrap: anywhere; }
.banner.ok { background: rgba(34, 211, 238, .08); border: 1px solid rgba(34, 211, 238, .4); }
.banner.bad { background: rgba(248, 113, 113, .08); border: 1px solid rgba(248, 113, 113, .45); color: #fca5a5; }
@media (max-width: 1080px) {
  main { grid-template-columns: minmax(0, 1fr); grid-template-areas: "balance" "form" "txs"; grid-template-rows: none; }
  .form { max-width: 36rem; }
  .mark { width: 20rem; top: 1rem; left: auto; right: 0; }
}
@media (max-width: 600px) {
  main { padding: 2rem 1rem; }
}
</style>`

function page({ chain, unit, lead, limit, windowHours, explorer, left, sends, now }, form, verdict) {
  const amount = (units) => formatAmount(units, unit)
  const rows = sends
    .slice(-ROWS)
    .reverse()
    .map(
      (send) =>
        html`<tr><td class="num">${amount(send.amount)}</td><td class="num age">${ago(send.at, now)}</td><td><span class="pipe">|</span> ${send.at.slice(0, 19).replace('T', ' ')}</td><td><a href="${explorer}/extrinsic/${send.hash}">${send.hash.slice(0, 10)}…${send.hash.slice(-6)}</a></td></tr>`,
    )
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${chain.name} Faucet</title>
${HEAD}
</head>
<body>
<main>
${MARK}
<section class="balance">
<p class="caption">Faucet balance</p>
<div class="big">${amount(chain.live.balance)} <small>${chain.symbol}</small></div>
<div class="chain"><div><span>BLOCK</span><b>${chain.live.best.toLocaleString('en-US')}</b></div><div><span>FINALIZED</span><b>${chain.live.finalized.toLocaleString('en-US')}</b></div></div>
</section>
<section class="form">
<h1>${chain.name} Faucet</h1>
<div class="spec"><span>Limit</span><span class="val">${amount(limit)} ${chain.symbol} per IP per ${windowHours}h</span></div>
<div class="spec"><span>Available to your IP</span><span class="val">${amount(left)} ${chain.symbol}</span></div>
<div class="spec"><span>Return leftovers to</span><span class="val copy">${chain.address}</span></div>
<form method="post">
<fieldset><legend>Address (${lead} or 0x)</legend><input name="address" value="${form.address}" required autocomplete="off" spellcheck="false"></fieldset>
<fieldset><legend>Amount (${chain.symbol})</legend><input name="amount" value="${form.amount}" inputmode="numeric" required autocomplete="off"></fieldset>
<button>Get ${chain.symbol}</button>
</form>
${verdict && html`<p class="banner ${verdict.tone}">${verdict.text}</p>`}
</section>
<section class="txs">
<p class="caption">Faucet transactions</p>
<div class="scroll">
<table>
<thead><tr><th class="num">VALUE (${chain.symbol})</th><th class="num age">AGE</th><th><span class="pipe">|</span> DATE (UTC)</th><th>TX</th></tr></thead>
<tbody>
${rows.length ? rows : html`<tr><td colspan="4">No sends yet.</td></tr>`}
</tbody>
</table>
</div>
</section>
</main>
</body>
</html>
`
}

export async function connect(rpc, suri) {
  await cryptoWaitReady()
  const api = await ApiPromise.create({ provider: new WsProvider(rpc), noInitWarn: true })
  const [name, properties] = await Promise.all([api.rpc.system.chain(), api.rpc.system.properties()])
  const ss58 = properties.ss58Format.unwrap().toNumber()
  const pair = new Keyring({ type: 'sr25519', ss58Format: ss58 }).addFromUri(suri)
  const live = {}
  // resolves on the first value and keeps writing every later one into live
  const watch = (subscribe, key, read) =>
    new Promise((resolve) => {
      subscribe((value) => {
        live[key] = read(value)
        resolve()
      })
    })
  await Promise.all([
    watch((cb) => api.query.system.account(pair.address, cb), 'balance', ({ data }) => data.free.toBigInt()),
    watch((cb) => api.rpc.chain.subscribeNewHeads(cb), 'best', (head) => head.number.toNumber()),
    watch((cb) => api.rpc.chain.subscribeFinalizedHeads(cb), 'finalized', (head) => head.number.toNumber()),
  ])
  return {
    name: name.toString(),
    symbol: properties.tokenSymbol.unwrap()[0].toString(),
    decimals: properties.tokenDecimals.unwrap()[0].toNumber(),
    ss58,
    address: pair.address,
    live,
    // the runtime's nonce api cannot see the pool, accountNextIndex can
    async send(to, amount) {
      const nonce = await api.rpc.system.accountNextIndex(pair.address)
      const hash = await api.tx.balances.transferKeepAlive(to, amount).signAndSend(pair, { nonce })
      return hash.toHex()
    },
  }
}

const here = (name) => fileURLToPath(new URL(name, import.meta.url))
if (process.argv[1] === here('server.js')) {
  const config = readConfig(process.env)
  const chain = await connect(config.rpc, config.suri)
  const app = createApp(chain, { ...config, sendsPath: here('sends.json') })
  serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port }, (bound) => {
    console.log(`faucet ${chain.address} listening on ${bound.port}`)
  })
}
