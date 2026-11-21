/**
 * 市场目录层的测试:两种 meta 形状的兼容读取(设计 8.2)、证书三档与链校验(3.2)、
 * 两轴结论(3.4)与失败降级(6.1)。assets:read 用内存替身,不发真实请求;
 * 链校验用例用仓库 certs/ 里的公开证书做真实校验,做法与 trust-chain.test.ts 相同。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

/** 仓库根目录:测试文件在 scripts/test/ 下 */
const REPO_HREF = new URL('../../', import.meta.url).href

// 源码直接运行时没有构建注入的锚,先模拟构建行为,让链校验与产物同锚
const rootPem = await readFile(new URL('certs/dsc-humanize/dsc-humanize-root-ca.crt', REPO_HREF), 'utf8')
;(globalThis as { __ROOT_CA_PEM__?: string }).__ROOT_CA_PEM__ = rootPem

const { fetchCatalog, readCatalogMeta } = await import('../../src/market/catalog.ts')
const { createHostAssetTransport } = await import('../../src/market/transport.ts')
const { INNER_ASSET_COLLECTION_ID } = await import('../../src/market/sources.ts')

const [innerCert, awesomeCert] = await Promise.all([
  readFile(new URL('certs/dsc-humanize-inner-asset/dsc-humanize-inner-asset-eec.crt', REPO_HREF), 'utf8'),
  readFile(new URL('certs/awesome-dsc-humanize-asset/awesome-dsc-humanize-asset-eec.crt', REPO_HREF), 'utf8'),
])

type ReadResult = { kind: 'content'; url: string; contentType: string; text: string } | { kind: 'status'; url: string; status: number } | { kind: 'no-status'; url: string }

/** assets:read 的内存替身:Map 到文本;null 表示返回 no-status 态;数字表示返回该状态码;缺失按通道拒绝处理 */
const createTransport = (table: Map<string, string | number | null>) =>
  createHostAssetTransport({
    readText: (url: string) => {
      const entry = table.get(url)
      if (entry === undefined) return Promise.reject(new Error('assets:read rejected (url): ' + url))
      if (entry === null) return Promise.resolve({ kind: 'no-status', url } satisfies ReadResult)
      if (typeof entry === 'number') return Promise.resolve({ kind: 'status', url, status: entry } satisfies ReadResult)
      return Promise.resolve({ kind: 'content', url, contentType: 'application/json', text: entry } satisfies ReadResult)
    },
  })

const BASE = 'https://collection.test/inner/'

const indexedMeta = JSON.stringify({
  name: 'dsc-humanize-inner-asset',
  indexVersion: '1.0.0',
  assetFormat: { specVersion: '1.0.0', formatVersion: '1.0.0' },
})

const flatMeta = JSON.stringify({ assetSpecVersion: '1.0.0', assetFormatVersion: '1.0.0' })

const assetsIndex = JSON.stringify([
  { id: 'pkg-a', author: 'omds-chat', tag: ['daily'], types: ['persona'] },
  { id: 'pkg-b', author: 'omds-chat', tag: [], types: [] },
])

test('catalog: indexed 形状(inner 侧)与证书第一档,链校验通过', async () => {
  const transport = createTransport(new Map([
    [BASE + 'meta.json', indexedMeta],
    [BASE + 'certs/dsc-humanize-inner-asset/dsc-humanize-inner-asset-eec.crt', innerCert],
    [BASE + 'assets.json', assetsIndex],
  ]))
  const result = await fetchCatalog({ source: { id: INNER_ASSET_COLLECTION_ID, name: 'inner', baseUrls: [BASE], builtin: true, enabled: true }, transport })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.baseUrl, BASE)
  assert.equal(result.meta.shape, 'indexed')
  assert.equal(result.meta.formatVersion, '1.0.0')
  assert.equal(result.trust.signature, 'unverified')
  assert.equal(result.trust.source, 'confirmed')
  assert.equal(result.packages.length, 2)
  assert.equal(result.packages[0]?.id, 'pkg-a')
  assert.ok(result.notes.some((note) => note.includes('签名结论按未校验')))
})

test('catalog: flat 形状(awesome 侧)兼容读取', async () => {
  const transport = createTransport(new Map([
    [BASE + 'meta.json', flatMeta],
    [BASE + 'certs/awesome-dsc-humanize-asset/awesome-dsc-humanize-asset-eec.crt', awesomeCert],
    [BASE + 'assets.json', assetsIndex],
  ]))
  const result = await fetchCatalog({ source: { id: 'awesome-dsc-humanize-asset', name: 'awesome', baseUrls: [BASE], builtin: true, enabled: true }, transport })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.meta.shape, 'flat')
  assert.equal(result.meta.specVersion, '1.0.0')
  assert.equal(result.trust.source, 'confirmed')
})

test('catalog: 两种形状之外按 unknown 记录,目录照常取件', async () => {
  const transport = createTransport(new Map([
    [BASE + 'meta.json', JSON.stringify({ hello: 'world' })],
    [BASE + 'certs/dsc-humanize-inner-asset/dsc-humanize-inner-asset-eec.crt', innerCert],
    [BASE + 'assets.json', assetsIndex],
  ]))
  const result = await fetchCatalog({ source: { id: INNER_ASSET_COLLECTION_ID, name: 'inner', baseUrls: [BASE], builtin: true, enabled: true }, transport })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.meta.shape, 'unknown')
  assert.ok(result.notes.some((note) => note.includes('不在已知的两种之内')))
  assert.equal(result.packages.length, 2)
})

