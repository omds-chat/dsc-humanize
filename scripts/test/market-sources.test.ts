/**
 * 市场来源模型的测试:地址判定(设计 2.5)、注入地址的回退(2.2)、
 * 设置开关与自建来源成对字段(2.1、2.3)。全部内存构造,不发请求。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  builtinCollectionIds,
  marketSettingDescriptor,
  normalizeSourceBaseUrl,
  resolveMarketSources,
  SETTING_KEYS,
} from '../../src/market/sources.ts'

const injected = globalThis as { __INNER_ASSET_PAGES_URL__?: string; __AWESOME_ASSET_PAGES_URL__?: string }

test('sources: 地址判定只放行 https 与回环 http,去查询哈希补尾斜杠', () => {
  assert.equal(normalizeSourceBaseUrl('https://omds-chat.github.io/dsc-humanize-inner-asset'), 'https://omds-chat.github.io/dsc-humanize-inner-asset/')
  assert.equal(normalizeSourceBaseUrl('http://127.0.0.1:61120/?x=1#frag'), 'http://127.0.0.1:61120/')
  assert.equal(normalizeSourceBaseUrl('http://localhost:61121'), 'http://localhost:61121/')
  assert.equal(normalizeSourceBaseUrl('http://[::1]:61121/'), 'http://[::1]:61121/')
  assert.equal(normalizeSourceBaseUrl('http://192.168.1.10:61121/'), null)
  assert.equal(normalizeSourceBaseUrl('ftp://example.test/'), null)
  assert.equal(normalizeSourceBaseUrl('not a url'), null)
  assert.equal(normalizeSourceBaseUrl('   '), null)
})

test('sources: 未注入本地地址时只用线上地址,两条内置来源齐全', () => {
  injected.__INNER_ASSET_PAGES_URL__ = ''
  injected.__AWESOME_ASSET_PAGES_URL__ = ''
  const resolved = resolveMarketSources(null)
  assert.equal(resolved.notes.length, 0)
  assert.equal(resolved.sources.length, 2)
  const inner = resolved.sources[0]
  assert.equal(inner?.id, 'dsc-humanize-inner-asset')
  assert.deepEqual(inner?.baseUrls, ['https://omds-chat.github.io/dsc-humanize-inner-asset/'])
  const awesome = resolved.sources[1]
  assert.equal(awesome?.baseUrls.length, 3)
  assert.equal(awesome?.baseUrls[0], 'https://cdn.jsdelivr.net/gh/omds-chat/awesome-dsc-humanize-asset@main/')
})

test('sources: 注入的本地地址排在最前,非法注入退回线上', () => {
  injected.__INNER_ASSET_PAGES_URL__ = 'http://127.0.0.1:61120'
  injected.__AWESOME_ASSET_PAGES_URL__ = 'http://172.20.0.5:61121'
  const resolved = resolveMarketSources(null)
  assert.equal(resolved.sources[0]?.baseUrls[0], 'http://127.0.0.1:61120/')
  assert.equal(resolved.sources[1]?.baseUrls[0], 'https://cdn.jsdelivr.net/gh/omds-chat/awesome-dsc-humanize-asset@main/')
  assert.ok(resolved.notes.some((note) => note.includes('awesome-dsc-humanize-asset') && note.includes('非法')))
  injected.__INNER_ASSET_PAGES_URL__ = ''
  injected.__AWESOME_ASSET_PAGES_URL__ = ''
})

test('sources: 内置开关关闭时保留来源但置为禁用,不发请求', () => {
  const resolved = resolveMarketSources({
    [SETTING_KEYS.innerSourceEnabled]: false,
    [SETTING_KEYS.awesomeSourceEnabled]: true,
  })
  assert.equal(resolved.sources[0]?.enabled, false)
  assert.equal(resolved.sources[1]?.enabled, true)
})

test('sources: 开关取值形态不符时按缺省启用处理', () => {
  const resolved = resolveMarketSources({ [SETTING_KEYS.innerSourceEnabled]: 'yes' })
  assert.equal(resolved.sources[0]?.enabled, true)
})

test('sources: 自建来源 URL 与合集 id 成对才生效,排在内置之后', () => {
  const resolved = resolveMarketSources({
    [SETTING_KEYS.customSourceUrl]: 'https://assets.example.test/mine/',
    [SETTING_KEYS.customSourceId]: 'my-own-asset',
  })
  assert.equal(resolved.sources.length, 3)
  const custom = resolved.sources[2]
  assert.equal(custom?.id, 'my-own-asset')
  assert.equal(custom?.builtin, false)
  assert.deepEqual(custom?.baseUrls, ['https://assets.example.test/mine/'])
})

test('sources: 自建来源缺一半、id 不合法、与内置同 id、地址非法都整条忽略并留原因', () => {
  const half = resolveMarketSources({ [SETTING_KEYS.customSourceUrl]: 'https://assets.example.test/mine/' })
  assert.equal(half.sources.length, 2)
  assert.ok(half.notes.some((note) => note.includes('成对')))

  const badId = resolveMarketSources({
    [SETTING_KEYS.customSourceUrl]: 'https://assets.example.test/mine/',
    [SETTING_KEYS.customSourceId]: 'My Asset',
  })
  assert.equal(badId.sources.length, 2)
  assert.ok(badId.notes.some((note) => note.includes('合集 id 不合法')))

  const collision = resolveMarketSources({
    [SETTING_KEYS.customSourceUrl]: 'https://assets.example.test/mine/',
    [SETTING_KEYS.customSourceId]: builtinCollectionIds()[0] ?? '',
  })
  assert.equal(collision.sources.length, 2)
  assert.ok(collision.notes.some((note) => note.includes('与内置来源相同')))

  const badUrl = resolveMarketSources({
    [SETTING_KEYS.customSourceUrl]: 'http://nas.local:61130/',
    [SETTING_KEYS.customSourceId]: 'my-own-asset',
  })
  assert.equal(badUrl.sources.length, 2)
  assert.ok(badUrl.notes.some((note) => note.includes('地址不合法')))
})

test('sources: 设置字段描述与键一致,自建 id 字段允许空串与合集 id 形状', () => {
  const keys = marketSettingDescriptor.fields.map((field) => field.key)
  assert.deepEqual(keys, Object.values(SETTING_KEYS))
  const idField = marketSettingDescriptor.fields.find((field) => field.key === SETTING_KEYS.customSourceId)
  const pattern = new RegExp(idField?.pattern ?? '')
  assert.equal(pattern.test(''), true)
  assert.equal(pattern.test('my-own-asset'), true)
  assert.equal(pattern.test('My Asset'), false)
})
