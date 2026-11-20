import assert from 'node:assert/strict'
import test from 'node:test'

import { createAssetLoader, readAssetBundle } from '../../src/humanize/assets/loader.ts'
import type { AssetTextTransport } from '../../src/humanize/types.ts'

/** 一份能通过校验的最小资产包 */
const validBundle = (): Record<string, unknown> => ({
  schemaVersion: '0.1.0',
  labels: [{ id: 'tone', keywords: ['please'], weight: 1 }],
  strategies: { version: 'v1', rules: [{ label: 'tone', strategy: { temperature: 0.6 } }] },
})

const expectFailure = (value: unknown, code: string, path?: string): void => {
  const result = readAssetBundle(value)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, code)
  if (path !== undefined) assert.equal(result.error.path, path)
}

/* ---------- 结构校验 ---------- */

test('readAssetBundle: 合法资产包收敛成内核结构', () => {
  const result = readAssetBundle(validBundle())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.bundle.schemaVersion, '0.1.0')
  assert.equal(result.bundle.labels.length, 1)
  assert.equal(result.bundle.labels[0]?.id, 'tone')
  assert.equal(result.bundle.strategies.version, 'v1')
  assert.equal(result.bundle.persona, undefined)
})

test('readAssetBundle: 人物设定按原样收下', () => {
  const result = readAssetBundle({
    ...validBundle(),
    persona: { id: 'p1', name: 'Calm', prefix: 'You are calm.' },
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.bundle.persona, { id: 'p1', name: 'Calm', prefix: 'You are calm.' })
})

test('readAssetBundle: 资产格式未定版,多出的字段被忽略', () => {
  const result = readAssetBundle({
    ...validBundle(),
    extra: true,
    labels: [{ id: 'tone', keywords: ['please'], extra: 1 }],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal('extra' in result.bundle, false)
  assert.deepEqual(Object.keys(result.bundle), ['schemaVersion', 'labels', 'strategies'])
})

test('readAssetBundle: 非对象直接拒绝', () => {
  for (const value of [null, [], 'text']) {
    expectFailure(value, 'invalid-asset')
  }
})

test('readAssetBundle: 缺少 schemaVersion 时给出字段路径', () => {
  const { schemaVersion: _ignored, ...rest } = validBundle()
  expectFailure(rest, 'invalid-asset', 'schemaVersion')
})

test('readAssetBundle: labels 必须是非空数组', () => {
  expectFailure({ ...validBundle(), labels: [] }, 'invalid-asset', 'labels')
})

test('readAssetBundle: 标签缺少 id 时报出下标', () => {
  expectFailure({ ...validBundle(), labels: [{}] }, 'invalid-asset', 'labels[0].id')
})

test('readAssetBundle: 标签 id 重复时拒绝', () => {
  const result = readAssetBundle({
    ...validBundle(),
    labels: [{ id: 'a' }, { id: 'a' }],
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.path, 'labels[1].id')
  assert.match(result.error.message, /重复/)
})

test('readAssetBundle: 标签字段类型校验', () => {
  const base = validBundle()
  expectFailure({ ...base, labels: [{ id: 'a', description: 1 }] }, 'invalid-asset', 'labels[0].description')
  expectFailure({ ...base, labels: [{ id: 'a', keywords: [1] }] }, 'invalid-asset', 'labels[0].keywords')
  expectFailure({ ...base, labels: [{ id: 'a', weight: 0 }] }, 'invalid-asset', 'labels[0].weight')
})

test('readAssetBundle: strategies 必须是对象', () => {
  const { strategies: _ignored, ...rest } = validBundle()
  expectFailure(rest, 'invalid-asset', 'strategies')
})

test('readAssetBundle: strategies.version 必须非空', () => {
  expectFailure({
    ...validBundle(),
    strategies: { version: ' ', rules: [] },
  }, 'invalid-asset', 'strategies.version')
})

test('readAssetBundle: strategies.rules 必须是数组', () => {
  expectFailure({
    ...validBundle(),
    strategies: { version: 'v1', rules: {} },
  }, 'invalid-asset', 'strategies.rules')
})

test('readAssetBundle: 规则缺少 label 时报出下标', () => {
  expectFailure({
    ...validBundle(),
    strategies: { version: 'v1', rules: [{}] },
  }, 'invalid-asset', 'strategies.rules[0].label')
})

test('readAssetBundle: 规则引用未定义的标签时拒绝', () => {
  const result = readAssetBundle({
    ...validBundle(),
    strategies: { version: 'v1', rules: [{ label: 'unknown', strategy: { temperature: 0.5 } }] },
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.path, 'strategies.rules[0].label')
  assert.match(result.error.message, /未定义/)
})

test('readAssetBundle: 规则缺少 strategy 时拒绝', () => {
  expectFailure({
    ...validBundle(),
    strategies: { version: 'v1', rules: [{ label: 'tone' }] },
  }, 'invalid-asset', 'strategies.rules[0].strategy')
})

test('readAssetBundle: 取值范围交给策略表校验', () => {
  const result = readAssetBundle({
    ...validBundle(),
    strategies: { version: 'v1', rules: [{ label: 'tone', strategy: { temperature: 9 } }] },
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.path, 'strategies')
  assert.match(result.error.message, /strategies\.rules\[0\]\.strategy\.temperature/)
})

test('readAssetBundle: 规则没有任何策略字段时拒绝', () => {
  const result = readAssetBundle({
    ...validBundle(),
    strategies: { version: 'v1', rules: [{ label: 'tone', strategy: {} }] },
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.path, 'strategies')
  assert.match(result.error.message, /至少要有/)
})

test('readAssetBundle: 人物设定字段校验', () => {
  const base = validBundle()
  expectFailure({ ...base, persona: 'p' }, 'invalid-asset', 'persona')
  expectFailure({ ...base, persona: { id: ' ', name: 'n', prefix: 'x' } }, 'invalid-asset', 'persona.id')
  expectFailure({ ...base, persona: { id: 'p', prefix: 'x' } }, 'invalid-asset', 'persona.name')
  expectFailure({ ...base, persona: { id: 'p', name: 'n', prefix: 1 } }, 'invalid-asset', 'persona.prefix')
})

/* ---------- 加载通道 ---------- */

test('createAssetLoader: 本地数据直接校验', async () => {
  const loader = createAssetLoader()
  const result = await loader.load({ kind: 'inline', data: validBundle() })
  assert.equal(loader.id, 'asset-loader')
  assert.equal(result.ok, true)
})

test('createAssetLoader: 本地数据不合法时返回失败结果而不抛错', async () => {
  const loader = createAssetLoader()
  const result = await loader.load({ kind: 'inline', data: { schemaVersion: '0.1.0' } })
  assert.equal(result.ok, false)
})

test('createAssetLoader: 没有 URL 通道时以 transport-missing 失败', async () => {
  const loader = createAssetLoader()
  const result = await loader.load({ kind: 'url', url: 'https://example.test/asset.json' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'transport-missing')
  assert.match(result.error.message, /https:\/\/example\.test\/asset\.json/)
})

test('createAssetLoader: URL 通道抛错时以 transport-failed 失败', async () => {
  const transport: AssetTextTransport = {
    readText: () => Promise.reject(new Error('boom')),
  }
  const loader = createAssetLoader({ transport })
  const result = await loader.load({ kind: 'url', url: 'https://example.test/asset.json' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'transport-failed')
  assert.match(result.error.message, /boom/)
})

test('createAssetLoader: 通道返回的内容不是 JSON 时以 invalid-json 失败', async () => {
  const transport: AssetTextTransport = {
    readText: () => Promise.resolve('not json'),
  }
  const loader = createAssetLoader({ transport })
  const result = await loader.load({ kind: 'url', url: 'https://example.test/asset.json' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'invalid-json')
})

test('createAssetLoader: 通道返回的 JSON 不合法时以 invalid-asset 失败', async () => {
  const transport: AssetTextTransport = {
    readText: () => Promise.resolve(JSON.stringify({ schemaVersion: '0.1.0' })),
  }
  const loader = createAssetLoader({ transport })
  const result = await loader.load({ kind: 'url', url: 'https://example.test/asset.json' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'invalid-asset')
})

test('createAssetLoader: URL 通道收到地址与调用选项', async () => {
  const controller = new AbortController()
  const calls: { url: string; signal: AbortSignal | undefined }[] = []
  const transport: AssetTextTransport = {
    readText: (url, options) => {
      calls.push({ url, signal: options?.signal })
      return Promise.resolve(JSON.stringify(validBundle()))
    },
  }
  const loader = createAssetLoader({ transport })
  const result = await loader.load(
    { kind: 'url', url: 'https://example.test/asset.json' },
    { signal: controller.signal },
  )
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, 'https://example.test/asset.json')
  assert.equal(calls[0]?.signal, controller.signal)
})
