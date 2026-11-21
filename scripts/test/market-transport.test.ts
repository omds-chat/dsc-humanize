/**
 * 市场传输接线的测试:宿主 assets:read 三态到内核 transport 失败口径的映射,
 * 与激活时的通道注入。全部用内存替身,不发任何真实请求(含本地回环)。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { activate, deactivate, getMarketTransport } from '../../src/index.ts'
import { createAssetLoader } from '../../src/humanize/assets/loader.ts'
import { createHostAssetTransport, pickHostAssets } from '../../src/market/transport.ts'
import type { PluginAssetTextResult, PluginContext } from '../../src/types.ts'

/** 宿主 assets:read 的内存替身:按地址返回三态结果或抛错 */
const createFakeAssets = (table: Map<string, () => Promise<PluginAssetTextResult>>) => ({
  readText: (url: string) => table.get(url)?.() ?? Promise.reject(new Error('assets:read rejected (url): no entry')),
})

test('transport: content 态透传文本', async () => {
  const assets = createFakeAssets(new Map([
    ['https://example.test/a.json', () => Promise.resolve({ kind: 'content', url: 'https://example.test/a.json', contentType: 'application/json', text: '{"ok":true}' })],
  ]))
  const transport = createHostAssetTransport(assets)
  assert.equal(await transport.readText('https://example.test/a.json'), '{"ok":true}')
})

test('transport: status 态按 3.x 口径降级,该地址不可用', async () => {
  const assets = createFakeAssets(new Map([
    ['https://example.test/404', () => Promise.resolve({ kind: 'status', url: 'https://example.test/404', status: 404 })],
  ]))
  const transport = createHostAssetTransport(assets)
  await assert.rejects(transport.readText('https://example.test/404'), (error: Error) => {
    assert.ok(error.message.includes('状态码 404'))
    assert.ok(error.message.includes('不可用'))
    return true
  })
})

test('transport: no-status 态按 6.3 不说成地址无效', async () => {
  const assets = createFakeAssets(new Map([
    ['https://example.test/blocked', () => Promise.resolve({ kind: 'no-status', url: 'https://example.test/blocked' })],
  ]))
  const transport = createHostAssetTransport(assets)
  await assert.rejects(transport.readText('https://example.test/blocked'), (error: Error) => {
    assert.ok(error.message.includes('无法判定'))
    return true
  })
})

test('transport: 通道拒绝也转成失败,原因可排查', async () => {
  const assets = createFakeAssets(new Map([
    ['ftp://x/y', () => Promise.reject(new Error('dsc-core: assets:read rejected (protocol): target must use https'))],
  ]))
  const transport = createHostAssetTransport(assets)
  await assert.rejects(transport.readText('ftp://x/y'), (error: Error) => {
    assert.ok(error.message.includes('拒绝了本次调用'))
    assert.ok(error.message.includes('protocol'))
    return true
  })
})

test('loader: 三态经由 transport 注入映射成内核错误码', async () => {
  const assets = createFakeAssets(new Map([
    ['https://example.test/good', () => Promise.resolve({ kind: 'content', url: '', contentType: '', text: '{"metadata":{"formatVersion":"1.0.0","id":"p","version":"0.1.0","types":["persona"]},"contents":{"persona":[{"id":"x","name":"X","prefix":"P"}]}}' })],
    ['https://example.test/status', () => Promise.resolve({ kind: 'status', url: '', status: 500 })],
    ['https://example.test/nostatus', () => Promise.resolve({ kind: 'no-status', url: '' })],
  ]))
  const transport = createHostAssetTransport(assets)
  const loader = createAssetLoader({ transport })

  const good = await loader.load({ kind: 'url', url: 'https://example.test/good' })
  assert.equal(good.ok, true)

  const status = await loader.load({ kind: 'url', url: 'https://example.test/status' })
  assert.equal(status.ok, false)
  if (!status.ok) assert.equal(status.error.code, 'transport-failed')

  const noStatus = await loader.load({ kind: 'url', url: 'https://example.test/nostatus' })
  assert.equal(noStatus.ok, false)
  if (!noStatus.ok) assert.equal(noStatus.error.code, 'transport-failed')
})

test('loader: 未注入 transport 时保持 transport-missing', async () => {
  const loader = createAssetLoader()
  const result = await loader.load({ kind: 'url', url: 'https://example.test/x' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'transport-missing')
})

test('pickHostAssets: 成员缺失或形态不符时按缺失处理', () => {
  assert.equal(pickHostAssets({}), null)
  assert.equal(pickHostAssets({ assets: {} }), null)
  assert.equal(pickHostAssets({ assets: { readText: () => Promise.resolve({ kind: 'no-status', url: '' }) } }) !== null, true)
  assert.equal(pickHostAssets(null), null)
})

/** 带 assets 成员的最小激活上下文,通道由替身提供 */
const createContextWithAssets = (assets: ReturnType<typeof createFakeAssets>, logs: string[]): PluginContext => ({
  id: 'dsc-humanize',
  version: '0.1.0',
  log: (message) => {
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
  assets,
  net: { getText: () => Promise.resolve({ url: '', contentType: '', text: '' }), postJson: () => Promise.resolve({ url: '', status: 200 }) },
  storage: { get: () => null, set: () => undefined, remove: () => undefined },
  chat: { onBeforeRequest: () => () => undefined },
})

test('activate: 有 assets 成员时注入通道,停用时断开', async () => {
  deactivate()
  const logs: string[] = []
  const context = createContextWithAssets(createFakeAssets(new Map()), logs)
  await activate(context)
  assert.notEqual(getMarketTransport(), null)
  assert.ok(logs.some((message) => message.includes('已接入宿主 assets:read 读取通道')))
  deactivate()
  assert.equal(getMarketTransport(), null)
})

test('activate: 宿主没有 assets 成员时保持现状,通道为 null', async () => {
  deactivate()
  const logs: string[] = []
  const context = createContextWithAssets(createFakeAssets(new Map()), logs)
  const legacy = context as PluginContext & { assets?: unknown }
  const withoutAssets: PluginContext = { ...legacy, assets: undefined as unknown as PluginContext['assets'] }
  await activate(withoutAssets)
  assert.equal(getMarketTransport(), null)
  assert.ok(logs.some((message) => message.includes('宿主未提供 assets:read 读取通道')))
  deactivate()
})
