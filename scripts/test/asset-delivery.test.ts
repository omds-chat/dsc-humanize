import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SNAPSHOT_STORAGE_KEY,
  activate,
  deactivate,
  importAssetPackage,
  manifest,
  setActiveContents,
} from '../../src/index.ts'
import type { ChatBeforeRequestHandler, PluginContext } from '../../src/types.ts'

/** 内存版插件存储:记录读取与写入,可按需让写入失败 */
interface FakeStorage {
  values: Map<string, unknown>
  reads: string[]
  failWrite: boolean
}

const createFakeStorage = (): FakeStorage => ({
  values: new Map<string, unknown>(),
  reads: [],
  failWrite: false,
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
        return storage.values.get(key) ?? null
      },
      set: (key, value) => {
        if (storage.failWrite) throw new Error('storage is full')
        storage.values.set(key, value)
      },
      remove: (key) => {
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

/** 每个用例从「未激活、内存无内容」开始 */
const reset = (): void => {
  deactivate()
  setActiveContents({})
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

test('manifest: 申请 plugins:storage 才能读取当前使用快照', () => {
  assert.ok(manifest.capabilities.includes('plugins:storage'))
})

test('activate: 有当前使用快照时装配生效', () => {
  reset()
  const storage = createFakeStorage()
  storage.values.set(SNAPSHOT_STORAGE_KEY, snapshotDocument())
  const fake = createFakeContext(storage)

  activate(fake.context)

  assert.deepEqual(storage.reads, [SNAPSHOT_STORAGE_KEY])
  const handler = fake.handlers[0]
  assert.ok(handler !== undefined)
  assert.deepEqual(handler({ lastUserMessage: 'please keep it short' }), expectedPatch)
  assert.ok(fake.logs.some((message) => message.includes('已从当前使用快照装配')))
})

test('activate: 没有快照时保持空内容', () => {
  reset()
  const storage = createFakeStorage()
  const fake = createFakeContext(storage)

  activate(fake.context)

  const handler = fake.handlers[0]
  assert.ok(handler !== undefined)
  assert.equal(handler({ lastUserMessage: 'please keep it short' }), null)
  assert.ok(fake.logs.some((message) => message.includes('未找到当前使用快照')))
})

test('activate: 没有快照时清空激活前交付的内容', () => {
  reset()
  const storage = createFakeStorage()
  const fake = createFakeContext(storage)

  const imported = importAssetPackage(JSON.stringify(packageDocument()))
  assert.equal(imported.ok, true)
  assert.equal(imported.ok && imported.persisted, false)

  activate(fake.context)
  assert.equal(fake.handlers[0]?.({ lastUserMessage: 'please' }), null)
})

test('activate: 快照版本不支持时保持空内容', () => {
  reset()
  const storage = createFakeStorage()
  storage.values.set(SNAPSHOT_STORAGE_KEY, { snapshotVersion: 2, contents: contentsFixture() })
  const fake = createFakeContext(storage)

  activate(fake.context)

  assert.equal(fake.handlers[0]?.({ lastUserMessage: 'please' }), null)
  assert.ok(fake.logs.some((message) => message.includes('当前使用快照不可用')))
})

test('activate: 快照内容不合法时保持空内容', () => {
  reset()
  const storage = createFakeStorage()
  storage.values.set(SNAPSHOT_STORAGE_KEY, { snapshotVersion: 1, contents: { tone: [] } })
  const fake = createFakeContext(storage)

  activate(fake.context)

  assert.equal(fake.handlers[0]?.({ lastUserMessage: 'please' }), null)
  assert.ok(fake.logs.some((message) => message.includes('当前使用快照不可用')))
})

test('importAssetPackage: 导入资产包文档后装配生效并写入快照', () => {
  reset()
  const storage = createFakeStorage()
  const fake = createFakeContext(storage)
  activate(fake.context)
  assert.equal(fake.handlers[0]?.({ lastUserMessage: 'please' }), null)

  const result = importAssetPackage(JSON.stringify(packageDocument()))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.asset.source.id, 'dsc-example-asset')
  assert.equal(result.persisted, true)

  const stored = storage.values.get(SNAPSHOT_STORAGE_KEY) as {
    snapshotVersion?: unknown
    contents?: { strategies?: { source?: { id?: unknown } } }
  }
  assert.equal(stored.snapshotVersion, 1)
  assert.equal(stored.contents?.strategies?.source?.id, 'dsc-example-asset')

  const patch = fake.handlers[0]?.({ lastUserMessage: 'please keep it short' })
  assert.deepEqual(patch, expectedPatch)
})

test('importAssetPackage: JSON 不合法时返回 invalid-json 且不改内容', () => {
  reset()
  const storage = createFakeStorage()
  const fake = createFakeContext(storage)
  activate(fake.context)

  const result = importAssetPackage('{')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'invalid-json')
  assert.equal(fake.handlers[0]?.({ lastUserMessage: 'please' }), null)
})

test('importAssetPackage: 资产包不合法时整份拒绝且不改内容', () => {
  reset()
  const storage = createFakeStorage()
  const fake = createFakeContext(storage)
  activate(fake.context)

  const broken = packageDocument()
  broken.metadata = { formatVersion: '1.0.0', id: 'dsc-example-asset', version: '0.1.0', types: ['persona'] }
  const result = importAssetPackage(JSON.stringify(broken))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'invalid-asset')
  assert.equal(fake.handlers[0]?.({ lastUserMessage: 'please' }), null)
})

test('importAssetPackage: 写入快照失败时仍装配,persisted 为 false', () => {
  reset()
  const storage = createFakeStorage()
  storage.failWrite = true
  const fake = createFakeContext(storage)
  activate(fake.context)

  const result = importAssetPackage(JSON.stringify(packageDocument()))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.persisted, false)
  assert.deepEqual(fake.handlers[0]?.({ lastUserMessage: 'please keep it short' }), expectedPatch)
  assert.ok(fake.logs.some((message) => message.includes('写入快照失败')))
})
