import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto'
import { addressLead, createApp, formatAmount, readConfig } from './server.js'

const T0 = Date.parse('2026-10-09T12:00:00Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
mock.timers.enable({ apis: ['Date'], now: T0 })
mock.method(console, 'log', () => {})

const UNIT = 10n ** 18n
const ALICE = 'nu7SVAyQhPoGBJfFg7di66oYTV2KVBBeCw3Gt9qTRE2zpSUyb'
const ALICE_GENERIC = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY'
const H160 = '0x1234567890abcdef1234567890abcdef12345678'
const H160_MIRROR = 'nu2uaQWzSyDzXHrgd78sQL2871qL2LpPU6kHeeb4ETtXfnASg'
const BOB_KEY = '0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48'
const FAUCET = encodeAddress(BOB_KEY, 14240)
const EXPLORER = 'http://127.0.0.1:3000'
const IP = '203.0.113.9'

function fakeChain() {
  const sent = []
  return {
    name: 'Numen Development',
    symbol: 'tNUMN',
    decimals: 18,
    ss58: 14240,
    address: FAUCET,
    live: { balance: 49_999_999n * UNIT + 998_765_432_109_876_543n, best: 204_123, finalized: 204_121 },
    sent,
    async send(to, amount) {
      sent.push({ to, amount })
      return `0x${String(sent.length).padStart(64, '0')}`
    },
  }
}

const settings = (sendsPath, extra) => ({ limitCoins: 100_000n, windowHours: 24, explorer: EXPLORER, sendsPath, ...extra })

function fresh(chain = fakeChain(), extra = {}) {
  const sendsPath = join(mkdtempSync(join(tmpdir(), 'faucet-')), 'sends.json')
  return { chain, sendsPath, app: createApp(chain, settings(sendsPath, extra)) }
}

const visit = async (app, ip) => (await app.request('/', { headers: { 'x-forwarded-for': ip } })).text()

const claim = async (app, ip, address, amount) => {
  const body = new URLSearchParams({ address, amount })
  return (await app.request('/', { method: 'POST', body, headers: { 'x-forwarded-for': ip } })).text()
}

const tableAmounts = (page) => [...page.matchAll(/<tr><td class="num">([\d,.]+)<\/td>/g)].map((m) => m[1])

test('a nu address gets the amount it asks for', async () => {
  const { app, chain } = fresh()
  assert.match(await claim(app, IP, ALICE, '60000'), /Sent 60,000 tNUMN\./)
  assert.deepEqual(chain.sent, [{ to: ALICE, amount: 60_000n * UNIT }])
})

test('a 0x address funds the account pallet-evm maps it to', async () => {
  const { app, chain } = fresh()
  assert.match(await claim(app, IP, H160, '100000'), /Sent 100,000 tNUMN\./)
  assert.deepEqual(chain.sent, [{ to: H160_MIRROR, amount: 100_000n * UNIT }])
})

test('addresses outside nu and 0x are refused', async () => {
  const { app, chain } = fresh()
  const badChecksum = `${ALICE.slice(0, -1)}c`
  const badEvmChecksum = '0x1234567890ABCDEF1234567890abcdef12345678'
  const publicKey = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d'
  for (const address of [ALICE_GENERIC, badChecksum, badEvmChecksum, publicKey, 'hello', '']) {
    assert.match(await claim(app, IP, address, '1'), /Not a nu or 0x address\./, address)
  }
  assert.deepEqual(chain.sent, [])
})

test('only whole tNUMN amounts go out', async () => {
  const { app, chain } = fresh()
  for (const amount of ['1.5', '0', '', 'abc', '-5', '1e3', '100,000']) {
    assert.match(await claim(app, IP, ALICE, amount), /Enter a whole number of tNUMN\./, amount)
  }
  assert.deepEqual(chain.sent, [])
})

test('an IP draws at most 100,000 tNUMN across sends', async () => {
  const { app, chain } = fresh()
  assert.match(await claim(app, IP, ALICE, '60000'), /Sent 60,000 tNUMN\./)
  assert.match(await claim(app, IP, ALICE, '50000'), /Only 40,000 tNUMN left for this IP\./)
  assert.match(await claim(app, IP, H160, '40000'), /Sent 40,000 tNUMN\./)
  assert.match(await claim(app, IP, ALICE, '1'), /Only 0 tNUMN left for this IP\./)
  assert.match(await visit(app, IP), /Available to your IP<\/span><span class="val">0 tNUMN/)
  assert.equal(chain.sent.length, 2)
})

test('the allowance comes back 24 hours after a send', async (t) => {
  t.after(() => mock.timers.setTime(T0))
  const { app } = fresh()
  await claim(app, IP, ALICE, '100000')
  mock.timers.setTime(T0 + DAY - 1)
  assert.match(await claim(app, IP, ALICE, '1'), /Only 0 tNUMN left for this IP\./)
  mock.timers.setTime(T0 + DAY)
  assert.match(await claim(app, IP, ALICE, '100000'), /Sent 100,000 tNUMN\./)
})

test('a /64 counts as one IPv6 address', async () => {
  const { app } = fresh()
  assert.match(await claim(app, '2001:db8:1:2::1', ALICE, '100000'), /Sent/)
  assert.match(await claim(app, '2001:db8:1:2:ffff:ffff:ffff:ffff', ALICE, '1'), /Only 0 tNUMN left/)
  assert.match(await claim(app, '2001:db8:1:3::1', ALICE, '100000'), /Sent/)
})

test('an IPv4-mapped address shares the IPv4 allowance', async () => {
  const { app } = fresh()
  assert.match(await claim(app, `::ffff:${IP}`, ALICE, '100000'), /Sent/)
  assert.match(await claim(app, IP, ALICE, '1'), /Only 0 tNUMN left/)
})

test('only the last x-forwarded-for entry counts', async () => {
  const { app } = fresh()
  assert.match(await claim(app, `198.51.100.1, ${IP}`, ALICE, '100000'), /Sent/)
  assert.match(await claim(app, `198.51.100.2, ${IP}`, ALICE, '1'), /Only 0 tNUMN left/)
  assert.match(await claim(app, `${IP}, 198.51.100.3`, ALICE, '100000'), /Sent/)
})

test('a claim above the faucet balance is refused', async () => {
  const { app, chain } = fresh()
  chain.live.balance = 50_000n * UNIT
  assert.match(await claim(app, IP, ALICE, '50001'), /The faucet holds less than that\./)
  assert.deepEqual(chain.sent, [])
  assert.match(await claim(app, IP, ALICE, '50000'), /Sent 50,000 tNUMN\./)
})

test('a failed send leaves the allowance untouched', async () => {
  const { app, chain, sendsPath } = fresh()
  const send = chain.send
  chain.send = async () => {
    throw new Error('1010: Invalid Transaction: Inability to pay some fees')
  }
  const logged = mock.method(console, 'error', () => {})
  assert.match(await claim(app, IP, ALICE, '100000'), /Send failed\. 1010: Invalid Transaction: Inability to pay some fees/)
  logged.mock.restore()
  assert.equal(logged.mock.callCount(), 1)
  assert.equal(existsSync(sendsPath), false)
  chain.send = send
  assert.match(await claim(app, IP, ALICE, '100000'), /Sent 100,000 tNUMN\./)
})

test('claims from one IP run one after another', async () => {
  const { app, chain } = fresh()
  const send = chain.send
  chain.send = async (to, amount) => {
    await new Promise((resolve) => setImmediate(resolve))
    return send(to, amount)
  }
  const pages = await Promise.all([claim(app, IP, ALICE, '100000'), claim(app, IP, ALICE, '100000')])
  assert.equal(pages.filter((page) => /Sent 100,000 tNUMN\./.test(page)).length, 1)
  assert.equal(pages.filter((page) => /Only 0 tNUMN left/.test(page)).length, 1)
  assert.equal(chain.sent.length, 1)
})

test('sends survive a restart', async () => {
  const { app, chain, sendsPath } = fresh()
  await claim(app, IP, ALICE, '100000')
  const revived = createApp(chain, settings(sendsPath))
  assert.match(await claim(revived, IP, ALICE, '1'), /Only 0 tNUMN left/)
  assert.deepEqual(tableAmounts(await visit(revived, IP)), ['100,000'])
})

test('the table lists the latest 25 sends, newest first', async () => {
  const { app } = fresh()
  for (let i = 1; i <= 30; i++) await claim(app, `198.51.100.${i}`, ALICE, String(i))
  const amounts = tableAmounts(await visit(app, IP))
  assert.deepEqual(amounts, Array.from({ length: 25 }, (_, i) => String(30 - i)))
})

test('the file keeps a day of sends plus what the table shows', async (t) => {
  t.after(() => mock.timers.setTime(T0))
  const { app, sendsPath } = fresh()
  for (let i = 1; i <= 30; i++) await claim(app, `198.51.100.${i}`, ALICE, String(i))
  assert.equal(JSON.parse(readFileSync(sendsPath, 'utf8')).length, 30)
  mock.timers.setTime(T0 + DAY)
  await claim(app, IP, ALICE, '1')
  const kept = JSON.parse(readFileSync(sendsPath, 'utf8'))
  const units = (whole) => String(BigInt(whole) * UNIT)
  assert.deepEqual(kept.map((send) => send.amount), [...Array.from({ length: 24 }, (_, i) => units(i + 7)), units(1)])
})

test('the amount field offers what the IP has left', async () => {
  const { app } = fresh()
  assert.match(await visit(app, IP), /name="amount" value="100000"/)
  assert.match(await claim(app, IP, ALICE, '60000'), /name="amount" value="40000"/)
  assert.match(await claim(app, IP, ALICE, 'abc'), /name="amount" value="abc"/)
})

test('the page escapes what the visitor typed', async () => {
  const { app } = fresh()
  const page = await claim(app, IP, '"><script>alert(1)</script>', '1')
  assert.doesNotMatch(page, /<script>alert/)
  assert.match(page, /value="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/)
})

test('the page shows the faucet, its balance and the chain heads', async () => {
  const { app } = fresh()
  const page = await visit(app, IP)
  assert.match(page, />≈49,999,999\.99 <small>tNUMN/)
  assert.match(page, /<span>BLOCK<\/span><b>204,123<\/b>/)
  assert.match(page, /<span>FINALIZED<\/span><b>204,121<\/b>/)
  assert.match(page, new RegExp(`class="val copy">${FAUCET}<`))
  assert.match(page, /100,000 tNUMN per IP per 24h/)
  assert.match(page, /No sends yet\./)
})

test('amounts show two decimals, cut, with ≈ once the cut drops a digit', () => {
  assert.equal(formatAmount(100_000n * UNIT, UNIT), '100,000')
  assert.equal(formatAmount(49_999_999n * UNIT + 998_765_432_109_876_543n, UNIT), '≈49,999,999.99')
  assert.equal(formatAmount(UNIT / 10n, UNIT), '0.1')
  assert.equal(formatAmount((UNIT * 3n) / 2n, UNIT), '1.5')
  assert.equal(formatAmount(1n, UNIT), '≈0')
  assert.equal(formatAmount(0n, UNIT), '0')
})

test('the page follows the name, symbol, decimals and prefix of its chain', async () => {
  const coin = 10n ** 12n
  const other = { ...fakeChain(), name: 'Other Chain', symbol: 'XYZ', decimals: 12, ss58: 42, address: encodeAddress(BOB_KEY, 42) }
  other.live.balance = 5_000_000n * coin
  const { app } = fresh(other)
  const page = await visit(app, IP)
  assert.match(page, /<title>Other Chain Faucet<\/title>/)
  assert.match(page, /<h1>Other Chain Faucet<\/h1>/)
  assert.match(page, />5,000,000 <small>XYZ</)
  assert.match(page, /100,000 XYZ per IP per 24h/)
  assert.match(page, /Address \(5 or 0x\)/)
  assert.match(page, /<button>Get XYZ<\/button>/)
  assert.match(await claim(app, IP, ALICE, '1'), /Not a 5 or 0x address\./)
  assert.match(await claim(app, IP, ALICE_GENERIC, '1000'), /Sent 1,000 XYZ\./)
  await claim(app, '198.51.100.1', H160, '1')
  assert.deepEqual(other.sent, [
    { to: ALICE_GENERIC, amount: 1000n * coin },
    { to: encodeAddress(decodeAddress(H160_MIRROR), 42), amount: coin },
  ])
})

test('the limit and its window come from the settings', async (t) => {
  t.after(() => mock.timers.setTime(T0))
  const { app } = fresh(fakeChain(), { limitCoins: 5_000n, windowHours: 1 })
  assert.match(await visit(app, IP), /5,000 tNUMN per IP per 1h/)
  assert.match(await claim(app, IP, ALICE, '5000'), /Sent 5,000 tNUMN\./)
  assert.match(await claim(app, IP, ALICE, '1'), /Only 0 tNUMN left for this IP\./)
  mock.timers.setTime(T0 + HOUR)
  assert.match(await claim(app, IP, ALICE, '5000'), /Sent 5,000 tNUMN\./)
})

test('every setting in .env.example is required', () => {
  const example = parseEnv(readFileSync(new URL('./.env.example', import.meta.url), 'utf8'))
  assert.deepEqual(readConfig(example), {
    suri: '//Alice',
    rpc: 'ws://127.0.0.1:9944',
    port: 8791,
    limitCoins: 100_000n,
    windowHours: 24,
    explorer: EXPLORER,
  })
  for (const name of Object.keys(example)) {
    const { [name]: _, ...rest } = example
    assert.throws(() => readConfig(rest), new RegExp(`${name} is not set`))
  }
  assert.throws(() => readConfig({ ...example, IP_LIMIT_COIN: '100k' }), /IP_LIMIT_COIN must be a whole number/)
})

test('the address hint is what every address under the prefix starts with', () => {
  assert.equal(addressLead(14240), 'nu')
  assert.equal(addressLead(42), '5')
  assert.equal(addressLead(71), 'd1')
})
