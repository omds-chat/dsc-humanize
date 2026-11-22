/**
 * 资产市场页面(ui:page)的测试:内存替身覆盖页面模型生成(两来源、安装动作、
 * 刷新)、动作分发到安装层的参数、失败降级形态(来源不可用折叠成一行说明)与
 * 目录短缓存的时效。不发任何真实请求,也不装依赖。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMarketPageModel, MARKET_PAGE_ID, MARKET_PAGE_TITLE, SOURCE_UNAVAILABLE_BADGE, SOURCE_PENDING_BADGE, INSTALL_ACTION_KEY, REFRESH_ACTION_KEY } from '../../src/market/page.ts'
import type { MarketPageSourceResult, MarketPageEntry } from '../../src/market/page.ts'
import type { CatalogResult } from '../../src/market/catalog.ts'
import type { MarketSource } from '../../src/market/sources.ts'
import type {
  DscMount,
  PluginContext,
  PluginPageActionHandler,
  PluginPageActionResponse,
  PluginPageDataHandler,
  PluginPageDescriptor,
  PluginSettingDescriptor,
  PluginSettingValue,
} from '../../src/types.ts'

const { activate, deactivate, setMarketInstaller, setMarketPageClock } = await import('../../src/index.ts')

const sourceOf = (id: string, name: string, enabled = true): MarketSource => ({
  id,
  name,
  baseUrls: ['https://collection.test/' + id + '/'],
  builtin: true,
  enabled,
})

const catalogOk = (source: MarketSource, packages: readonly { id: string; author: string; types: string[] }[]): CatalogResult => ({
  ok: true,
  sourceId: source.id,
  baseUrl: source.baseUrls[0] ?? '',
  meta: { shape: 'flat', specVersion: '1.0.0', formatVersion: '1.0.0' },
  packages: packages.map((pkg) => ({ ...pkg, tags: [] })),
  trust: { signature: 'unverified', source: 'local' },
  notes: [],
})

test('page model: 两个来源各列出包条目,徽标与安装参数对应', () => {
  const inner = sourceOf('dsc-humanize-inner-asset', '组织预设资产包')
  const awesome = sourceOf('awesome-dsc-humanize-asset', '社区资产包')
  const results: MarketPageSourceResult[] = [
    { source: inner, catalog: catalogOk(inner, [{ id: 'pkg-a', author: 'omds-chat', types: ['persona', 'injection'] }]) },
    { source: awesome, catalog: catalogOk(awesome, [{ id: 'pkg-b', author: 'someone', types: [] }]) },
  ]
  const model = buildMarketPageModel(results)
  assert.equal(model.descriptor.id, MARKET_PAGE_ID)
  assert.equal(model.descriptor.title, MARKET_PAGE_TITLE)
  const blocks = model.descriptor.blocks
  assert.deepEqual(blocks.map((block) => block.type), ['text', 'list', 'form', 'actions'])

  const text = blocks[0]
  assert.ok(text?.type === 'text' && text.text.includes('来源是否可信') && text.text.includes('签名是否通过'))
  const list = blocks[1]
  assert.ok(list?.type === 'list')
  assert.equal(list.itemAction?.key, INSTALL_ACTION_KEY)
  assert.equal(list.items.length, 2)
  assert.equal(list.items[0]?.title, 'pkg-a')
  assert.equal(list.items[0]?.badge, '组织预设资产包')
  assert.ok(list.items[0]?.description.includes('作者 omds-chat') && list.items[0]?.description.includes('persona'))
  assert.ok(list.items[1]?.description.includes('未声明类型'))
  const form = blocks[2]
  assert.ok(form?.type === 'form' && form.fields.length === 4)
  const actions = blocks[3]
  assert.ok(actions?.type === 'actions' && actions.items[0]?.key === REFRESH_ACTION_KEY)

  assert.deepEqual(
    model.entries.map((entry: MarketPageEntry) => [entry.sourceId, entry.author, entry.packageId]),
    [
      ['dsc-humanize-inner-asset', 'omds-chat', 'pkg-a'],
      ['awesome-dsc-humanize-asset', 'someone', 'pkg-b'],
    ],
  )
  assert.equal(model.truncated, false)
})

test('page model: 取件失败的来源折叠成一行说明,列表不空', () => {
  const inner = sourceOf('dsc-humanize-inner-asset', '组织预设资产包')
  const awesome = sourceOf('awesome-dsc-humanize-asset', '社区资产包')
  const results: MarketPageSourceResult[] = [
    { source: inner, catalog: catalogOk(inner, [{ id: 'pkg-a', author: 'omds-chat', types: ['persona'] }]) },
    { source: awesome, error: { code: 'source-unreachable', message: '该来源的所有地址都无法访问: ' + awesome.id } },
  ]
  const model = buildMarketPageModel(results)
  const list = model.descriptor.blocks[1]
  assert.ok(list?.type === 'list')
  assert.equal(list.items.length, 2)
  const failure = list.items[1]
  assert.ok(failure !== undefined)
  assert.equal(failure.badge, SOURCE_UNAVAILABLE_BADGE)
  assert.equal(failure.title, '社区资产包')
  assert.ok(failure.description?.includes('只提示不阻断'))
  // 失败来源没有安装登记
  assert.equal(model.entries.length, 1)
  assert.equal(model.entries[0]?.packageId, 'pkg-a')
})

test('page model: 未取到的来源给「读取中」占位', () => {
  const inner = sourceOf('dsc-humanize-inner-asset', '组织预设资产包')
  const model = buildMarketPageModel([{ source: inner, pending: true }])
  const list = model.descriptor.blocks[1]
  assert.ok(list?.type === 'list')
  assert.equal(list.items.length, 1)
  assert.equal(list.items[0]?.badge, SOURCE_PENDING_BADGE)
  assert.equal(model.entries.length, 0)
})

test('page model: 超过宿主 8KB 上限时收敛条目并补截断说明', () => {
  const inner = sourceOf('dsc-humanize-inner-asset', '组织预设资产包')
  const packages = Array.from({ length: 120 }, (_, index) => ({
    id: 'pkg-' + String(index) + '-with-a-fairly-long-identifier',
    author: 'omds-chat',
    types: ['persona', 'injection', 'labels', 'strategies'],
  }))
  const model = buildMarketPageModel([{ source: inner, catalog: catalogOk(inner, packages) }])
  const bytes = new TextEncoder().encode(JSON.stringify(model.descriptor)).byteLength
  assert.ok(bytes <= 8 * 1024, 'descriptor bytes ' + String(bytes))
  assert.equal(model.truncated, true)
  const list = model.descriptor.blocks[1]
  assert.ok(list?.type === 'list')
  const notice = list.items.find((item) => item.key === 'pkg-truncated')
  assert.ok(notice !== undefined, 'truncation notice item present')
  assert.equal(list.items.length, model.entries.length + 1)
})

/* ---------- 接线层:activate 登记、数据挂载点、动作分发与短缓存 ---------- */

