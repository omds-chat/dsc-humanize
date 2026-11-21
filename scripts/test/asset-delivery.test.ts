import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SNAPSHOT_STORAGE_KEY,
  activate,
  deactivate,
  importAssetPackage,
  manifest,
  setActiveContents,
  setSnapshotDbFactory,
} from '../../src/index.ts'
import { SNAPSHOT_MAX_BYTES } from '../../src/host/snapshot-db.ts'
import type { ChatBeforeRequestHandler, PluginContext } from '../../src/types.ts'
import { createFakeIdb } from './fake-idb.ts'

/** 内存版插件存储:只用于一次性迁移,可按需让读取失败 */
interface FakeStorage {
  values: Map<string, unknown>
  reads: string[]
  removals: string[]
  failRead: boolean
}

const createFakeStorage = (): FakeStorage => ({
  values: new Map<string, unknown>(),
  reads: [],
  removals: [],
  failRead: false,
})

const createFakeContext = (storage: FakeStorage) => {
  const handlers: ChatBeforeRequestHandler[] = []
  const logs: string[] = []

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
      on: () => () => undefined,
    },
    ui: {
      notify: () => undefined,
    },
    settings: {
      locale: () => Promise.resolve('zh-CN'),
    },
    net: {
      getText: () => Promise.resolve({ url: '', contentType: '', text: '' }),
      postJson: () => Promise.resolve({ url: '', status: 200 }),
    },
    storage: {
      get: (key) => {
        storage.reads.push(key)
        if (storage.failRead) throw new Error('storage is broken')
        return storage.values.get(key) ?? null
      },
      set: () => undefined,
      remove: (key) => {
        storage.removals.push(key)
        storage.values.delete(key)
      },
    },
    chat: {
      onBeforeRequest: (handler) => {
        handlers.push(handler)
        return () => undefined
      },
    },
  }

  return { context, handlers, logs }
}

/** 每个用例从「未激活、内存无内容、IndexedDB 与插件存储为空」开始 */
const reset = (): void => {
  deactivate()
  setActiveContents({})
  setSnapshotDbFactory(undefined)
}

/** 快照里四类内容的条目,按 4.6 约定的形状手写,用于钉住存储格式 */
const contentsFixture = (): Record<string, unknown> => ({
  persona: {
    source: { id: 'dsc-persona', version: '1.0.0' },
    items: [{ id: 'calm', name: 'Calm', prefix: 'You are calm.' }],
  },
  labels: {
    source: { id: 'dsc-labels', version: '1.0.0' },
    items: [{ id: 'tone', keywords: ['please'] }],
  },
  strategies: {
    source: { id: 'dsc-strategies', version: '1.0.0' },
    items: [{
      id: 'daily',
      version: 'v1',
      rules: [{ label: 'tone', strategy: { temperature: 0.4 } }],
    }],
  },
  injection: {
    source: { id: 'dsc-injection', version: '1.0.0' },
    items: [{ id: 'brief', name: 'Brief', text: 'Be brief.' }],
  },
})

/** 一份合法的当前使用快照 */
const snapshotDocument = (): Record<string, unknown> => ({
  snapshotVersion: 1,
  contents: contentsFixture(),
})

/** 包文档的 contents 是「类型到条目数组」,来源由元数据统一给出,与快照的「来源 + 条目」不同 */
const packageContents = (): Record<string, unknown> => ({
  persona: [{ id: 'calm', name: 'Calm', prefix: 'You are calm.' }],
  labels: [{ id: 'tone', keywords: ['please'] }],
  strategies: [{
    id: 'daily',
    version: 'v1',
    rules: [{ label: 'tone', strategy: { temperature: 0.4 } }],
  }],
  injection: [{ id: 'brief', name: 'Brief', text: 'Be brief.' }],
})

