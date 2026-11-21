import assert from 'node:assert/strict'
import test from 'node:test'

import { createAssetLoader, readAssetPackage } from '../../src/humanize/assets/loader.ts'
import type { AssetPackageDocument, AssetTextTransport } from '../../src/humanize/types.ts'

/** 包元数据的最小形状,字段取格式规范要求的最小合法值 */
const metadata = (types: readonly string[]): Record<string, unknown> => ({
  formatVersion: '1.0.0',
  id: 'dsc-example-asset',
  name: '示例资产包',
  version: '0.1.0',
  description: '测试用包',
  author: 'omds-chat',
  types: [...types],
})

const ALL_TYPES = ['persona', 'labels', 'strategies', 'injection'] as const

/** 用元数据与类型内容拼一份加载期包文档 */
const document = (
  types: readonly string[],
  contents: Record<string, unknown>,
): AssetPackageDocument => ({ metadata: metadata(types), contents })

/** 一份四类齐全、能通过校验的最小包文档 */
const validDocument = (): AssetPackageDocument => document(ALL_TYPES, {
  persona: [{ id: 'calm', name: 'Calm', prefix: 'You are calm.' }],
  labels: [{ id: 'tone', keywords: ['please'], weight: 1 }],
  strategies: [{
    id: 'daily',
    version: '1.0.0',
    rules: [{ label: 'tone', strategy: { temperature: 0.6 } }],
  }],
  injection: [{ id: 'brief', name: 'Brief', text: 'Be brief.' }],
})

const persona = { id: 'calm', name: 'Calm', prefix: 'You are calm.' }

const expectFailure = (value: unknown, code: string, path?: string): void => {
  const result = readAssetPackage(value)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, code)
  if (path !== undefined) assert.equal(result.error.path, path)
}

/* ---------- 按类型读取 ---------- */

test('readAssetPackage: 合法包按类型收下,每一类带来源标识', () => {
  const result = readAssetPackage(validDocument())
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.equal(result.asset.formatVersion, '1.0.0')
  assert.deepEqual(result.asset.source, { id: 'dsc-example-asset', version: '0.1.0' })
  assert.deepEqual(result.asset.types, ['persona', 'labels', 'strategies', 'injection'])
  assert.deepEqual(result.asset.contents.persona?.items, [persona])
  assert.deepEqual(result.asset.contents.labels?.source, { id: 'dsc-example-asset', version: '0.1.0' })
  assert.deepEqual(result.asset.contents.strategies?.items?.[0]?.id, 'daily')
  assert.deepEqual(result.asset.contents.injection?.items, [
    { id: 'brief', name: 'Brief', text: 'Be brief.' },
  ])
})

test('readAssetPackage: 每类允许多个条目,标识在同一类型内唯一', () => {
  const result = readAssetPackage(document(ALL_TYPES, {
    persona: [persona, { id: 'dry', name: 'Dry', prefix: 'You are dry.' }],
    labels: [{ id: 'tone' }, { id: 'topic' }, { id: 'mood' }],
    strategies: [
      { id: 'daily', version: '1.0.0', rules: [{ label: 'tone', strategy: { temperature: 0.5 } }] },
      { id: 'strict', version: '0.9.0', rules: [] },
    ],
    injection: [
      { id: 'brief', name: 'Brief', text: 'Be brief.' },
      { id: 'warm', name: 'Warm', text: 'Be warm.' },
    ],
  }))

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.asset.contents.persona?.items.length, 2)
  assert.equal(result.asset.contents.labels?.items.length, 3)
  assert.equal(result.asset.contents.strategies?.items.length, 2)
  assert.equal(result.asset.contents.injection?.items.length, 2)
})