const INNER_URL = 'https://page.test/inner/'
const AWESOME_URL = 'https://page.test/awesome/'

const indexedMeta = JSON.stringify({
  name: 'dsc-humanize-inner-asset',
  indexVersion: '1.0.0',
  assetFormat: { specVersion: '1.0.0', formatVersion: '1.0.0' },
})
const flatMeta = JSON.stringify({ assetSpecVersion: '1.0.0', assetFormatVersion: '1.0.0' })
const innerIndex = JSON.stringify([
  { id: 'pkg-a', author: 'omds-chat', tag: ['daily'], types: ['persona'] },
  { id: 'pkg-b', author: 'omds-chat', tag: [], types: ['injection'] },
])
const awesomeIndex = JSON.stringify([
  { id: 'pkg-c', author: 'someone', tag: [], types: ['persona'] },
])

interface FakeContext {
  context: PluginContext
  pages: PluginPageDescriptor[]
  actionHandlers: PluginPageActionHandler[]
  dataHandlers: PluginPageDataHandler[]
  logs: string[]
  notices: { key: string; params?: Record<string, string | number> }[]
  registrations: PluginSettingDescriptor[]
  settingsValues: Record<string, PluginSettingValue>
  reads: string[]
}

const createFakeContext = (table: Map<string, string | number | null>): FakeContext => {
  const pages: PluginPageDescriptor[] = []
  const actionHandlers: PluginPageActionHandler[] = []
  const dataHandlers: PluginPageDataHandler[] = []
  const logs: string[] = []
  const notices: { key: string; params?: Record<string, string | number> }[] = []
  const registrations: PluginSettingDescriptor[] = []
  const settingsValues: Record<string, PluginSettingValue> = {}
  const reads: string[] = []

  const context: PluginContext = {
    id: 'dsc-humanize',
    version: '0.1.0',
    log: (message) => {
      logs.push(message)
    },
    sessions: {
      list: () => Promise.resolve([]),
      read: () => Promise.resolve(null),
      rename: () => false,
    },
    events: {
      on: (_point: DscMount, _handler: (event: never) => void) => () => undefined,
    },
    ui: {
      notify: (key, params) => {
        notices.push({ key, ...(params === undefined ? {} : { params }) })
      },
      registerPage: (descriptor) => {
        pages.push(descriptor)
        return { id: descriptor.id, dispose: () => undefined }
      },
      onPageAction: (handler) => {
        actionHandlers.push(handler)
        return () => undefined
      },
      onPageData: (handler) => {
        dataHandlers.push(handler)
        return () => undefined
      },
    },
    settings: {
      locale: () => Promise.resolve('zh-CN'),
      register: (descriptor) => {
        registrations.push(descriptor)
        return () => undefined
      },
      values: () => ({ ...settingsValues }),
    },
    assets: {
      readText: (url: string) => {
        reads.push(url)
        const entry = table.get(url)
        if (entry === undefined) return Promise.reject(new Error('rejected: ' + url))
        if (entry === null) return Promise.resolve({ kind: 'no-status', url } as const)
        if (typeof entry === 'number') return Promise.resolve({ kind: 'status', url, status: entry } as const)
        return Promise.resolve({ kind: 'content', url, contentType: 'application/json', text: entry } as const)
      },
    },
    net: {
      getText: () => Promise.resolve({ url: '', contentType: '', text: '' }),
      postJson: () => Promise.resolve({ url: '', status: 200 }),
    },
    storage: {
      get: () => null,
      set: () => undefined,
      remove: () => undefined,
    },
    chat: {
      onBeforeRequest: () => () => undefined,
    },
  }
  return { context, pages, actionHandlers, dataHandlers, logs, notices, registrations, settingsValues, reads }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 两个内置来源的可取件目录(inner:indexed;awesome:flat) */
const happyTable = (): Map<string, string | number | null> =>
  new Map([
    [INNER_URL + 'meta.json', indexedMeta],
    [INNER_URL + 'assets.json', innerIndex],
    [AWESOME_URL + 'meta.json', flatMeta],
    [AWESOME_URL + 'assets.json', awesomeIndex],
  ])

const reset = (): void => {
  deactivate()
  setMarketInstaller()
  setMarketPageClock()
}

const waitUntil = async (probe: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200 && !probe(); attempt += 1) {
    await sleep(5)
  }
}