test('catalog: 拿不到证书时来源结论未通过(证书缺失),目录仍展示', async () => {
  const transport = createTransport(new Map([
    [BASE + 'meta.json', indexedMeta],
    [BASE + 'assets.json', assetsIndex],
  ]))
  const result = await fetchCatalog({ source: { id: INNER_ASSET_COLLECTION_ID, name: 'inner', baseUrls: [BASE], builtin: true, enabled: true }, transport })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.trust.source, 'rejected')
  assert.equal(result.trust.sourceReason, '证书缺失')
  assert.equal(result.trust.signature, 'unverified')
  assert.equal(result.packages.length, 2)
})

test('catalog: 证书是别家合集时链校验按主题不一致判未通过', async () => {
  const transport = createTransport(new Map([
    [BASE + 'meta.json', indexedMeta],
    [BASE + 'certs/dsc-humanize-inner-asset/dsc-humanize-inner-asset-eec.crt', awesomeCert],
    [BASE + 'assets.json', assetsIndex],
  ]))
  const result = await fetchCatalog({ source: { id: INNER_ASSET_COLLECTION_ID, name: 'inner', baseUrls: [BASE], builtin: true, enabled: true }, transport })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.trust.source, 'rejected')
  assert.ok((result.trust.sourceReason ?? '').includes('不一致'))
})

test('catalog: assets.json 不可读或结构不符时目录为空,来源结论不变', async () => {
  const unreachable = createTransport(new Map([
    [BASE + 'meta.json', indexedMeta],
    [BASE + 'certs/dsc-humanize-inner-asset/dsc-humanize-inner-asset-eec.crt', innerCert],
    [BASE + 'assets.json', 404],
  ]))
  const result1 = await fetchCatalog({ source: { id: INNER_ASSET_COLLECTION_ID, name: 'inner', baseUrls: [BASE], builtin: true, enabled: true }, transport: unreachable })
  assert.equal(result1.ok, true)
  if (result1.ok) {
    assert.equal(result1.packages.length, 0)
    assert.ok(result1.notes.some((note) => note.includes('资产索引不可读')))
    assert.equal(result1.trust.source, 'confirmed')
  }

  const malformed = createTransport(new Map([
    [BASE + 'meta.json', indexedMeta],
    [BASE + 'certs/dsc-humanize-inner-asset/dsc-humanize-inner-asset-eec.crt', innerCert],
    [BASE + 'assets.json', JSON.stringify([{ id: 'no-author' }])],
  ]))
  const result2 = await fetchCatalog({ source: { id: INNER_ASSET_COLLECTION_ID, name: 'inner', baseUrls: [BASE], builtin: true, enabled: true }, transport: malformed })
  assert.equal(result2.ok, true)
  if (result2.ok) {
    assert.equal(result2.packages.length, 0)
    assert.ok(result2.notes.some((note) => note.includes('资产索引不可读')))
  }
})

test('catalog: base_url 按顺序切换,信任材料与索引同址', async () => {
  const other = 'https://mirror.test/inner/'
  const transport = createTransport(new Map([
    [BASE + 'meta.json', 500],
    [other + 'meta.json', indexedMeta],
    [other + 'certs/dsc-humanize-inner-asset/dsc-humanize-inner-asset-eec.crt', innerCert],
    [other + 'assets.json', assetsIndex],
  ]))
  const result = await fetchCatalog({ source: { id: INNER_ASSET_COLLECTION_ID, name: 'inner', baseUrls: [BASE, other], builtin: true, enabled: true }, transport })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.baseUrl, other)
  assert.equal(result.trust.source, 'confirmed')
})

test('catalog: 全部地址不可达时来源失败,不影响其他来源的结构', async () => {
  const transport = createTransport(new Map())
  const result = await fetchCatalog({ source: { id: INNER_ASSET_COLLECTION_ID, name: 'inner', baseUrls: [BASE, 'https://backup.test/'], builtin: true, enabled: true }, transport })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'source-unreachable')
})

test('catalog: 通道缺失与来源关闭都是直接返回,不发请求', async () => {
  const missing = await fetchCatalog({ source: { id: INNER_ASSET_COLLECTION_ID, name: 'inner', baseUrls: [BASE], builtin: true, enabled: true }, transport: null })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.error.code, 'transport-missing')

  const disabled = await fetchCatalog({ source: { id: INNER_ASSET_COLLECTION_ID, name: 'inner', baseUrls: [BASE], builtin: true, enabled: false }, transport: createTransport(new Map()) })
  assert.equal(disabled.ok, false)
  if (!disabled.ok) assert.equal(disabled.error.code, 'source-disabled')
})

test('catalog: meta 形状读取是纯函数,非法输入记 unknown', () => {
  assert.equal(readCatalogMeta(null).shape, 'unknown')
  assert.equal(readCatalogMeta('text').shape, 'unknown')
  assert.equal(readCatalogMeta({ assetSpecVersion: '1.0.0' }).shape, 'unknown')
  const flat = readCatalogMeta({ assetSpecVersion: '1.1.0', assetFormatVersion: '1.1.0' })
  assert.equal(flat.shape, 'flat')
  assert.equal(flat.formatVersion, '1.1.0')
})
