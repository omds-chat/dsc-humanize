/**
 * settings.page 槽位(资产来源设置页)的接线测试。
 *
 * 覆盖:
 * - 清单 slots 白名单声明了 settings.page;
 * - 激活即登记设置页:id 为 asset-sources、标题「资产来源」、order 100,
 *   区块是 form(字段与 marketSettingDescriptor.fields 同一份)+ text(保存口径)+ actions(保存);
 * - 保存动作把表单值写入插件存储,下一次取件按新来源解析(关掉的来源不发请求,
 *   新增的自建来源开始取件);
 * - 保存记录在下一次激活时读到,并回填设置页表单字段的默认值;
 * - 表单收敛与存储读取的口径:未知键与非标量丢弃、版本不符按没有保存值处理、
 *   保存值优先于宿主设置值。
 *
 * 夹具按宿主语义模拟:同插件同 id 的登记是替换(只留最新一份);不弹窗、不联网,
 * 只读回环形状的假取件表。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSettingsPageDescriptor,
  createAssetSourcesRecord,
  mergeSourceValues,
  readAssetSourcesRecord,
  readSourcesFormValues,
  SAVE_SOURCES_ACTION_KEY,
  SETTINGS_PAGE_ID,
  SETTINGS_PAGE_LABELS,
  SETTINGS_PAGE_ORDER,
  SETTINGS_PAGE_RECORD_VERSION,
  SETTINGS_PAGE_SLOT,
  SETTINGS_PAGE_STORAGE_KEY,
} from '../../src/slots/settings-page.ts'
import { marketSettingDescriptor, SETTING_KEYS } from '../../src/market/sources.ts'
import { MARKET_SLOT, MARKET_SLOT_ID } from '../../src/market/page.ts'
import { manifest } from '../../src/manifest.ts'
import type {
  ChatBeforeRequestHandler,
  DscMount,
  PluginContext,
  PluginSlotActionHandler,
  PluginSlotDescriptorBody,
  PluginSlotDataHandler,
  PluginSlotName,
  PluginSettingDescriptor,
  PluginSettingValue,
} from '../../src/types.ts'

const { activate, deactivate } = await import('../../src/index.ts')

const INNER_URL = 'https://settings.test/inner/'
const AWESOME_URL = 'https://settings.test/awesome/'
const CUSTOM_URL = 'https://settings.test/custom/'

const indexedMeta = JSON.stringify({
  name: 'dsc-humanize-inner-asset',
  indexVersion: '1.0.0',
  assetFormat: { specVersion: '1.0.0', formatVersion: '1.0.0' },
})
const flatMeta = JSON.stringify({ assetSpecVersion: '1.0.0', assetFormatVersion: '1.0.0' })
const emptyIndex = JSON.stringify([])

const happyTable = (): Map<string, string | number | null> =>
  new Map([
    [INNER_URL + 'meta.json', indexedMeta],
    [INNER_URL + 'assets.json', emptyIndex],
    [AWESOME_URL + 'meta.json', flatMeta],
    [AWESOME_URL + 'assets.json', emptyIndex],
    [CUSTOM_URL + 'meta.json', flatMeta],
    [CUSTOM_URL + 'assets.json', emptyIndex],
  ])

/** 已登记的一份槽位;按 (slot, id) 归并,替换时只留最新一份 */
interface SlotRecord {
  slot: PluginSlotName
  descriptor: PluginSlotDescriptorBody
}

interface FakeContext {
  context: PluginContext
  slots: Map<string, SlotRecord>
  actionHandlers: PluginSlotActionHandler[]
  dataHandlers: PluginSlotDataHandler[]
  logs: string[]
  storageMap: Map<string, unknown>
  reads: string[]
  /** 宿主设置表面的生效值,按需改写 */
  hostValues: Record<string, PluginSettingValue>
}

const slotKey = (slot: PluginSlotName, id: string): string => slot + '/' + id