test('activate: 登记 ui:page 页面、动作与数据挂载点,清单已申请对应能力', async () => {
  reset()
  ;(globalThis as Record<string, unknown>).__INNER_ASSET_PAGES_URL__ = INNER_URL
  ;(globalThis as Record<string, unknown>).__AWESOME_ASSET_PAGES_URL__ = AWESOME_URL
  const fake = createFakeContext(happyTable())
  await activate(fake.context)

  assert.equal(fake.pages.length, 1)
  assert.equal(fake.pages[0]?.id, MARKET_PAGE_ID)
  assert.equal(fake.actionHandlers.length, 1)
  assert.equal(fake.dataHandlers.length, 1)
  assert.ok(fake.logs.some((line) => line.includes('已登记资产市场页面')))
  // 两个挂载点各自占用一个 ui:page 登记名额(引擎限流 20 次 / 10 秒)
  assert.ok(fake.logs.some((line) => line.includes('资产市场设置字段')))
})

test('data 挂载点: 首次进入显示「读取中」,后台取件完成后列出两来源的包', async () => {
  reset()
  ;(globalThis as Record<string, unknown>).__INNER_ASSET_PAGES_URL__ = INNER_URL
  ;(globalThis as Record<string, unknown>).__AWESOME_ASSET_PAGES_URL__ = AWESOME_URL
  const fake = createFakeContext(happyTable())
  await activate(fake.context)
  const data = fake.dataHandlers[0]
  assert.ok(data !== undefined)

  const first = data(MARKET_PAGE_ID)
  assert.ok(first !== null)
  const firstList = first.blocks[1]
  assert.ok(firstList?.type === 'list')
  assert.ok(firstList.items.every((item) => item.badge === SOURCE_PENDING_BADGE))

  await waitUntil(() => {
    const model = data(MARKET_PAGE_ID)
    if (model === null) return false
    const list = model.blocks[1]
    return list?.type === 'list' && list.items.some((item) => item.badge !== SOURCE_PENDING_BADGE)
  })

  const settled = data(MARKET_PAGE_ID)
  assert.ok(settled !== null)
  const list = settled.blocks[1]
  assert.ok(list?.type === 'list')
  const badges = list.items.map((item) => item.badge)
  assert.ok(badges.includes('组织预设资产包'))
  assert.ok(badges.includes('社区资产包'))
  const titles = list.items.map((item) => item.title)
  assert.deepEqual(titles, ['pkg-a', 'pkg-b', 'pkg-c'])
})

