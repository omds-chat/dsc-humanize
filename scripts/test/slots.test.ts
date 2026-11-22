/**
 * 两个新槽位的接线测试:composer.toolbar 的「人性化」开关与 overlay.notice 的资产状态通知。
 *
 * 覆盖:
 * - 清单 slots 白名单确实声明了三个槽位;
 * - 激活即登记按钮,文案带状态(开),空资产包时登记常驻通知;
 * - 点击 → 开关落盘(独立存储键)→ 按钮同 id 重新登记刷新状态 → 一次气泡;
 * - 关闭时请求前处理器返回 null,再次打开恢复既有补丁;
 * - 存储里关闭的开关在激活时被读到,损坏记录回到缺省(开启);
 * - 来源不可达时登记通知(正文带原因),来源恢复后撤销登记;
 * - 通知构建与资产包可用性判断的纯函数口径。
 *
 * 夹具按宿主语义模拟:同插件同 id 的登记是替换(只留最新一份),
 * 句柄的 dispose 撤销登记;不弹窗、不联网,只读回环形状的假取件表。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { ASSET_NOTICE_ID, ASSET_NOTICE_LEVEL, ASSET_NOTICE_SLOT, buildAssetNotice, inspectAssetContents } from '../../src/slots/asset-notice.ts'
import {
  createRewriteSwitchRecord,
  readRewriteSwitch,
  rewriteToggleNoticeParams,
  buildRewriteButtonDescriptor,
  REWRITE_ACTION_KEY,
  REWRITE_BUTTON_ID,
  REWRITE_SWITCH_DEFAULT,
  REWRITE_SWITCH_SLOT,
  REWRITE_SWITCH_STORAGE_KEY,
  REWRITE_SWITCH_VERSION,
  REWRITE_TOGGLE_NOTICE_KEY,
} from '../../src/slots/rewrite-switch.ts'
import { MARKET_SLOT, MARKET_SLOT_ID, REFRESH_ACTION_KEY } from '../../src/market/page.ts'
import { SETTINGS_PAGE_SLOT } from '../../src/slots/settings-page.ts'
import { manifest } from '../../src/manifest.ts'
import type { AssetContents } from '../../src/humanize/types.ts'
import type {
  ChatBeforeRequestHandler,
  DscMount,
  PluginContext,
  PluginSlotActionHandler,
  PluginSlotActionPayload,
  PluginSlotDataHandler,
  PluginSlotDescriptorBody,
  PluginSlotName,
  PluginSettingDescriptor,
  PluginSettingValue,
} from '../../src/types.ts'

const { activate, deactivate, importAssetPackage, setActiveContents } = await import('../../src/index.ts')

const INNER_URL = 'https://page.test/inner/'
const AWESOME_URL = 'https://page.test/awesome/'

const indexedMeta = JSON.stringify({
  name: 'dsc-humanize-inner-asset',
  indexVersion: '1.0.0',
  assetFormat: { specVersion: '1.0.0', formatVersion: '1.0.0' },
})
const flatMeta = JSON.stringify({ assetSpecVersion: '1.0.0', assetFormatVersion: '1.0.0' })
const innerIndex = JSON.stringify([{ id: 'pkg-a', author: 'omds-chat', tag: [], types: ['persona'] }])
const awesomeIndex = JSON.stringify([{ id: 'pkg-c', author: 'someone', tag: [], types: [] }])

const happyTable = (): Map<string, string | number | null> =>
  new Map([
    [INNER_URL + 'meta.json', indexedMeta],
    [INNER_URL + 'assets.json', innerIndex],
    [AWESOME_URL + 'meta.json', flatMeta],
    [AWESOME_URL + 'assets.json', awesomeIndex],
  ])

/** 够改写用的一份内容:标签集 + 策略表 + 人设,请求前处理器据此给出补丁 */
const contentsWithAssets = (): AssetContents => ({
  persona: { source: { id: 'dsc-persona', version: '1.0.0' }, items: [{ id: 'p1', name: 'Friendly', prefix: 'You are friendly.' }] },
  labels: { source: { id: 'dsc-labels', version: '1.0.0' }, items: [{ id: 'tone', keywords: ['please'] }] },
  strategies: {
    source: { id: 'dsc-strategies', version: '1.0.0' },
    items: [{ id: 'daily', version: 'v1', rules: [{ label: 'tone', strategy: { temperature: 0.9, topP: 0.8 } }] }],
  },
})

