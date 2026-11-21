/*
 * 资产市场的本地回环冒烟:起两个静态服务(默认 127.0.0.1:61120 与 61121,与
 * .env.example 的两个内置来源联调地址同端口),各自摆一份合集布局——inner 侧用
 * indexed meta 与证书第一档,awesome 侧用 flat meta 与证书第二档(扁平布局),
 * 包目录带 L3 清单与 SHA-512 登记——然后走完整的目录取件与安装链路。
 *
 * 用法:node --import ./scripts/test/ts-hooks.mjs scripts/smoke-market.mjs
 * 只访问 127.0.0.1 回环地址,不访问任何外部主机;不安装依赖。
 */
import { createServer, get } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(ROOT, '..')

const PORT_INNER = Number(process.env.SMOKE_PORT_INNER ?? 61120)
const PORT_AWESOME = Number(process.env.SMOKE_PORT_AWESOME ?? 61121)

const sha512 = (text) => createHash('sha512').update(text, 'utf8').digest('hex')

/* ---------- 静态服务:各自一份 路径 -> 文本 的内存映射 ---------- */

const innerTable = new Map()
const awesomeTable = new Map()
const put = (table) => (key, value) => table.set(key, value)
const putInner = put(innerTable)
const putAwesome = put(awesomeTable)

const servers = []
const listen = (port, table) => new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const key = new URL(req.url, 'http://x').pathname.slice(1)
    const body = table.get(key)
    if (body === undefined) {
      // 三态里的 status 态:明确的 HTTP 状态码
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
  })
  server.on('error', reject)
  server.listen(port, '127.0.0.1', () => {
    servers.push(server)
    resolve(port)
  })
})
const closeAll = () => {
  for (const server of servers.splice(0)) server.close()
}

/* ---------- 合集布局:inner(indexed 形状,证书第一档) ---------- */

const AUTHOR = 'omds-chat'
const PKG = 'dsc-humanize-assistant'
const VERSION = '0.1.1'
const INNER_BASE = `http://127.0.0.1:${PORT_INNER}/`
const AWESOME_BASE = `http://127.0.0.1:${PORT_AWESOME}/`

const innerCert = await readFile(path.join(REPO, 'certs/dsc-humanize-inner-asset/dsc-humanize-inner-asset-eec.crt'), 'utf8')
const awesomeCert = await readFile(path.join(REPO, 'certs/awesome-dsc-humanize-asset/awesome-dsc-humanize-asset-eec.crt'), 'utf8')

const assetJson = JSON.stringify({
  formatVersion: '1.0.0',
  id: PKG,
  name: '冒烟测试包',
  version: VERSION,
  author: AUTHOR,
  license: 'Apache-2.0',
  types: ['persona', 'injection'],
})
const personaJson = JSON.stringify({ id: 'calm', name: 'Calm', prefix: '冒烟冒烟冒烟。' })
const injectionJson = JSON.stringify({ id: 'brief', name: 'Brief', text: 'Keep it brief.' })

const dir = `assets/${AUTHOR}/${PKG}/`

putInner('meta.json', JSON.stringify({ name: 'dsc-humanize-inner-asset', indexVersion: '1.0.0', assetFormat: { specVersion: '1.0.0', formatVersion: '1.0.0' } }))
putInner('certs/dsc-humanize-inner-asset/dsc-humanize-inner-asset-eec.crt', innerCert)
putInner('assets.json', JSON.stringify([{ id: PKG, author: AUTHOR, tag: ['daily'], types: ['persona', 'injection'] }]))
putInner(`${dir}manifest.json`, JSON.stringify({
  schemaVersion: 1,
  revision: 7,
  files: [
    { path: 'versions.json', sha512: sha512(JSON.stringify({ latest: VERSION, versions: [VERSION] })) },
    { path: `${VERSION}/asset.json`, sha512: sha512(assetJson) },
    { path: `${VERSION}/persona/calm.json`, sha512: sha512(personaJson) },
    { path: `${VERSION}/injection/brief.json`, sha512: sha512(injectionJson) },
  ],
}))
putInner(`${dir}versions.json`, JSON.stringify({ latest: VERSION, versions: [VERSION] }))
putInner(`${dir}${VERSION}/asset.json`, assetJson)
putInner(`${dir}${VERSION}/persona/calm.json`, personaJson)
putInner(`${dir}${VERSION}/injection/brief.json`, injectionJson)

/* ---------- 合集布局:awesome(flat 形状,证书第二档扁平布局) ---------- */

const AWESOME_PKG = 'dsc-awesome-demo'
const AWESOME_VERSION = '1.0.0'
const awesomeAsset = JSON.stringify({
  formatVersion: '1.0.0',
  id: AWESOME_PKG,
  name: 'Awesome Demo',
  version: AWESOME_VERSION,
  author: 'someone',
  license: 'MIT',
  types: ['persona'],
})
const awesomePersona = JSON.stringify({ id: 'spark', name: 'Spark', prefix: 'Be sparkly.' })
const awesomeDir = `assets/someone/${AWESOME_PKG}/`

putAwesome('meta.json', JSON.stringify({ assetSpecVersion: '1.0.0', assetFormatVersion: '1.0.0' }))
putAwesome('certs/awesome-dsc-humanize-asset-eec.crt', awesomeCert)
putAwesome('assets.json', JSON.stringify([{ id: AWESOME_PKG, author: 'someone', tag: [], types: ['persona'] }]))
putAwesome(`${awesomeDir}manifest.json`, JSON.stringify({
  schemaVersion: 1,
  revision: 1,
  files: [
    { path: `${AWESOME_VERSION}/asset.json`, sha512: sha512(awesomeAsset) },
    { path: `${AWESOME_VERSION}/persona/spark.json`, sha512: sha512(awesomePersona) },
  ],
}))
putAwesome(`${awesomeDir}versions.json`, JSON.stringify({ latest: AWESOME_VERSION, versions: [AWESOME_VERSION] }))
putAwesome(`${awesomeDir}${AWESOME_VERSION}/asset.json`, awesomeAsset)
putAwesome(`${awesomeDir}${AWESOME_VERSION}/persona/spark.json`, awesomePersona)