test('data 挂载点: 缓存时效内的重复索取不重复取件', async () => {
  reset()
  ;(globalThis as Record<string, unknown>).__INNER_ASSET_PAGES_URL__ = INNER_URL
  ;(globalThis as Record<string, unknown>).__AWESOME_ASSET_PAGES_URL__ = AWESOME_URL
  const fake = createFakeContext(happyTable())
  await activate(fake.context)
  const data = fake.dataHandlers[0]
  assert.ok(data !== undefined)

  data(MARKET_PAGE_ID)
  await waitUntil(() => fake.reads.filter((url) => url.endsWith('assets.json')).length >= 2)
  const afterFirstPull = fake.reads.length

  data(MARKET_PAGE_ID)
  data(MARKET_PAGE_ID)
  assert.equal(fake.reads.length, afterFirstPull)
})

test('refresh 动作: 返回刷新指示并绕过缓存重新取件', async () => {
  reset()
  ;(globalThis as Record<string, unknown>).__INNER_ASSET_PAGES_URL__ = INNER_URL
  ;(globalThis as Record<string, unknown>).__AWESOME_ASSET_PAGES_URL__ = AWESOME_URL
  const fake = createFakeContext(happyTable())
  await activate(fake.context)
  const data = fake.dataHandlers[0]
  const action = fake.actionHandlers[0]
  assert.ok(data !== undefined && action !== undefined)

  data(MARKET_PAGE_ID)
  await waitUntil(() => fake.reads.filter((url) => url.endsWith('assets.json')).length >= 2)
  const before = fake.reads.length

  const response: PluginPageActionResponse | undefined = action({
    pageId: MARKET_PAGE_ID,
    actionId: REFRESH_ACTION_KEY,
  })
  assert.deepEqual(response, { refresh: true })

  await waitUntil(() => fake.reads.length > before)
  assert.ok(fake.reads.length > before)
})