const createFakeContext = (
  table: Map<string, string | number | null>,
  storageMap: Map<string, unknown> = new Map<string, unknown>(),
): FakeContext => {
  const slots = new Map<string, SlotRecord>()
  const actionHandlers: PluginSlotActionHandler[] = []
  const dataHandlers: PluginSlotDataHandler[] = []
  const logs: string[] = []
  const reads: string[] = []
  const hostValues: Record<string, PluginSettingValue> = {}

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
      notify: () => undefined,
      registerSlot: (slot, descriptor) => {
        const key = slotKey(slot, descriptor.id)
        const record: SlotRecord = { slot, descriptor }
        slots.set(key, record)
        return {
          slot,
          id: descriptor.id,
          dispose: () => {
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
      values: (): Record<string, PluginSettingValue> => ({ ...hostValues }),
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
      onBeforeRequest: (_handler: ChatBeforeRequestHandler) => () => undefined,
    },
  }

  return { context, slots, actionHandlers, dataHandlers, logs, storageMap, reads, hostValues }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const waitUntil = async (probe: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200 && !probe(); attempt += 1) {
    await sleep(5)
  }
}

/** 引擎按插件只保留一份动作回调与一份数据处理器;夹具里最后一个登记的就是生效的那一份 */
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

const settingsPageRecord = (fake: FakeContext): SlotRecord | undefined =>
  fake.slots.get(slotKey(SETTINGS_PAGE_SLOT, SETTINGS_PAGE_ID))

const reset = (): void => {
  deactivate()
}

const setInjectedUrls = (): void => {
  ;(globalThis as Record<string, unknown>).__INNER_ASSET_PAGES_URL__ = INNER_URL
  ;(globalThis as Record<string, unknown>).__AWESOME_ASSET_PAGES_URL__ = AWESOME_URL
}

test('manifest: slots 白名单声明四个槽位,settings.page 在列', () => {
  assert.deepEqual(manifest.slots, [MARKET_SLOT, SETTINGS_PAGE_SLOT, 'composer.toolbar', 'overlay.notice'])
})

test('activate: 登记资产来源设置页,form 字段与设置描述同一份', async () => {
  reset()
  setInjectedUrls()
  const fake = createFakeContext(happyTable())
  await activate(fake.context)

  const record = settingsPageRecord(fake)
  assert.ok(record !== undefined, '设置页已登记')
  const descriptor = record.descriptor
  assert.equal(descriptor.id, SETTINGS_PAGE_ID)
  assert.equal(SETTINGS_PAGE_ID, 'asset-sources')
  assert.ok('title' in descriptor)
  assert.equal(descriptor.title, '资产来源')
  assert.equal(descriptor.title, SETTINGS_PAGE_LABELS['zh-CN'])
  assert.ok('order' in descriptor && descriptor.order === 100)
  assert.equal(SETTINGS_PAGE_ORDER, 100)
  assert.ok('blocks' in descriptor)
  assert.deepEqual(
    descriptor.blocks.map((block) => block.type),
    ['form', 'text', 'actions'],
  )

  // form 区块:四个字段与 settings:surface 的描述完全一致(键、类型、标签、缺省都同一份)
  const form = descriptor.blocks[0]
  assert.ok(form?.type === 'form')
  assert.equal(form.fields.length, 4)
  assert.deepEqual(form.fields, marketSettingDescriptor.fields)
  assert.deepEqual(
    form.fields.map((field) => field.key),
    [SETTING_KEYS.innerSourceEnabled, SETTING_KEYS.awesomeSourceEnabled, SETTING_KEYS.customSourceUrl, SETTING_KEYS.customSourceId],
  )

  // text 区块:既有口径,改动即时生效但不落盘,保存走本页的保存动作
  const note = descriptor.blocks[1]
  assert.ok(note?.type === 'text')
  assert.ok(note.text.includes('即时生效'))
  assert.ok(note.text.includes('不落盘'))
  assert.ok(note.text.includes('保存来源配置'))
  assert.ok(note.text.length <= 2000)

  // actions 区块:保存来源配置
  const actions = descriptor.blocks[2]
  assert.ok(actions?.type === 'actions')
  assert.equal(actions.items.length, 1)
  assert.equal(actions.items[0]?.key, SAVE_SOURCES_ACTION_KEY)
  assert.ok(String(actions.items[0]?.label).includes('保存'))

  assert.ok(fake.logs.some((line) => line.includes('已登记资产来源设置页')))
})

test('保存动作: 写入插件存储,下一次取件按新来源解析', async () => {
  reset()
  setInjectedUrls()
  const fake = createFakeContext(happyTable())
  await activate(fake.context)
  assert.equal(fake.storageMap.has(SETTINGS_PAGE_STORAGE_KEY), false)
  assert.deepEqual(fake.reads, [])

  // 关掉组织预设来源,新增一条自建来源;表单草稿随动作载荷交给插件
  const response = settledAction(fake)({
    slot: SETTINGS_PAGE_SLOT,
    id: SETTINGS_PAGE_ID,
    actionId: SAVE_SOURCES_ACTION_KEY,
    form: {
      [SETTING_KEYS.innerSourceEnabled]: false,
      [SETTING_KEYS.awesomeSourceEnabled]: true,
      [SETTING_KEYS.customSourceUrl]: CUSTOM_URL,
      [SETTING_KEYS.customSourceId]: 'local-collection',
      'not-a-setting-key': 'ignored',
    },
  })
  assert.deepEqual(response, { refresh: true })

  // 落盘:独立存储键 + 版本化记录;未知键不进存储
  const stored = fake.storageMap.get(SETTINGS_PAGE_STORAGE_KEY)
  assert.deepEqual(stored, {
    version: SETTINGS_PAGE_RECORD_VERSION,
    values: {
      [SETTING_KEYS.innerSourceEnabled]: false,
      [SETTING_KEYS.awesomeSourceEnabled]: true,
      [SETTING_KEYS.customSourceUrl]: CUSTOM_URL,
      [SETTING_KEYS.customSourceId]: 'local-collection',
    },
  })
  assert.ok(fake.logs.some((line) => line.includes('已保存来源配置')))

  // 下一次取件:关掉的来源不发请求,新增的自建来源开始取件
  settledData(fake)(MARKET_SLOT, MARKET_SLOT_ID)
  await waitUntil(() => fake.reads.some((url) => url.startsWith(CUSTOM_URL) && url.endsWith('assets.json')))
  assert.equal(fake.reads.some((url) => url.startsWith(INNER_URL)), false, '关掉的来源不取件')
  assert.ok(fake.reads.some((url) => url.startsWith(AWESOME_URL)), '开启的内置来源照常取件')
  assert.ok(fake.reads.some((url) => url.startsWith(CUSTOM_URL)), '自建来源开始取件')
})

test('保存记录在下次激活时读到,并回填设置页表单的默认值', async () => {
  reset()
  setInjectedUrls()
  const storageMap = new Map<string, unknown>()
  const first = createFakeContext(happyTable(), storageMap)
  await activate(first.context)
  settledAction(first)({
    slot: SETTINGS_PAGE_SLOT,
    id: SETTINGS_PAGE_ID,
    actionId: SAVE_SOURCES_ACTION_KEY,
    form: {
      [SETTING_KEYS.innerSourceEnabled]: false,
      [SETTING_KEYS.customSourceUrl]: CUSTOM_URL,
      [SETTING_KEYS.customSourceId]: 'local-collection',
    },
  })
  deactivate()

  // 同一个插件存储的第二次激活:保存值参与解析,表单默认值随生效值回填
  const second = createFakeContext(happyTable(), storageMap)
  await activate(second.context)
  const model = settledData(second)(SETTINGS_PAGE_SLOT, SETTINGS_PAGE_ID)
  assert.ok(model !== null && model !== undefined)
  assert.equal(model.slot, SETTINGS_PAGE_SLOT)
  assert.equal(model.id, SETTINGS_PAGE_ID)
  const form = model.blocks[0]
  assert.ok(form?.type === 'form')
  const byKey = new Map(form.fields.map((field) => [field.key, field]))
  assert.equal(byKey.get(SETTING_KEYS.innerSourceEnabled)?.default, false)
  assert.equal(byKey.get(SETTING_KEYS.customSourceUrl)?.default, CUSTOM_URL)
  assert.equal(byKey.get(SETTING_KEYS.customSourceId)?.default, 'local-collection')
  // 没保存过的字段仍按设置描述的缺省值
  assert.equal(byKey.get(SETTING_KEYS.awesomeSourceEnabled)?.default, true)
  // 字段的键、类型与标签与设置描述一致,只有 default 被换成了生效值
  for (const field of form.fields) {
    const source = marketSettingDescriptor.fields.find((item) => item.key === field.key)
    assert.ok(source !== undefined)
    assert.equal(field.type, source.type)
    assert.equal(field.label, source.label)
  }

  // 取件按保存值解析:关掉的来源不发请求
  settledData(second)(MARKET_SLOT, MARKET_SLOT_ID)
  await waitUntil(() => second.reads.some((url) => url.startsWith(CUSTOM_URL)))
  assert.equal(second.reads.some((url) => url.startsWith(INNER_URL)), false)
})

test('保存动作不带可用表单值时不写存储', async () => {
  reset()
  setInjectedUrls()
  const fake = createFakeContext(happyTable())
  await activate(fake.context)

  const response = settledAction(fake)({
    slot: SETTINGS_PAGE_SLOT,
    id: SETTINGS_PAGE_ID,
    actionId: SAVE_SOURCES_ACTION_KEY,
    form: { 'not-a-setting-key': 'ignored', [SETTING_KEYS.innerSourceEnabled]: { nested: true } as unknown as PluginSettingValue },
  })
  assert.deepEqual(response, { refresh: true })
  assert.equal(fake.storageMap.has(SETTINGS_PAGE_STORAGE_KEY), false)
  assert.ok(fake.logs.some((line) => line.includes('没有带可用的表单值')))
})

test('readSourcesFormValues: 只留设置字段的键与标量', () => {
  assert.equal(readSourcesFormValues(undefined), null)
  assert.equal(readSourcesFormValues({}), null)
  assert.equal(readSourcesFormValues({ other: 'x' }), null)
  assert.deepEqual(readSourcesFormValues({
    [SETTING_KEYS.innerSourceEnabled]: false,
    [SETTING_KEYS.customSourceId]: 'abc',
    extra: 'ignored',
    [SETTING_KEYS.customSourceUrl]: null,
  }), {
    [SETTING_KEYS.innerSourceEnabled]: false,
    [SETTING_KEYS.customSourceId]: 'abc',
  })
})

test('readAssetSourcesRecord: 形状与版本不符都回落到没有保存值', () => {
  assert.equal(readAssetSourcesRecord(null), null)
  assert.equal(readAssetSourcesRecord('x'), null)
  assert.equal(readAssetSourcesRecord({ version: 99, values: { [SETTING_KEYS.innerSourceEnabled]: false } }), null)
  assert.equal(readAssetSourcesRecord({ version: SETTINGS_PAGE_RECORD_VERSION, values: 'x' }), null)
  assert.equal(readAssetSourcesRecord({ version: SETTINGS_PAGE_RECORD_VERSION, values: { other: true } }), null)
  assert.deepEqual(
    readAssetSourcesRecord({
      version: SETTINGS_PAGE_RECORD_VERSION,
      values: { [SETTING_KEYS.innerSourceEnabled]: false, other: 'ignored' },
    }),
    { [SETTING_KEYS.innerSourceEnabled]: false },
  )
  // 写入与读取往返一致
  const record = createAssetSourcesRecord({ [SETTING_KEYS.customSourceId]: 'abc', other: 'x' } as unknown as Record<string, PluginSettingValue>)
  assert.deepEqual(readAssetSourcesRecord(record), { [SETTING_KEYS.customSourceId]: 'abc' })
})

test('mergeSourceValues: 保存值优先于宿主设置值', () => {
  assert.equal(mergeSourceValues(null, null), null)
  assert.deepEqual(mergeSourceValues(null, { a: 1 }), { a: 1 })
  assert.deepEqual(mergeSourceValues({ a: 2 }, null), { a: 2 })
  assert.deepEqual(mergeSourceValues({ a: 2 }, { a: 1, b: 3 }), { a: 2, b: 3 })
})

test('buildSettingsPageDescriptor: 标题按语言取一侧,字段缺省随生效值', () => {
  const zh = buildSettingsPageDescriptor('zh-CN')
  const en = buildSettingsPageDescriptor('en-US')
  assert.equal(zh.title, '资产来源')
  assert.equal(en.title, 'Asset sources')
  assert.equal(zh.order, SETTINGS_PAGE_ORDER)
  assert.deepEqual(zh.blocks[0], { id: 'sources', type: 'form', fields: marketSettingDescriptor.fields })

  // 生效值回填:同形才替换 default,不同形保留原缺省
  const filled = buildSettingsPageDescriptor('zh-CN', {
    [SETTING_KEYS.innerSourceEnabled]: false,
    [SETTING_KEYS.customSourceUrl]: 'https://x.test/',
    [SETTING_KEYS.customSourceId]: 42 as unknown as PluginSettingValue,
  })
  const form = filled.blocks[0]
  assert.ok(form?.type === 'form')
  const byKey = new Map(form.fields.map((field) => [field.key, field]))
  assert.equal(byKey.get(SETTING_KEYS.innerSourceEnabled)?.default, false)
  assert.equal(byKey.get(SETTING_KEYS.customSourceUrl)?.default, 'https://x.test/')
  // 类型不同形的值不回填,免得宿主按字段类型校验后整份拒绝
  assert.equal(byKey.get(SETTING_KEYS.customSourceId)?.default, '')
})