/** 一份合法的加载期资产包文档,与快照的区别是元数据与内容都来自同一个包 */
const packageDocument = (): Record<string, unknown> => ({
  metadata: {
    formatVersion: '1.0.0',
    id: 'dsc-example-asset',
    name: '示例资产包',
    version: '0.1.0',
    description: '测试用包',
    author: 'omds-chat',
    types: ['persona', 'labels', 'strategies', 'injection'],
  },
  contents: packageContents(),
})

const expectedPatch = {
  temperature: 0.4,
  systemPromptAppend: 'You are calm.\n\nBe brief.',
}

test('manifest: 申请 plugins:storage 才能读取并迁移过渡快照', () => {
  assert.ok(manifest.capabilities.includes('plugins:storage'))
})

test('activate: IndexedDB 里有快照时装配生效', async () => {
  reset()
  const idb = createFakeIdb()
  idb.data.set('active', snapshotDocument())
  setSnapshotDbFactory(idb.factory)
  const fake = createFakeContext(createFakeStorage())

  await activate(fake.context)

  // IndexedDB 是常规通道,不再读插件存储
  assert.deepEqual(fake.logs.filter((message) => message.includes(SNAPSHOT_STORAGE_KEY)), [])
  const handler = fake.handlers[0]
  assert.ok(handler !== undefined)
  assert.deepEqual(handler({ lastUserMessage: 'please keep it short' }), expectedPatch)
  assert.ok(fake.logs.some((message) => message.includes('已从当前使用快照装配')))
})

test('activate: 没有快照时保持空内容', async () => {
  reset()
  setSnapshotDbFactory(createFakeIdb().factory)
  const fake = createFakeContext(createFakeStorage())

  await activate(fake.context)

  const handler = fake.handlers[0]
  assert.ok(handler !== undefined)
  assert.equal(handler({ lastUserMessage: 'please keep it short' }), null)
  assert.ok(fake.logs.some((message) => message.includes('未找到当前使用快照')))
})

test('activate: 没有快照时清空激活前交付的内容', async () => {
  reset()
  setSnapshotDbFactory(createFakeIdb().factory)
  const fake = createFakeContext(createFakeStorage())

  const imported = await importAssetPackage(JSON.stringify(packageDocument()))
  assert.equal(imported.ok, true)
  assert.equal(imported.ok && imported.persisted, false)

  await activate(fake.context)
  assert.equal(fake.handlers[0]?.({ lastUserMessage: 'please' }), null)
})

test('activate: 快照版本不支持时保持空内容', async () => {
  reset()
  const idb = createFakeIdb()
  idb.data.set('active', { snapshotVersion: 2, contents: contentsFixture() })
  setSnapshotDbFactory(idb.factory)
  const fake = createFakeContext(createFakeStorage())

  await activate(fake.context)

  assert.equal(fake.handlers[0]?.({ lastUserMessage: 'please' }), null)
  assert.ok(fake.logs.some((message) => message.includes('当前使用快照不可用')))
})

test('activate: 快照内容不合法时保持空内容', async () => {
  reset()
  const idb = createFakeIdb()
  idb.data.set('active', { snapshotVersion: 1, contents: { tone: [] } })
  setSnapshotDbFactory(idb.factory)
  const fake = createFakeContext(createFakeStorage())

  await activate(fake.context)

  assert.equal(fake.handlers[0]?.({ lastUserMessage: 'please' }), null)
  assert.ok(fake.logs.some((message) => message.includes('当前使用快照不可用')))
})

test('activate: IndexedDB 读取失败时回退过渡快照并完成迁移', async () => {
  reset()
  const idb = createFakeIdb({ failRead: true })
  setSnapshotDbFactory(idb.factory)
  const storage = createFakeStorage()
  storage.values.set(SNAPSHOT_STORAGE_KEY, snapshotDocument())
  const fake = createFakeContext(storage)

  await activate(fake.context)

  assert.deepEqual(fake.handlers[0]?.({ lastUserMessage: 'please keep it short' }), expectedPatch)
  assert.deepEqual(idb.data.get('active'), snapshotDocument())
  assert.ok(storage.removals.includes(SNAPSHOT_STORAGE_KEY))
  assert.ok(fake.logs.some((message) => message.includes('读取 IndexedDB 快照失败')))
  assert.ok(fake.logs.some((message) => message.includes('已把插件存储里的过渡快照迁入 IndexedDB')))
})