/** 一份合法的加载期资产包文档,用来把「资产包为空」这一条原因消掉 */
const packageDocument = (): Record<string, unknown> => ({
  metadata: {
    formatVersion: '1.0.0',
    id: 'dsc-example-asset',
    name: '示例资产包',
    version: '0.1.0',
    description: '测试用包',
    author: 'omds-chat',
    types: ['persona', 'labels', 'strategies'],
  },
  contents: {
    persona: [{ id: 'calm', name: 'Calm', prefix: 'You are calm.' }],
    labels: [{ id: 'tone', keywords: ['please'] }],
    strategies: [{ id: 'daily', version: 'v1', rules: [{ label: 'tone', strategy: { temperature: 0.4 } }] }],
  },
})

/** 已登记的一份槽位;按 (slot, id) 归并,替换时只留最新一份 */
interface SlotRecord {
  slot: PluginSlotName
  descriptor: PluginSlotDescriptorBody
}

interface FakeContext {
  context: PluginContext
  slots: Map<string, SlotRecord>
  registrations: { slot: PluginSlotName; descriptor: PluginSlotDescriptorBody }[]
  actionHandlers: PluginSlotActionHandler[]
  dataHandlers: PluginSlotDataHandler[]
  handlers: ChatBeforeRequestHandler[]
  logs: string[]
  notices: { key: string; params?: Record<string, string | number> }[]
  storageMap: Map<string, unknown>
  reads: string[]
}

const slotKey = (slot: PluginSlotName, id: string): string => slot + '/' + id

const createFakeContext = (table: Map<string, string | number | null>): FakeContext => {
  const slots = new Map<string, SlotRecord>()
  const registrations: { slot: PluginSlotName; descriptor: PluginSlotDescriptorBody }[] = []
  const actionHandlers: PluginSlotActionHandler[] = []
  const dataHandlers: PluginSlotDataHandler[] = []
  const handlers: ChatBeforeRequestHandler[] = []
  const logs: string[] = []
  const notices: { key: string; params?: Record<string, string | number> }[] = []
  const storageMap = new Map<string, unknown>()
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
      registerSlot: (slot, descriptor) => {
        const key = slotKey(slot, descriptor.id)
        const record: SlotRecord = { slot, descriptor }
        slots.set(key, record)
        registrations.push({ slot, descriptor })
        return {
          slot,
          id: descriptor.id,
          dispose: () => {
            // 只撤销自己的那一份:后来的替换登记不该被旧句柄带走
            if (slots.get(key) === record) slots.delete(key)
          },
        }
      },
      onSlotAction: (_slot, handler) => {
        actionHandlers.push(handler)
        return () => undefined
      },
      onSlotData: (_slot, handler) => {
        dataHandlers.push(handler)
        return () => undefined
      },
    },
    settings: {
      locale: () => Promise.resolve('zh-CN'),
      register: (_descriptor: PluginSettingDescriptor) => () => undefined,
      values: (): Record<string, PluginSettingValue> => ({}),
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
      get: (key: string) => (storageMap.has(key) ? storageMap.get(key) : null),
      set: (key: string, value: unknown) => {
        storageMap.set(key, value)
      },
      remove: (key: string) => {
        storageMap.delete(key)
      },
    },
    chat: {
      onBeforeRequest: (handler) => {
        handlers.push(handler)
        return () => undefined
      },
    },
  }

  return { context, slots, registrations, actionHandlers, dataHandlers, handlers, logs, notices, storageMap, reads }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const waitUntil = async (probe: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200 && !probe(); attempt += 1) {
    await sleep(5)
  }
}

/** 引擎按插件只保留一份动作回调,夹具里最后一个登记的就是实际生效的那一份 */
const settledAction = (fake: FakeContext): PluginSlotActionHandler => {
  const handler = fake.actionHandlers[fake.actionHandlers.length - 1]
  assert.ok(handler !== undefined, '动作回调已登记')
  return handler
}

const settledData = (fake: FakeContext): PluginSlotDataHandler => {
  const handler = fake.dataHandlers[fake.dataHandlers.length - 1]
  assert.ok(handler !== undefined, '数据处理器已登记')
  return handler
}

const clickButton = (fake: FakeContext): void => {
  const payload: PluginSlotActionPayload = {
    slot: REWRITE_SWITCH_SLOT,
    id: REWRITE_BUTTON_ID,
    actionId: REWRITE_ACTION_KEY,
  }
  settledAction(fake)(payload)
}

