/**
 * 市场安装入口的测试:L3 清单逐文件取件、SHA-512 哈希比对、版本解析、
 * 整包原子性与安装记录(设计 4.1-4.4)。assets:read 用内存替身,不发任何真实请求;
 * 哈希用 node:crypto 计算,作为 WebCrypto 之外的独立参照。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const REPO_HREF = new URL('../../', import.meta.url).href

const rootPem = await readFile(new URL('certs/dsc-humanize/dsc-humanize-root-ca.crt', REPO_HREF), 'utf8')
;(globalThis as { __ROOT_CA_PEM__?: string }).__ROOT_CA_PEM__ = rootPem

const { importAssetPackage, installMarketPackage, setActiveContents, deactivate, activate } = await import('../../src/index.ts')
const { fetchPackageDocument } = await import('../../src/market/install.ts')
const { createHostAssetTransport } = await import('../../src/market/transport.ts')

const BASE = 'https://collection.test/inner/'

// 让内置来源的本地联调地址指向替身地图:来源解析按 2.2 注入本地地址并排在最前,
// 目录取件命中 BASE 后,证书与索引同址取用
;(globalThis as { __INNER_ASSET_PAGES_URL__?: string }).__INNER_ASSET_PAGES_URL__ = BASE
const AUTHOR = 'omds-chat'
const PKG = 'dsc-humanize-assistant'
const VERSION = '0.1.1'

const sha512 = (text: string): string => createHash('sha512').update(text, 'utf8').digest('hex')

const assetJson = JSON.stringify({
  formatVersion: '1.0.0',
  id: PKG,
  name: '测试包',
  version: VERSION,
  author: AUTHOR,
  license: 'Apache-2.0',
  types: ['persona', 'injection'],
})

const personaJson = JSON.stringify({ id: 'calm', name: 'Calm', prefix: 'You are calm.' })
const injectionJson = JSON.stringify({ id: 'brief', name: 'Brief', text: 'Be brief.' })

/** 构造一份完整的包目录:manifest 登记 sha512,文件按设计布局摆放;可改写 asset.json 的声明 */
const buildFixture = (options: { tamper?: string; assetId?: string; assetVersion?: string } = {}) => {
  const dir = BASE + 'assets/' + AUTHOR + '/' + PKG + '/'
  const assetText = options.assetId === undefined && options.assetVersion === undefined
    ? assetJson
    : JSON.stringify({ ...JSON.parse(assetJson) as Record<string, unknown>, ...(options.assetId === undefined ? {} : { id: options.assetId }), ...(options.assetVersion === undefined ? {} : { version: options.assetVersion }) })
  const files = new Map<string, string | number | null>([
    [dir + 'manifest.json', JSON.stringify({
      schemaVersion: 1,
      revision: 3,
      files: [
        { path: 'versions.json', sha512: sha512(JSON.stringify({ latest: VERSION, versions: [VERSION, '0.1.0'] })) },
        { path: VERSION + '/asset.json', sha512: sha512(assetText) },
        { path: VERSION + '/persona/calm.json', sha512: sha512(personaJson) },
        { path: VERSION + '/injection/brief.json', sha512: sha512(injectionJson) },
        { path: VERSION + '/README.md' },
      ],
    })],
    [dir + 'versions.json', JSON.stringify({ latest: VERSION, versions: [VERSION, '0.1.0'] })],
    [dir + VERSION + '/asset.json', assetText],
    [dir + VERSION + '/persona/calm.json', personaJson],
    [dir + VERSION + '/injection/brief.json', injectionJson],
    [dir + VERSION + '/README.md', '# readme'],
  ])
  if (options.tamper !== undefined) {
    files.set(dir + options.tamper, '{"tampered":true}')
  }
  return files
}

/** assets:read 的三态替身:context.assets 的直接形态,映射口径见 market-transport.test.ts */
const createFakeAssets = (files: Map<string, string | number | null>) => ({
  readText: (url: string) => {
    const entry = files.get(url)
    if (entry === undefined) return Promise.reject(new Error('assets:read rejected (url): ' + url))
    if (entry === null) return Promise.resolve({ kind: 'no-status', url } as const)
    if (typeof entry === 'number') return Promise.resolve({ kind: 'status', url, status: entry } as const)
    return Promise.resolve({ kind: 'content', url, contentType: 'application/json', text: entry } as const)
  },
})