test('install 动作: 按条目键分发到安装层,成功用 notify 提示', async () => {
  reset()
  ;(globalThis as Record<string, unknown>).__INNER_ASSET_PAGES_URL__ = INNER_URL
  ;(globalThis as Record<string, unknown>).__AWESOME_ASSET_PAGES_URL__ = AWESOME_URL
  const fake = createFakeContext(happyTable())
  await activate(fake.context)
  const data = fake.dataHandlers[0]
  const action = fake.actionHandlers[0]
  assert.ok(data !== undefined && action !== undefined)

  const calls: { sourceId: string; author: string; packageId: string; version?: string }[] = []
  setMarketInstaller(async (sourceId, author, packageId) => {
    calls.push({ sourceId, author, packageId })
    return {
      ok: true,
      asset: { source: { id: packageId, version: '1.0.0' }, formatVersion: '1.0.0', types: ['persona'], contents: {} },
      persisted: true,
      trust: { signature: 'unverified', source: 'confirmed' },
      record: {
        collectionId: sourceId,
        baseUrl: INNER_URL,
        author,
        packageId,
        version: '1.0.0',
        formatVersion: '1.0.0',
        types: ['persona'],
        trust: { signature: 'unverified', source: 'confirmed' },
        installedAt: new Date().toISOString(),
      },
      recordPersisted: true,
    }
  })

  data(MARKET_PAGE_ID)
  await waitUntil(() => data(MARKET_PAGE_ID)?.blocks[1]?.type === 'list' && (data(MARKET_PAGE_ID)?.blocks[1] as { items?: { badge?: string }[] })?.items?.some((item) => item.badge !== SOURCE_PENDING_BADGE) === true)
  const model = data(MARKET_PAGE_ID)
  assert.ok(model !== null)
  const list = model.blocks[1]
  assert.ok(list?.type === 'list')
  const target = list.items[0]
  assert.ok(target !== undefined)

  action({ pageId: MARKET_PAGE_ID, actionId: INSTALL_ACTION_KEY, itemKey: target.key })
  await waitUntil(() => fake.notices.length > 0)
  assert.deepEqual(calls, [{ sourceId: 'dsc-humanize-inner-asset', author: 'omds-chat', packageId: 'pkg-a' }])
  assert.equal(fake.notices[0]?.key, 'pluginAssetInstalled')
  assert.equal(fake.notices[0]?.params?.id, 'pkg-a')
})

test('install 动作: 安装失败降级为失败提示,不弹窗不阻断', async () => {
  reset()
  ;(globalThis as Record<string, unknown>).__INNER_ASSET_PAGES_URL__ = INNER_URL
  ;(globalThis as Record<string, unknown>).__AWESOME_ASSET_PAGES_URL__ = AWESOME_URL
  const fake = createFakeContext(happyTable())
  await activate(fake.context)
  const data = fake.dataHandlers[0]
  const action = fake.actionHandlers[0]
  assert.ok(data !== undefined && action !== undefined)

  setMarketInstaller(async () => ({
    ok: false,
    error: { code: 'manifest-missing', message: '包层清单缺失,无法安全取件: pkg-a' },
  }))

  data(MARKET_PAGE_ID)
  await waitUntil(() => {
    const model = data(MARKET_PAGE_ID)
    const list = model?.blocks[1]
    return list?.type === 'list' && list.items.some((item) => item.badge !== SOURCE_PENDING_BADGE)
  })
  const model = data(MARKET_PAGE_ID)
  assert.ok(model !== null)
  const list = model.blocks[1]
  assert.ok(list?.type === 'list')
  const target = list.items[0]
  assert.ok(target !== undefined)

  action({ pageId: MARKET_PAGE_ID, actionId: INSTALL_ACTION_KEY, itemKey: target.key })
  await waitUntil(() => fake.notices.length > 0)
  assert.equal(fake.notices[0]?.key, 'pluginAssetInstallFailed')
  assert.equal(fake.notices[0]?.params?.id, 'pkg-a')
  assert.ok(String(fake.notices[0]?.params?.reason).includes('manifest-missing'))
})

test('install 动作: 过期条目键被忽略且不分发', async () => {
  reset()
  ;(globalThis as Record<string, unknown>).__INNER_ASSET_PAGES_URL__ = INNER_URL
  ;(globalThis as Record<string, unknown>).__AWESOME_ASSET_PAGES_URL__ = AWESOME_URL
  const fake = createFakeContext(happyTable())
  await activate(fake.context)
  const action = fake.actionHandlers[0]
  assert.ok(action !== undefined)

  const calls: unknown[] = []
  setMarketInstaller(async (sourceId, author, packageId) => {
    calls.push({ sourceId, author, packageId })
    throw new Error('should not be called')
  })

  action({ pageId: MARKET_PAGE_ID, actionId: INSTALL_ACTION_KEY, itemKey: 'pkg-999' })
  await sleep(20)
  assert.equal(calls.length, 0)
  assert.equal(fake.notices.length, 0)
  assert.ok(fake.logs.some((line) => line.includes('条目键已过期或不可用')))
})