const buttonLabel = (fake: FakeContext): string | undefined => {
  const record = fake.slots.get(slotKey(REWRITE_SWITCH_SLOT, REWRITE_BUTTON_ID))
  if (record === undefined || !('label' in record.descriptor)) return undefined
  return record.descriptor.label
}

const noticeText = (fake: FakeContext): string | undefined => {
  const record = fake.slots.get(slotKey(ASSET_NOTICE_SLOT, ASSET_NOTICE_ID))
  if (record === undefined || !('text' in record.descriptor)) return undefined
  return record.descriptor.text
}

const reset = (): void => {
  deactivate()
  setActiveContents({})
}

test('manifest: slots 白名单声明四个槽位', () => {
  assert.deepEqual(manifest.slots, [MARKET_SLOT, SETTINGS_PAGE_SLOT, REWRITE_SWITCH_SLOT, ASSET_NOTICE_SLOT])
})

test('activate: 登记人性化按钮(文案含状态)与空资产包的常驻通知', async () => {
  reset()
  ;(globalThis as Record<string, unknown>).__INNER_ASSET_PAGES_URL__ = INNER_URL
  ;(globalThis as Record<string, unknown>).__AWESOME_ASSET_PAGES_URL__ = AWESOME_URL
  const fake = createFakeContext(happyTable())
  await activate(fake.context)

  // 按钮:文案是「人性化」加状态,动作键固定
  assert.equal(buttonLabel(fake), '人性化 · 开')
  const button = fake.slots.get(slotKey(REWRITE_SWITCH_SLOT, REWRITE_BUTTON_ID))
  assert.ok(button !== undefined && 'actionKey' in button.descriptor)
  assert.equal(button.descriptor.actionKey, REWRITE_ACTION_KEY)

  // 空资产包:登记一条 overlay.notice,说明原因;只有一个条目、按插件分组由宿主完成
  assert.ok(fake.slots.has(slotKey(ASSET_NOTICE_SLOT, ASSET_NOTICE_ID)))
  assert.ok(String(noticeText(fake)).includes('没有可用的资产包'))
  const notice = fake.slots.get(slotKey(ASSET_NOTICE_SLOT, ASSET_NOTICE_ID))
  assert.ok(notice !== undefined && 'level' in notice.descriptor)
  assert.equal(notice.descriptor.level, ASSET_NOTICE_LEVEL)
  assert.equal(ASSET_NOTICE_LEVEL, 'warning')
  // 资产市场标签仍在(三处落点各自独立)
  assert.ok(fake.slots.has(slotKey(MARKET_SLOT, MARKET_SLOT_ID)))
})

test('点击人性化按钮: 开关落盘、按钮同 id 重新登记为「关」、气泡一次', async () => {
  reset()
  ;(globalThis as Record<string, unknown>).__INNER_ASSET_PAGES_URL__ = INNER_URL
  ;(globalThis as Record<string, unknown>).__AWESOME_ASSET_PAGES_URL__ = AWESOME_URL
  const fake = createFakeContext(happyTable())
  await activate(fake.context)
  assert.equal(fake.storageMap.has(REWRITE_SWITCH_STORAGE_KEY), false)

  clickButton(fake)

  // 落盘:独立键 + 版本化记录
  assert.deepEqual(fake.storageMap.get(REWRITE_SWITCH_STORAGE_KEY), {
    version: REWRITE_SWITCH_VERSION,
    enabled: false,
  })
  // 重新登记(同 id 替换):仍然只有一条 composer.toolbar 登记,文案已变
  assert.equal([...fake.slots.keys()].filter((key) => key.startsWith(REWRITE_SWITCH_SLOT + '/')).length, 1)
  assert.equal(buttonLabel(fake), '人性化 · 关')
  assert.ok(fake.registrations.filter((entry) => entry.slot === REWRITE_SWITCH_SLOT).length >= 2)
  // 一次气泡:宿主文案键 + 状态参数,不用弹窗
  assert.equal(fake.notices.length, 1)
  assert.equal(fake.notices[0]?.key, REWRITE_TOGGLE_NOTICE_KEY)
  assert.deepEqual(fake.notices[0]?.params, { state: '关闭' })
  assert.ok(fake.logs.some((line) => line.includes('资产改写已关闭')))

  // 再点一次回到「开」,存储同步写回
  clickButton(fake)
  assert.deepEqual(fake.storageMap.get(REWRITE_SWITCH_STORAGE_KEY), {
    version: REWRITE_SWITCH_VERSION,
    enabled: true,
  })
  assert.equal(buttonLabel(fake), '人性化 · 开')
  assert.equal(fake.notices.length, 2)
  assert.deepEqual(fake.notices[1]?.params, { state: '开启' })
})