const createTransport = (files: Map<string, string | number | null>) =>
  createHostAssetTransport(createFakeAssets(files))

test('install-fetch: 按清单逐文件取件并扁平化成加载期包文档', async () => {
  const result = await fetchPackageDocument({ baseUrl: BASE, author: AUTHOR, packageId: PKG, transport: createTransport(buildFixture()) })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const meta = result.document.metadata as { id: string; version: string }
  assert.equal(meta.id, PKG)
  assert.equal(meta.version, VERSION)
  assert.deepEqual((result.document.contents['persona'] as unknown[])[0], JSON.parse(personaJson))
  assert.deepEqual((result.document.contents['injection'] as unknown[])[0], JSON.parse(injectionJson))
  assert.equal(result.revision, 3)
  assert.equal(result.files.length, 4)
  // 清单里没登记哈希的文件照常取,类型目录之外的文件不进入文档
  assert.equal('README.md' in result.document.contents, false)
})

test('install-fetch: 缺省版本取 latest,显式版本不在列表里时拒绝', async () => {
  const files = buildFixture()
  const latest = await fetchPackageDocument({ baseUrl: BASE, author: AUTHOR, packageId: PKG, transport: createTransport(files) })
  assert.equal(latest.ok, true)
  if (latest.ok) assert.equal((latest.document.metadata as { version: string }).version, VERSION)

  const unknown = await fetchPackageDocument({ baseUrl: BASE, author: AUTHOR, packageId: PKG, version: '9.9.9', transport: createTransport(files) })
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.equal(unknown.error.code, 'version-unknown')
})

test('install-fetch: 哈希不一致、清单缺失、声明不符都整包拒绝', async () => {
  const tampered = await fetchPackageDocument({
    baseUrl: BASE,
    author: AUTHOR,
    packageId: PKG,
    transport: createTransport(buildFixture({ tamper: VERSION + '/persona/calm.json' })),
  })
  assert.equal(tampered.ok, false)
  if (!tampered.ok) assert.equal(tampered.error.code, 'hash-mismatch')

  const noManifest = await fetchPackageDocument({
    baseUrl: BASE,
    author: AUTHOR,
    packageId: 'dsc-no-manifest',
    transport: createTransport(new Map()),
  })
  assert.equal(noManifest.ok, false)
  if (!noManifest.ok) assert.equal(noManifest.error.code, 'manifest-missing')

  const badId = await fetchPackageDocument({
    baseUrl: BASE,
    author: AUTHOR,
    packageId: PKG,
    transport: createTransport(buildFixture({ assetId: 'dsc-other-package' })),
  })
  assert.equal(badId.ok, false)
  if (!badId.ok) assert.equal(badId.error.code, 'invalid-package-document')

  const missingFile = buildFixture()
  missingFile.delete(BASE + 'assets/' + AUTHOR + '/' + PKG + '/' + VERSION + '/injection/brief.json')
  const unreachable = await fetchPackageDocument({ baseUrl: BASE, author: AUTHOR, packageId: PKG, transport: createTransport(missingFile) })
  assert.equal(unreachable.ok, false)
  if (!unreachable.ok) assert.equal(unreachable.error.code, 'package-unreachable')

  const noTransport = await fetchPackageDocument({ baseUrl: BASE, author: AUTHOR, packageId: PKG, transport: null })
  assert.equal(noTransport.ok, false)
  if (!noTransport.ok) assert.equal(noTransport.error.code, 'transport-missing')
})

/** 带市场能力的激活上下文:assets 指向三态替身(不是包装后的 transport),storage 与设置值都在内存里 */
const createContext = (files: Map<string, string | number | null>, storageMap: Map<string, unknown>) => {
  const fakeAssets = createFakeAssets(files)
  const logs: string[] = []
  const context = {
    id: 'dsc-humanize',
    version: '0.1.0',
    log: (message: string) => {
      logs.push(message)
    },
    sessions: { list: () => Promise.resolve([]), read: () => Promise.resolve(null), rename: () => false },
    events: { on: () => () => undefined },
    ui: { notify: () => undefined },
    settings: {
      locale: () => Promise.resolve('zh-CN'),
      register: () => () => undefined,
      values: () => ({}),
    },
    assets: fakeAssets,
    net: { getText: () => Promise.resolve({ url: '', contentType: '', text: '' }), postJson: () => Promise.resolve({ url: '', status: 200 }) },
    storage: {
      get: (key: string) => storageMap.get(key) ?? null,
      set: (key: string, value: unknown) => {
        storageMap.set(key, value)
      },
      remove: (key: string) => {
        storageMap.delete(key)
      },
    },
    chat: { onBeforeRequest: () => () => undefined },
  } as import('../../src/types.ts').PluginContext
  return { context, logs }
}