/* ---------- assets:read 的回环替身:node:http GET,三态原样 ---------- */

const loopbackAssets = {
  readText: (url) => new Promise((resolve, reject) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
      // 插件运行时的约束由宿主落实;冒烟替身只放行回环 http
      reject(new Error('assets:read rejected (protocol): smoke only allows loopback http'))
      return
    }
    const request = get(url, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve({ kind: 'status', url, status: res.statusCode })
          return
        }
        resolve({ kind: 'content', url, contentType: res.headers['content-type'] ?? '', text: Buffer.concat(chunks).toString('utf8') })
      })
    })
    request.on('error', () => {
      resolve({ kind: 'no-status', url })
    })
  }),
}

/* ---------- 跑链路 ---------- */

;(globalThis).__ROOT_CA_PEM__ = await readFile(path.join(REPO, 'certs/dsc-humanize/dsc-humanize-root-ca.crt'), 'utf8')
;(globalThis).__INNER_ASSET_PAGES_URL__ = INNER_BASE
;(globalThis).__AWESOME_ASSET_PAGES_URL__ = AWESOME_BASE

const portInner = await listen(PORT_INNER, innerTable).catch(() => null)
const portAwesome = await listen(PORT_AWESOME, awesomeTable).catch(() => null)
if (portInner === null || portAwesome === null) {
  console.error('冒烟端口被占用:' + PORT_INNER + ' / ' + PORT_AWESOME + ',可用 SMOKE_PORT_INNER / SMOKE_PORT_AWESOME 换端口')
  process.exit(1)
}

const { activate, deactivate, fetchMarketCatalog, installMarketPackage, getMarketTransport } = await import('../src/index.ts')

const storageMap = new Map()
const logs = []
const context = {
  id: 'dsc-humanize',
  version: '0.1.0',
  log: (message) => logs.push(message),
  sessions: { list: () => Promise.resolve([]), read: () => Promise.resolve(null), rename: () => false },
  events: { on: () => () => undefined },
  ui: { notify: () => undefined },
  settings: { locale: () => Promise.resolve('zh-CN'), register: () => () => undefined, values: () => ({}) },
  assets: loopbackAssets,
  net: { getText: () => Promise.resolve({ url: '', contentType: '', text: '' }), postJson: () => Promise.resolve({ url: '', status: 200 }) },
  storage: {
    get: (key) => storageMap.get(key) ?? null,
    set: (key, value) => storageMap.set(key, value),
    remove: (key) => storageMap.delete(key),
  },
  chat: { onBeforeRequest: () => () => undefined },
}

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '通过  ' : '失败  ') + label + (detail === undefined ? '' : ': ' + detail))
  if (!ok) failures += 1
}

await activate(context)
check('激活后通道已注入', getMarketTransport() !== null)

const innerCatalog = await fetchMarketCatalog('dsc-humanize-inner-asset')
check('inner 目录取件成功', innerCatalog.ok && innerCatalog.baseUrl === INNER_BASE)
if (innerCatalog.ok) {
  check('inner 形状为 indexed', innerCatalog.meta.shape === 'indexed')
  check('inner 来源结论已确认', innerCatalog.trust.source === 'confirmed', innerCatalog.trust.sourceReason ?? '')
  check('inner 目录列出 1 个包', innerCatalog.packages.length === 1 && innerCatalog.packages[0]?.id === PKG)
}

const awesomeCatalog = await fetchMarketCatalog('awesome-dsc-humanize-asset')
check('awesome 目录取件成功', awesomeCatalog.ok && awesomeCatalog.baseUrl === AWESOME_BASE)
if (awesomeCatalog.ok) {
  check('awesome 形状为 flat', awesomeCatalog.meta.shape === 'flat')
  check('awesome 来源结论已确认(证书第二档)', awesomeCatalog.trust.source === 'confirmed', awesomeCatalog.trust.sourceReason ?? '')
}

// 降级:目录里有地址但清单缺失的包,整包拒绝
const missing = await installMarketPackage('dsc-humanize-inner-asset', AUTHOR, 'dsc-missing-package')
check('不存在的包整包拒绝', !missing.ok && missing.error.code === 'manifest-missing', missing.ok ? '' : missing.error.code)

const installed = await installMarketPackage('dsc-humanize-inner-asset', AUTHOR, PKG, VERSION)
check('inner 包安装成功', installed.ok, installed.ok ? '' : JSON.stringify(installed.error))
if (installed.ok) {
  check('装配内容来自本次安装', installed.asset.contents.persona?.items[0]?.prefix === '冒烟冒烟冒烟。')
  check('安装记录写入存储', installed.recordPersisted && installed.record.collectionId === 'dsc-humanize-inner-asset' && installed.record.version === VERSION)
  check('两轴结论随安装重新计算', installed.trust.signature === 'unverified' && installed.trust.source === 'confirmed')
}

const record = storageMap.get('dsc-humanize/market/v1')
check('存储里的安装记录可读', Array.isArray(record?.installs) && record.installs.length === 1)

deactivate()
closeAll()
console.log(failures === 0 ? '冒烟通过:目录取件与安装全链路(127.0.0.1:' + portInner + ' 与 127.0.0.1:' + portAwesome + ')' : '冒烟存在失败项 ' + failures + ' 个')
process.exitCode = failures === 0 ? 0 : 1