test('readAssetPackage: 只声明人物设定的包合法', () => {
  const result = readAssetPackage(document(['persona'], { persona: [persona] }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.asset.types, ['persona'])
  assert.deepEqual(Object.keys(result.asset.contents), ['persona'])
})

test('readAssetPackage: 只声明策略规则的包合法,标签引用留待装配判定', () => {
  const result = readAssetPackage(document(['strategies'], {
    strategies: [{
      id: 'daily',
      version: '1.0.0',
      rules: [{ label: 'tone', strategy: { temperature: 0.5 } }],
    }],
  }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.asset.contents.strategies?.items[0]?.rules.length, 1)
})

test('readAssetPackage: 只有兜底策略、规则数组为空的策略表合法', () => {
  const result = readAssetPackage(document(['strategies'], {
    strategies: [{ id: 'base-only', version: '1.0.0', base: { temperature: 0.4 }, rules: [] }],
  }))
  assert.equal(result.ok, true)
})

test('readAssetPackage: 包内声明标签集时,规则只能引用包内标签', () => {
  expectFailure(document(['labels', 'strategies'], {
    labels: [{ id: 'tone' }],
    strategies: [{
      id: 'daily',
      version: '1.0.0',
      rules: [{ label: 'unknown', strategy: { temperature: 0.5 } }],
    }],
  }), 'invalid-asset', 'contents.strategies[0].rules[0].label')
})

/* ---------- 声明与内容双向一致 ---------- */

test('readAssetPackage: 声明了某类却给不出条目时整包拒绝', () => {
  expectFailure(
    document(['persona', 'labels'], { persona: [persona] }),
    'invalid-asset',
    'contents.labels',
  )
})

test('readAssetPackage: 声明了某类却给出空集合时整包拒绝', () => {
  expectFailure(document(['labels'], { labels: [] }), 'invalid-asset', 'contents.labels')
})

test('readAssetPackage: 有内容却没声明时整包拒绝', () => {
  expectFailure(
    document(['persona'], { persona: [persona], labels: [{ id: 'tone' }] }),
    'invalid-asset',
    'contents.labels',
  )
})

test('readAssetPackage: 内容出现四类之外的类型时整包拒绝', () => {
  expectFailure(
    document(['persona'], { persona: [persona], tone: [] }),
    'invalid-asset',
    'contents.tone',
  )
})

test('readAssetPackage: 类型声明必须非空且限于四类', () => {
  expectFailure(document([], {}), 'invalid-asset', 'metadata.types')
  expectFailure(document(['tone'], {}), 'invalid-asset', 'metadata.types[0]')
  expectFailure(
    document(['persona', 'persona'], { persona: [persona] }),
    'invalid-asset',
    'metadata.types[1]',
  )
})

/* ---------- 元数据与包文档 ---------- */

test('readAssetPackage: 包文档或元数据不是对象时拒绝', () => {
  for (const value of [null, [], 'text']) {
    expectFailure(value, 'invalid-asset')
  }
  expectFailure({ contents: {} }, 'invalid-asset', 'metadata')
})

test('readAssetPackage: 格式版本、包标识与包版本必须是非空字符串', () => {
  const base = metadata(ALL_TYPES)
  const contents = validDocument().contents
  expectFailure({ metadata: { ...base, formatVersion: ' ' }, contents }, 'invalid-asset', 'metadata.formatVersion')
  expectFailure({ metadata: { ...base, id: '' }, contents }, 'invalid-asset', 'metadata.id')
  expectFailure({ metadata: { ...base, version: 1 }, contents }, 'invalid-asset', 'metadata.version')
})

test('readAssetPackage: contents 不是对象时拒绝', () => {
  expectFailure({ metadata: metadata(['persona']), contents: [] }, 'invalid-asset', 'contents')
  expectFailure({ metadata: metadata(['persona']) }, 'invalid-asset', 'contents')
})

test('readAssetPackage: 只保留内核消费的字段', () => {
  const result = readAssetPackage({
    metadata: { ...metadata(['labels']), extra: 'x' },
    contents: { labels: [{ id: 'a', keywords: ['k'], extra: 1 }] },
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(Object.keys(result.asset), ['formatVersion', 'source', 'types', 'contents'])
  assert.deepEqual(result.asset.contents.labels?.items[0], { id: 'a', keywords: ['k'] })
  assert.equal('extra' in result.asset, false)
})

/* ---------- 条目字段 ---------- */

test('readAssetPackage: 同一类型内的条目标识重复时拒绝', () => {
  expectFailure(document(['persona'], { persona: [persona, persona] }), 'invalid-asset', 'contents.persona[1].id')
  expectFailure(document(['labels'], { labels: [{ id: 'a' }, { id: 'a' }] }), 'invalid-asset', 'contents.labels[1].id')
  expectFailure(document(['strategies'], {
    strategies: [
      { id: 'a', version: '1.0.0', rules: [] },
      { id: 'a', version: '1.0.0', rules: [] },
    ],
  }), 'invalid-asset', 'contents.strategies[1].id')
  expectFailure(document(['injection'], {
    injection: [
      { id: 'a', name: 'A', text: 'A' },
      { id: 'a', name: 'B', text: 'B' },
    ],
  }), 'invalid-asset', 'contents.injection[1].id')
})

test('readAssetPackage: 标签字段校验', () => {
  const labels = (value: unknown): AssetPackageDocument => document(['labels'], { labels: value })
  expectFailure(labels([{}]), 'invalid-asset', 'contents.labels[0].id')
  expectFailure(labels([{ id: 'a', description: 1 }]), 'invalid-asset', 'contents.labels[0].description')
  expectFailure(labels([{ id: 'a', keywords: [1] }]), 'invalid-asset', 'contents.labels[0].keywords')
  expectFailure(labels([{ id: 'a', weight: 0 }]), 'invalid-asset', 'contents.labels[0].weight')
})

test('readAssetPackage: 人物设定字段校验', () => {
  const personas = (value: unknown): AssetPackageDocument => document(['persona'], { persona: value })
  expectFailure(personas(['p']), 'invalid-asset', 'contents.persona[0]')
  expectFailure(personas([{ id: ' ' }]), 'invalid-asset', 'contents.persona[0].id')
  expectFailure(personas([{ id: 'p', prefix: 'x' }]), 'invalid-asset', 'contents.persona[0].name')
  expectFailure(personas([{ id: 'p', name: 'n' }]), 'invalid-asset', 'contents.persona[0].prefix')
  expectFailure(personas([{ id: 'p', name: 'n', prefix: ' ' }]), 'invalid-asset', 'contents.persona[0].prefix')
  expectFailure(personas([{ id: 'p', name: 'n', prefix: 'x', description: 1 }]), 'invalid-asset', 'contents.persona[0].description')
})

test('readAssetPackage: 注入文本字段校验', () => {
  const fragments = (value: unknown): AssetPackageDocument => document(['injection'], { injection: value })
  expectFailure(fragments([{}]), 'invalid-asset', 'contents.injection[0].id')
  expectFailure(fragments([{ id: 'a', text: 't' }]), 'invalid-asset', 'contents.injection[0].name')
  expectFailure(fragments([{ id: 'a', name: 'n' }]), 'invalid-asset', 'contents.injection[0].text')
  expectFailure(fragments([{ id: 'a', name: 'n', text: ' ' }]), 'invalid-asset', 'contents.injection[0].text')
  expectFailure(fragments([{ id: 'a', name: 'n', text: 't', description: 1 }]), 'invalid-asset', 'contents.injection[0].description')
})

test('readAssetPackage: 策略规则结构校验', () => {
  const strategies = (value: unknown): AssetPackageDocument => document(['strategies'], { strategies: value })
  expectFailure(strategies([{ id: 'a', version: '1.0.0', rules: {} }]), 'invalid-asset', 'contents.strategies[0].rules')
  expectFailure(strategies([{ id: 'a', version: '1.0.0', rules: [{}] }]), 'invalid-asset', 'contents.strategies[0].rules[0].label')
  expectFailure(strategies([{ id: 'a', version: '1.0.0', rules: [{ label: 'tone' }] }]), 'invalid-asset', 'contents.strategies[0].rules[0].strategy')
  expectFailure(strategies([{ id: 'a', version: '1.0.0', base: 'base', rules: [] }]), 'invalid-asset', 'contents.strategies[0].base')
  expectFailure(strategies([{ id: 'a', version: ' ', rules: [] }]), 'invalid-asset', 'contents.strategies[0].version')
  expectFailure(strategies([{ id: ' ', version: '1.0.0', rules: [] }]), 'invalid-asset', 'contents.strategies[0].id')
})

test('readAssetPackage: 策略表的取值范围交给策略表校验', () => {
  const result = readAssetPackage(document(['strategies'], {
    strategies: [{
      id: 'a',
      version: '1.0.0',
      rules: [{ label: 'tone', strategy: { temperature: 9 } }],
    }],
  }))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.path, 'contents.strategies[0]')
  assert.match(result.error.message, /strategies\.rules\[0\]\.strategy\.temperature/)
})

test('readAssetPackage: 规则没有任何策略字段时拒绝', () => {
  const result = readAssetPackage(document(['strategies'], {
    strategies: [{ id: 'a', version: '1.0.0', rules: [{ label: 'tone', strategy: {} }] }],
  }))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.path, 'contents.strategies[0]')
  assert.match(result.error.message, /至少要有/)
})

/* ---------- 加载通道 ---------- */

test('createAssetLoader: 本地数据直接读取', async () => {
  const loader = createAssetLoader()
  const result = await loader.load({ kind: 'inline', data: validDocument() })
  assert.equal(loader.id, 'asset-loader')
  assert.equal(result.ok, true)
})

test('createAssetLoader: 本地数据不合法时返回失败结果而不抛错', async () => {
  const loader = createAssetLoader()
  const result = await loader.load({ kind: 'inline', data: document(['persona'], {}) })
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
    readText: () => Promise.resolve(JSON.stringify({ metadata: {} })),
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
      return Promise.resolve(JSON.stringify(validDocument()))
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