test('开关关闭时请求前处理器返回 null,重新打开恢复既有补丁', async () => {
  reset()
  ;(globalThis as Record<string, unknown>).__INNER_ASSET_PAGES_URL__ = INNER_URL
  ;(globalThis as Record<string, unknown>).__AWESOME_ASSET_PAGES_URL__ = AWESOME_URL
  const fake = createFakeContext(happyTable())
  await activate(fake.context)
  setActiveContents(contentsWithAssets())
  const handler = fake.handlers[0]
  assert.ok(handler !== undefined)

  const before = handler({ lastUserMessage: 'please keep it short' })
  assert.deepEqual(before, { temperature: 0.9, topP: 0.8, systemPromptAppend: 'You are friendly.' })

  clickButton(fake)
  assert.equal(handler({ lastUserMessage: 'please keep it short' }), null)
  assert.ok(fake.logs.some((line) => line.includes('资产改写已关闭,不修改请求')))

  clickButton(fake)
  assert.deepEqual(handler({ lastUserMessage: 'please keep it short' }), before)
})

test('activate: 存储里关闭的开关在激活时读到「关」,请求不改写', async () => {
  reset()
  ;(globalThis as Record<string, unknown>).__INNER_ASSET_PAGES_URL__ = INNER_URL
  ;(globalThis as Record<string, unknown>).__AWESOME_ASSET_PAGES_URL__ = AWESOME_URL
  const fake = createFakeContext(happyTable())
  fake.storageMap.set(REWRITE_SWITCH_STORAGE_KEY, createRewriteSwitchRecord(false))
  await activate(fake.context)
  setActiveContents(contentsWithAssets())

  assert.equal(buttonLabel(fake), '人性化 · 关')
  const handler = fake.handlers[0]
  assert.ok(handler !== undefined)
  assert.equal(handler({ lastUserMessage: 'please keep it short' }), null)
})

test('readRewriteSwitch: 缺键、形状不符与版本不符都回落到缺省(开启)', () => {
  assert.equal(REWRITE_SWITCH_DEFAULT, true)
  assert.equal(readRewriteSwitch(null), true)
  assert.equal(readRewriteSwitch(undefined), true)
  assert.equal(readRewriteSwitch({ version: REWRITE_SWITCH_VERSION, enabled: false }), false)
  assert.equal(readRewriteSwitch({ version: REWRITE_SWITCH_VERSION, enabled: 'no' }), true)
  assert.equal(readRewriteSwitch({ version: 99, enabled: false }), true)
  assert.equal(readRewriteSwitch('false'), true)
  assert.equal(readRewriteSwitch([false]), true)
})

test('按钮描述与气泡参数:文案随状态与语言取一侧', () => {
  assert.equal(buildRewriteButtonDescriptor('zh-CN', true).label, '人性化 · 开')
  assert.equal(buildRewriteButtonDescriptor('zh-CN', false).label, '人性化 · 关')
  assert.equal(buildRewriteButtonDescriptor('en-US', true).label, 'Humanize · on')
  assert.deepEqual(rewriteToggleNoticeParams('zh-CN', false), { state: '关闭' })
  assert.deepEqual(rewriteToggleNoticeParams('en-US', true), { state: 'on' })
})

test('buildAssetNotice: 只在有实际问题时给出通知', () => {
  const usable = contentsWithAssets()
  assert.equal(buildAssetNotice({ contents: usable, sources: { status: 'reachable' } }), null)
  assert.equal(buildAssetNotice({ contents: usable, sources: { status: 'unknown' } }), null)

  const empty = buildAssetNotice({ contents: {}, sources: { status: 'unknown' } })
  assert.ok(empty !== null)
  assert.equal(empty.id, ASSET_NOTICE_ID)
  assert.equal(empty.level, ASSET_NOTICE_LEVEL)
  assert.ok(String(empty.text).includes('没有可用的资产包'))

  const down = buildAssetNotice({
    contents: usable,
    sources: { status: 'unreachable', reason: 'source-unreachable: 该来源的所有地址都无法访问' },
  })
  assert.ok(String(down?.text).includes('资产来源暂不可达'))
  assert.ok(String(down?.text).includes('source-unreachable'))

  // 两个原因同时成立仍然只有一条通知,正文合成一段
  const both = buildAssetNotice({ contents: {}, sources: { status: 'unreachable', reason: 'transport-missing' } })
  assert.ok(String(both?.text).includes('资产来源暂不可达') && String(both?.text).includes('没有可用的资产包'))

  const english = buildAssetNotice({ contents: {}, sources: { status: 'unknown' }, locale: 'en-US' })
  assert.ok(String(english?.text).includes('No asset package'))
})