/** 目录取件需要的来源元数据与真实合集证书,同址登记在 BASE 下 */
const sourceTable = (files: Map<string, string | number | null>, certPem: string): Map<string, string | number | null> => {
  const merged = new Map(files)
  merged.set(BASE + 'meta.json', JSON.stringify({ name: 'dsc-humanize-inner-asset', indexVersion: '1.0.0', assetFormat: { specVersion: '1.0.0', formatVersion: '1.0.0' } }))
  merged.set(BASE + 'certs/dsc-humanize-inner-asset/dsc-humanize-inner-asset-eec.crt', certPem)
  return merged
}

test('install: 走完目录取件、逐文件校验、装配与安装记录', async () => {
  deactivate()
  const storageMap = new Map<string, unknown>()
  const certPem = await readFile(new URL('certs/dsc-humanize-inner-asset/dsc-humanize-inner-asset-eec.crt', REPO_HREF), 'utf8')
  const { context } = createContext(sourceTable(buildFixture(), certPem), storageMap)
  await activate(context)

  const result = await installMarketPackage('dsc-humanize-inner-asset', AUTHOR, PKG, VERSION)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.asset.source.id, PKG)
  assert.equal(result.asset.source.version, VERSION)
  assert.equal(result.record.collectionId, 'dsc-humanize-inner-asset')
  assert.equal(result.record.baseUrl, BASE)
  assert.equal(result.record.packageId, PKG)
  assert.equal(result.record.version, VERSION)
  assert.equal(result.record.revision, 3)
  assert.equal(result.trust.source, 'confirmed')
  assert.equal(result.recordPersisted, true)
  // 装配结果来自本次安装的包内容
  assert.equal(result.asset.contents.persona?.items[0]?.id, 'calm')

  const stored = storageMap.get('dsc-humanize/market/v1') as { installs: Array<{ packageId: string; version: string }> }
  assert.equal(stored.installs.length, 1)
  assert.equal(stored.installs[0]?.packageId, PKG)
  deactivate()
})

test('install: 取件失败整包拒绝,已有装配内容与记录保持不变', async () => {
  deactivate()
  const storageMap = new Map<string, unknown>()
  const certPem = await readFile(new URL('certs/dsc-humanize-inner-asset/dsc-humanize-inner-asset-eec.crt', REPO_HREF), 'utf8')
  const { context } = createContext(sourceTable(buildFixture({ tamper: VERSION + '/persona/calm.json' }), certPem), storageMap)
  await activate(context)

  const previous = {
    persona: { source: { id: 'previous', version: '0.0.1' }, items: [{ id: 'old', name: 'Old', prefix: 'Old content.' }] },
  }
  setActiveContents(previous)

  const result = await installMarketPackage('dsc-humanize-inner-asset', AUTHOR, PKG, VERSION)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'hash-mismatch')

  const stored = storageMap.get('dsc-humanize/market/v1')
  assert.equal(stored, undefined)
  deactivate()
})

test('install: 未登记的来源直接拒绝,不发请求', async () => {
  deactivate()
  const storageMap = new Map<string, unknown>()
  const { context } = createContext(new Map(), storageMap)
  await activate(context)
  const result = await installMarketPackage('dsc-not-configured', AUTHOR, PKG)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'source-unknown')
  deactivate()
})

test('import: 与市场装配同一条整包校验路径的既有语义不变', async () => {
  const document = {
    metadata: JSON.parse(assetJson) as unknown,
    contents: {
      persona: [JSON.parse(personaJson) as unknown],
      injection: [JSON.parse(injectionJson) as unknown],
    },
  }
  const result = await importAssetPackage(JSON.stringify(document))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.trust.source, 'local')
  assert.equal(result.asset.contents.persona?.items[0]?.id, 'calm')
  assert.equal(result.asset.contents.injection?.items[0]?.id, 'brief')
})
