import assert from 'node:assert/strict'
import test from 'node:test'

import { createBeforeRequestHandler } from '../../src/host/request-patch.ts'
import { activate, deactivate, setActiveContents } from '../../src/index.ts'
import type {
  AssetContents,
  AssetSourceRef,
  LabelDefinition,
  PersonaProfile,
  StrategyTable,
} from '../../src/humanize/types.ts'
import type {
  ChatBeforeRequestHandler,
  DscMount,
  PluginContext,
  SessionChangedEvent,
} from '../../src/types.ts'

/** 超过宿主 32 字符上限的停止词,用来验证插件不自行裁剪 */
const LONG_STOP = 'x'.repeat(40)

const sourceOf = (id: string): AssetSourceRef => ({ id, version: '1.0.0' })

const labels: readonly LabelDefinition[] = [{ id: 'tone', keywords: ['please'] }]

const persona: PersonaProfile = { id: 'p1', name: 'Friendly', prefix: 'You are friendly.' }

const strategyTable: StrategyTable = {
  id: 'daily',
  version: 'v1',
  base: { topP: 0.8 },
  rules: [{
    label: 'tone',
    strategy: { temperature: 0.9, maxTokens: 32000, stop: ['END', LONG_STOP] },
  }],
}

/** 四类齐全的装配输入:策略值刻意越过宿主上限,交给引擎收敛 */
const contentsWithAssets = (): AssetContents => ({
  persona: { source: sourceOf('dsc-persona'), items: [persona] },
  labels: { source: sourceOf('dsc-labels'), items: labels },
  strategies: { source: sourceOf('dsc-strategies'), items: [strategyTable] },
  injection: { source: sourceOf('dsc-injection'), items: [{ id: 'brief', name: 'Brief', text: 'Be brief.' }] },
})

/** 只有标签集,没有策略表 */
const contentsWithoutStrategies = (): AssetContents => ({
  labels: { source: sourceOf('dsc-labels'), items: labels },
})

interface FakeContext {
  context: PluginContext
  handlers: ChatBeforeRequestHandler[]
  eventPoints: DscMount[]
  logs: string[]
  notices: string[]
}

/** 只实现本插件用到的成员,其余按契约给空实现 */
const createFakeContext = (): FakeContext => {
  const handlers: ChatBeforeRequestHandler[] = []
  const eventPoints: DscMount[] = []
  const logs: string[] = []
  const notices: string[] = []

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
      on: (point: DscMount, _handler: (event: SessionChangedEvent) => void) => {
        eventPoints.push(point)
        return () => undefined
      },
    },
    ui: {
      notify: (key) => {
        notices.push(key)
      },
    },
    settings: {
      locale: () => Promise.resolve('zh-CN'),
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
      onBeforeRequest: (handler) => {
        handlers.push(handler)
        return () => undefined
      },
    },
  }

  return { context, handlers, eventPoints, logs, notices }
}

/** 每个用例从「未激活、无资产」开始,避免模块级状态互相影响 */
const reset = (): void => {
  deactivate()
  setActiveContents({})
}

test('activate: 申请 chat:request 并注册请求前处理器', async () => {
  reset()
  const fake = createFakeContext()
  await activate(fake.context)

  assert.equal(fake.handlers.length, 1)
  assert.deepEqual(fake.eventPoints, ['session:changed'])
})

test('请求前处理器: 有标签集与策略表时返回宿主补丁', async () => {
  reset()
  const fake = createFakeContext()
  await activate(fake.context)
  setActiveContents(contentsWithAssets())

  const handler = fake.handlers[0]
  assert.ok(handler !== undefined)
  const patch = handler({ lastUserMessage: 'please keep it short' })

  assert.deepEqual(patch, {
    temperature: 0.9,
    topP: 0.8,
    maxTokens: 32000,
    stop: ['END', LONG_STOP],
    systemPromptAppend: 'You are friendly.\n\nBe brief.',
  })
  // 越界的 maxTokens 与超长的停止词不在插件里裁剪,由引擎按补丁上限收敛
  assert.equal(patch?.maxTokens, 32000)
  assert.equal(patch?.stop?.[1]?.length, LONG_STOP.length)
  // 宿主切片里没有系统提示词,注入只走追加,不整体替换
  assert.equal(patch !== null && 'systemPromptReplace' in patch, false)
  assert.deepEqual(Object.keys(patch ?? {}).sort(), [
    'maxTokens',
    'stop',
    'systemPromptAppend',
    'temperature',
    'topP',
  ])
})

test('请求前处理器: 没有资产时返回 null,不改请求', async () => {
  reset()
  const fake = createFakeContext()
  await activate(fake.context)

  const handler = fake.handlers[0]
  assert.ok(handler !== undefined)
  assert.equal(handler({ lastUserMessage: 'please keep it short' }), null)
  assert.ok(fake.logs.some((message) => message.includes('没有标签集或策略表')))
})

test('请求前处理器: 只有标签集没有策略表时返回 null', async () => {
  reset()
  const fake = createFakeContext()
  await activate(fake.context)
  setActiveContents(contentsWithoutStrategies())

  const handler = fake.handlers[0]
  assert.ok(handler !== undefined)
  assert.equal(handler({ lastUserMessage: 'please' }), null)
})

test('请求前处理器: 分类器抛错时返回 null 并写日志', () => {
  const logs: string[] = []
  const handler = createBeforeRequestHandler({
    contents: contentsWithAssets,
    classifier: {
      id: 'broken',
      classify: () => {
        throw new Error('classifier exploded')
      },
    },
    log: (message) => {
      logs.push(message)
    },
  })

  assert.equal(handler({ lastUserMessage: 'please' }), null)
  assert.ok(logs.some((message) => message.includes('classifier exploded')))
  assert.equal(logs.length, 1)
})

test('请求前处理器: 策略表给出多个条目时拒绝装配并返回 null', () => {
  const logs: string[] = []
  const contents = contentsWithAssets()
  const handler = createBeforeRequestHandler({
    contents: () => ({
      ...contents,
      strategies: {
        source: sourceOf('dsc-strategies'),
        items: [strategyTable, { ...strategyTable, id: 'strict' }],
      },
    }),
    log: (message) => {
      logs.push(message)
    },
  })

  assert.equal(handler({ lastUserMessage: 'please' }), null)
  assert.ok(logs.some((message) => message.includes('策略表只能有一个条目')))
})

test('deactivate 后可以重新激活并重新注册处理器', async () => {
  reset()

  const first = createFakeContext()
  await activate(first.context)
  deactivate()

  const second = createFakeContext()
  await activate(second.context)
  setActiveContents(contentsWithAssets())

  assert.equal(first.handlers.length, 1)
  assert.equal(second.handlers.length, 1)
  assert.equal(second.handlers[0]?.({ lastUserMessage: 'please' })?.temperature, 0.9)
})