test('activate: IndexedDB 里没有记录时把过渡快照迁入并删除旧键', async () => {
  reset()
  const idb = createFakeIdb()
  setSnapshotDbFactory(idb.factory)
  const storage = createFakeStorage()
  storage.values.set(SNAPSHOT_STORAGE_KEY, snapshotDocument())
  const fake = createFakeContext(storage)

  await activate(fake.context)

  assert.deepEqual(fake.handlers[0]?.({ lastUserMessage: 'please keep it short' }), expectedPatch)
  assert.deepEqual(idb.data.get('active'), snapshotDocument())
  assert.ok(storage.removals.includes(SNAPSHOT_STORAGE_KEY))
  assert.ok(fake.logs.some((message) => message.includes('迁入 IndexedDB')))
})

test('activate: 迁移写入失败时旧键保留,装配不受影响', async () => {
  reset()
  const idb = createFakeIdb({ failWrite: true })
  setSnapshotDbFactory(idb.factory)
  const storage = createFakeStorage()
  storage.values.set(SNAPSHOT_STORAGE_KEY, snapshotDocument())
  const fake = createFakeContext(storage)

  await activate(fake.context)

  assert.deepEqual(fake.handlers[0]?.({ lastUserMessage: 'please keep it short' }), expectedPatch)
  assert.equal(idb.data.size, 0)
  // 写不进 IndexedDB 就不删旧键,下次激活重试
  assert.ok(storage.values.has(SNAPSHOT_STORAGE_KEY))
  assert.deepEqual(storage.removals, [])
  assert.ok(fake.logs.some((message) => message.includes('迁移过渡快照到 IndexedDB 失败')))
})

test('activate: 过渡快照不合法时保持空内容,不迁移也不删旧键', async () => {
  reset()
  const idb = createFakeIdb()
  setSnapshotDbFactory(idb.factory)
  const storage = createFakeStorage()
  storage.values.set(SNAPSHOT_STORAGE_KEY, { snapshotVersion: 9, contents: {} })
  const fake = createFakeContext(storage)

  await activate(fake.context)

  assert.equal(fake.handlers[0]?.({ lastUserMessage: 'please' }), null)
  assert.equal(idb.data.size, 0)
  assert.ok(storage.values.has(SNAPSHOT_STORAGE_KEY))
  assert.ok(fake.logs.some((message) => message.includes('当前使用快照不可用')))
})

test('activate: IndexedDB 不可用时回退读过渡快照,不删旧键', async () => {
  reset()
  setSnapshotDbFactory(null)
  const storage = createFakeStorage()
  storage.values.set(SNAPSHOT_STORAGE_KEY, snapshotDocument())
  const fake = createFakeContext(storage)

  await activate(fake.context)

  assert.deepEqual(fake.handlers[0]?.({ lastUserMessage: 'please keep it short' }), expectedPatch)
  assert.ok(storage.values.has(SNAPSHOT_STORAGE_KEY))
  assert.deepEqual(storage.removals, [])
})

test('activate: IndexedDB 不可用且没有过渡快照时保持空内容', async () => {
  reset()
  setSnapshotDbFactory(null)
  const fake = createFakeContext(createFakeStorage())

  await activate(fake.context)

  assert.equal(fake.handlers[0]?.({ lastUserMessage: 'please' }), null)
  assert.ok(fake.logs.some((message) => message.includes('未找到当前使用快照')))
})