test('inspectAssetContents: 空包与缺标签集/策略表分开', () => {
  assert.deepEqual(inspectAssetContents({}), { empty: true, missing: [] })
  assert.deepEqual(inspectAssetContents(contentsWithAssets()), { empty: false, missing: [] })
  const partial = inspectAssetContents({
    persona: { source: { id: 'dsc-persona' }, items: [{ id: 'p1', name: 'Friendly', prefix: 'You are friendly.' }] },
  })
  assert.equal(partial.empty, false)
  assert.deepEqual(partial.missing, ['labels', 'strategies'])
  const notice = buildAssetNotice({ contents: {
    persona: { source: { id: 'dsc-persona' }, items: [{ id: 'p1', name: 'Friendly', prefix: 'You are friendly.' }] },
  }, sources: { status: 'reachable' } })
  assert.ok(String(notice?.text).includes('资产包内容不完整'))
  assert.ok(String(notice?.text).includes('标签集') && String(notice?.text).includes('策略表'))
})

test('来源不可达时登记常驻通知,来源恢复后撤销登记', async () => {
  reset()
  ;(globalThis as Record<string, unknown>).__INNER_ASSET_PAGES_URL__ = INNER_URL
  ;(globalThis as Record<string, unknown>).__AWESOME_ASSET_PAGES_URL__ = AWESOME_URL
  // 先让两个来源都取不到任何文件:所有地址都失败
  const table = new Map<string, string | number | null>()
  const fake = createFakeContext(table)
  await activate(fake.context)

  // 先消掉「空资产包」这一条原因,单独观察来源不可达
  const imported = await importAssetPackage(JSON.stringify(packageDocument()))
  assert.equal(imported.ok, true)
  assert.equal(fake.slots.has(slotKey(ASSET_NOTICE_SLOT, ASSET_NOTICE_ID)), false)

  // 打开资产市场标签会触发一次取件:全部失败 → 登记通知
  settledData(fake)(MARKET_SLOT, MARKET_SLOT_ID)
  await waitUntil(() => fake.slots.has(slotKey(ASSET_NOTICE_SLOT, ASSET_NOTICE_ID)))
  assert.ok(fake.slots.has(slotKey(ASSET_NOTICE_SLOT, ASSET_NOTICE_ID)), '来源不可达时应有通知')
  assert.ok(String(noticeText(fake)).includes('资产来源暂不可达'))
  assert.ok(fake.reads.length > 0, '确实尝试过取件')
  assert.ok(fake.logs.some((line) => line.includes('已登记资产状态通知')))

  // 恢复:补齐两个来源的目录,刷新目录后通知撤销
  for (const [url, body] of happyTable()) table.set(url, body)
  settledAction(fake)({ slot: MARKET_SLOT, id: MARKET_SLOT_ID, actionId: REFRESH_ACTION_KEY })
  await waitUntil(() => !fake.slots.has(slotKey(ASSET_NOTICE_SLOT, ASSET_NOTICE_ID)))
  assert.equal(fake.slots.has(slotKey(ASSET_NOTICE_SLOT, ASSET_NOTICE_ID)), false)
  assert.ok(fake.logs.some((line) => line.includes('已撤销资产状态通知')))
})

test('正常状态(有资产包且来源可达)不登记通知', async () => {
  reset()
  ;(globalThis as Record<string, unknown>).__INNER_ASSET_PAGES_URL__ = INNER_URL
  ;(globalThis as Record<string, unknown>).__AWESOME_ASSET_PAGES_URL__ = AWESOME_URL
  const fake = createFakeContext(happyTable())
  await activate(fake.context)
  const imported = await importAssetPackage(JSON.stringify(packageDocument()))
  assert.equal(imported.ok, true)
  assert.equal(fake.slots.has(slotKey(ASSET_NOTICE_SLOT, ASSET_NOTICE_ID)), false)

  // 取件成功后再评估一次:仍然不登记
  settledData(fake)(MARKET_SLOT, MARKET_SLOT_ID)
  await waitUntil(() => fake.reads.filter((url) => url.endsWith('assets.json')).length >= 2)
  await sleep(20)
  assert.equal(fake.slots.has(slotKey(ASSET_NOTICE_SLOT, ASSET_NOTICE_ID)), false)
})