test('来源取件失败: 页面折叠为「来源不可用」一行,另一来源照常列出', async () => {
  reset()
  ;(globalThis as Record<string, unknown>).__INNER_ASSET_PAGES_URL__ = INNER_URL
  ;(globalThis as Record<string, unknown>).__AWESOME_ASSET_PAGES_URL__ = AWESOME_URL
  // awesome 侧连 meta.json 都取不到:整个来源不可达
  const table = happyTable()
  table.delete(AWESOME_URL + 'meta.json')
  const fake = createFakeContext(table)
  await activate(fake.context)
  const data = fake.dataHandlers[0]
  assert.ok(data !== undefined)

  data(MARKET_PAGE_ID)
  await waitUntil(() => {
    const model = data(MARKET_PAGE_ID)
    const list = model?.blocks[1]
    return list?.type === 'list' && list.items.some((item) => item.badge === SOURCE_UNAVAILABLE_BADGE)
  })
  const model = data(MARKET_PAGE_ID)
  assert.ok(model !== null)
  const list = model.blocks[1]
  assert.ok(list?.type === 'list')
  assert.ok(list.items.length >= 2, '列表不空')
  const unavailable = list.items.filter((item) => item.badge === SOURCE_UNAVAILABLE_BADGE)
  assert.equal(unavailable.length, 1)
  assert.equal(unavailable[0]?.title, '社区资产包')
  assert.ok(list.items.some((item) => item.title === 'pkg-a' && item.badge === '组织预设资产包'))
})

test('来源开关关闭: 关闭的来源不取件也不出现在模型里', async () => {
  reset()
  ;(globalThis as Record<string, unknown>).__INNER_ASSET_PAGES_URL__ = INNER_URL
  ;(globalThis as Record<string, unknown>).__AWESOME_ASSET_PAGES_URL__ = AWESOME_URL
  const fake = createFakeContext(happyTable())
  fake.settingsValues['inner-asset-source'] = false
  await activate(fake.context)
  const data = fake.dataHandlers[0]
  assert.ok(data !== undefined)

  data(MARKET_PAGE_ID)
  await waitUntil(() => {
    const model = data(MARKET_PAGE_ID)
    const list = model?.blocks[1]
    return list?.type === 'list' && list.items.some((item) => item.badge !== SOURCE_PENDING_BADGE)
  })
  const model = data(MARKET_PAGE_ID)
  assert.ok(model !== null)
  const list = model.blocks[1]
  assert.ok(list?.type === 'list')
  assert.ok(list.items.every((item) => item.badge !== '组织预设资产包'))
  assert.ok(list.items.every((item) => !item.title.startsWith('pkg-a') && !item.title.startsWith('pkg-b')))
  assert.ok(fake.reads.every((url) => !url.startsWith(INNER_URL)))
})

test('表单草稿: 动作载荷的表单值在本会话内覆盖设置值参与来源解析', async () => {
  reset()
  ;(globalThis as Record<string, unknown>).__INNER_ASSET_PAGES_URL__ = INNER_URL
  ;(globalThis as Record<string, unknown>).__AWESOME_ASSET_PAGES_URL__ = AWESOME_URL
  const fake = createFakeContext(happyTable())
  await activate(fake.context)
  const data = fake.dataHandlers[0]
  const action = fake.actionHandlers[0]
  assert.ok(data !== undefined && action !== undefined)

  action({
    pageId: MARKET_PAGE_ID,
    actionId: REFRESH_ACTION_KEY,
    form: { 'inner-asset-source': false, 'awesome-asset-source': true },
  })
  await waitUntil(() => fake.reads.filter((url) => url.endsWith('assets.json')).length >= 1)
  assert.ok(fake.reads.every((url) => !url.startsWith(INNER_URL)), '关闭的来源不发请求')

  const model = data(MARKET_PAGE_ID)
  assert.ok(model !== null)
  const list = model.blocks[1]
  assert.ok(list?.type === 'list')
  const titles = list.items.map((item) => item.title)
  assert.ok(!titles.includes('pkg-a') && titles.includes('pkg-c'))
})