test('importAssetPackage: 导入资产包文档后装配生效并写入 IndexedDB', async () => {
  reset()
  const idb = createFakeIdb()
  setSnapshotDbFactory(idb.factory)
  const fake = createFakeContext(createFakeStorage())
  await activate(fake.context)
  assert.equal(fake.handlers[0]?.({ lastUserMessage: 'please' }), null)

  const result = await importAssetPackage(JSON.stringify(packageDocument()))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.asset.source.id, 'dsc-example-asset')
  assert.equal(result.persisted, true)

  const stored = idb.data.get('active') as {
    snapshotVersion?: unknown
    contents?: { strategies?: { source?: { id?: unknown } } }
  }
  assert.equal(stored.snapshotVersion, 1)
  assert.equal(stored.contents?.strategies?.source?.id, 'dsc-example-asset')

  const patch = fake.handlers[0]?.({ lastUserMessage: 'please keep it short' })
  assert.deepEqual(patch, expectedPatch)
})

test('importAssetPackage: JSON 不合法时返回 invalid-json 且不改内容', async () => {
  reset()
  setSnapshotDbFactory(createFakeIdb().factory)
  const fake = createFakeContext(createFakeStorage())
  await activate(fake.context)

  const result = await importAssetPackage('{')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'invalid-json')
  assert.equal(fake.handlers[0]?.({ lastUserMessage: 'please' }), null)
})

test('importAssetPackage: 资产包不合法时整份拒绝且不改内容', async () => {
  reset()
  setSnapshotDbFactory(createFakeIdb().factory)
  const fake = createFakeContext(createFakeStorage())
  await activate(fake.context)

  const broken = packageDocument()
  broken.metadata = { formatVersion: '1.0.0', id: 'dsc-example-asset', version: '0.1.0', types: ['persona'] }
  const result = await importAssetPackage(JSON.stringify(broken))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'invalid-asset')
  assert.equal(fake.handlers[0]?.({ lastUserMessage: 'please' }), null)
})

test('importAssetPackage: 写入 IndexedDB 失败时仍装配,persisted 为 false', async () => {
  reset()
  setSnapshotDbFactory(createFakeIdb({ failWrite: true }).factory)
  const fake = createFakeContext(createFakeStorage())
  await activate(fake.context)

  const result = await importAssetPackage(JSON.stringify(packageDocument()))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.persisted, false)
  assert.deepEqual(fake.handlers[0]?.({ lastUserMessage: 'please keep it short' }), expectedPatch)
  assert.ok(fake.logs.some((message) => message.includes('写入快照失败')))
})

test('importAssetPackage: 超过体积上限时不写入,仍装配,persisted 为 false', async () => {
  reset()
  const idb = createFakeIdb()
  setSnapshotDbFactory(idb.factory)
  const fake = createFakeContext(createFakeStorage())
  await activate(fake.context)

  const oversized = packageDocument()
  const contents = oversized.contents as { persona: { prefix: string }[] }
  contents.persona[0]!.prefix = 'x'.repeat(SNAPSHOT_MAX_BYTES)
  const result = await importAssetPackage(JSON.stringify(oversized))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.persisted, false)
  // 内存装配不受写入失败影响,超长人设前缀原样保留,交给引擎按补丁上限收敛
  const patch = fake.handlers[0]?.({ lastUserMessage: 'please keep it short' })
  assert.ok(patch !== null && patch !== undefined)
  assert.equal(patch.temperature, 0.4)
  assert.ok((patch.systemPromptAppend ?? '').length >= SNAPSHOT_MAX_BYTES)
  assert.ok(fake.logs.some((message) => message.includes('写入快照失败')))
  assert.equal(idb.data.size, 0)
})

test('importAssetPackage: 未激活时只装配到内存,不写入', async () => {
  reset()
  const idb = createFakeIdb()
  setSnapshotDbFactory(idb.factory)
  const fake = createFakeContext(createFakeStorage())

  const result = await importAssetPackage(JSON.stringify(packageDocument()))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.persisted, false)
  assert.equal(idb.data.size, 0)
  assert.deepEqual(fake.handlers.length, 0)
})
