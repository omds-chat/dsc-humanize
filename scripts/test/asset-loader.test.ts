import assert from 'node:assert/strict'
import test from 'node:test'

import { createAssetLoader, readAssetContents, readAssetPackage } from '../../src/humanize/assets/loader.ts'
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

/* ---------- 对比示例(1.1.0 第五类,规范 7.5) ---------- */

/** 1.1.0 格式版本的包文档构造器:1.1.0 特性的用例统一用它 */
const document110 = (types: readonly string[], contents: Record<string, unknown>): AssetPackageDocument => ({
  metadata: { ...metadata(types), formatVersion: '1.1.0' },
  contents,
})

const exampleItem = {
  id: 'over-brief-contrast',
  name: '简洁边界对比',
  description: '用正反例约束回答何时该短',
  cases: [
    {
      scene: '一句话能答完的事实问题',
      negative: '这个问题其实可以从多个角度来看……',
      positive: '支持。需要细节的话我再展开三点。',
    },
    { negative: '你好!很高兴见到你!……', positive: '你好,在的。说吧。' },
  ],
}

test('readAssetPackage: 只声明 examples 的纯对比示例包合法', () => {
  const result = readAssetPackage(document110(['examples'], { examples: [exampleItem] }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.asset.types, ['examples'])
  assert.deepEqual(result.asset.contents.examples?.items, [exampleItem])
})

test('readAssetPackage: 五类齐全的包合法', () => {
  const result = readAssetPackage(document110(
    [...ALL_TYPES, 'examples'],
    { ...validDocument().contents, examples: [exampleItem] },
  ))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.asset.types, [...ALL_TYPES, 'examples'])
})

test('readAssetPackage: 对比示例字段校验', () => {
  const examples = (value: unknown): AssetPackageDocument => document110(['examples'], { examples: value })
  expectFailure(examples(['x']), 'invalid-asset', 'contents.examples[0]')
  expectFailure(examples([{ id: 'a' }]), 'invalid-asset', 'contents.examples[0].name')
  expectFailure(examples([{ id: 'a', name: 'n' }]), 'invalid-asset', 'contents.examples[0].cases')
  expectFailure(examples([{ id: 'a', name: 'n', cases: [] }]), 'invalid-asset', 'contents.examples[0].cases')
  expectFailure(examples([{ id: 'a', name: 'n', cases: [{}] }]), 'invalid-asset', 'contents.examples[0].cases[0].negative')
  expectFailure(examples([{ id: 'a', name: 'n', cases: [{ negative: 'n' }] }]), 'invalid-asset', 'contents.examples[0].cases[0].positive')
  expectFailure(examples([{ id: 'a', name: 'n', cases: [{ positive: 'p' }] }]), 'invalid-asset', 'contents.examples[0].cases[0].negative')
  expectFailure(examples([{ id: 'a', name: 'n', cases: [{ scene: ' ', negative: 'n', positive: 'p' }] }]), 'invalid-asset', 'contents.examples[0].cases[0].scene')
  expectFailure(examples([{ id: 'a', name: 'n', cases: [{ scene: 's', negative: ' ', positive: 'p' }] }]), 'invalid-asset', 'contents.examples[0].cases[0].negative')
  expectFailure(examples([{ id: 'a', name: 'n', cases: [{ scene: 's', negative: 'n', positive: 'p' }] }, { id: 'a', name: 'm', cases: [{ negative: 'n', positive: 'p' }] }]), 'invalid-asset', 'contents.examples[1].id')
})

test('readAssetPackage: 已装配内容里的 examples 照常收下', () => {
  const result = readAssetContents({
    examples: { source: { id: 'dsc-contrast' }, items: [exampleItem] },
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.contents.examples?.source, { id: 'dsc-contrast' })
})

/* ---------- 标签新字段的结构校验(1.1.0,规范 7.2) ---------- */

test('readAssetPackage: 合法的排除词与锚定模式照常收下', () => {
  const result = readAssetPackage(document110(['labels'], {
    labels: [{
      id: 'code-help',
      keywords: ['代码', '报错', '依赖'],
      exclude_keywords: ['安装依赖', '卸载依赖'],
      patterns: ['^帮我(写|改|看).*(代码|脚本)$'],
    }],
  }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.asset.contents.labels?.items[0], {
    id: 'code-help',
    keywords: ['代码', '报错', '依赖'],
    exclude_keywords: ['安装依赖', '卸载依赖'],
    patterns: ['^帮我(写|改|看).*(代码|脚本)$'],
  })
})

test('readAssetPackage: exclude_keywords 结构不合法时拒绝', () => {
  const labels = (value: unknown): AssetPackageDocument => document(['labels'], { labels: value })
  expectFailure(labels([{ id: 'a', exclude_keywords: ['x', ''] }]), 'invalid-asset', 'contents.labels[0].exclude_keywords')
  expectFailure(labels([{ id: 'a', exclude_keywords: [1] }]), 'invalid-asset', 'contents.labels[0].exclude_keywords')
  expectFailure(labels([{ id: 'a', exclude_keywords: ['dup', 'dup'] }]), 'invalid-asset', 'contents.labels[0].exclude_keywords')
})

test('readAssetPackage: 排除词与关键词重复时拒绝', () => {
  expectFailure(document(['labels'], {
    labels: [{ id: 'a', keywords: ['依赖'], exclude_keywords: ['依赖'] }],
  }), 'invalid-asset', 'contents.labels[0].exclude_keywords')
})

test('readAssetPackage: patterns 结构不合法时拒绝,且先于版本门判定', () => {
  const labels = (value: unknown): AssetPackageDocument => document(['labels'], { labels: value })
  expectFailure(labels([{ id: 'a', patterns: ['帮我写.*$'] }]), 'invalid-asset', 'contents.labels[0].patterns[0]')
  expectFailure(labels([{ id: 'a', patterns: ['^帮我写.*'] }]), 'invalid-asset', 'contents.labels[0].patterns[0]')
  expectFailure(labels([{ id: 'a', patterns: ['^帮我(?i)写.*$'] }]), 'invalid-asset', 'contents.labels[0].patterns[0]')
  expectFailure(labels([{ id: 'a', patterns: ['^帮我写[代码$'] }]), 'invalid-asset', 'contents.labels[0].patterns[0]')
  expectFailure(labels([{ id: 'a', patterns: ['^a$', '^a$'] }]), 'invalid-asset', 'contents.labels[0].patterns[1]')
})

/* ---------- 特性按版本判定(规范第八节、第十节) ---------- */

const metadata110 = (types: readonly string[]): Record<string, unknown> => ({
  ...metadata(types),
  formatVersion: '1.1.0',
})

test('readAssetPackage: 1.0.0 包声明 examples 时按 format-version-feature 拒绝', () => {
  expectFailure(
    document(['examples'], { examples: [exampleItem] }),
    'format-version-feature',
    'metadata.types',
  )
})

test('readAssetPackage: 1.0.0 包声明 exclude_keywords 时按 format-version-feature 拒绝', () => {
  expectFailure(
    document(['labels'], { labels: [{ id: 'a', keywords: ['k'], exclude_keywords: ['x'] }] }),
    'format-version-feature',
    'contents.labels[0].exclude_keywords',
  )
})

test('readAssetPackage: 1.0.0 包声明 patterns 时按 format-version-feature 拒绝', () => {
  expectFailure(
    document(['labels'], { labels: [{ id: 'a', patterns: ['^a$'] }] }),
    'format-version-feature',
    'contents.labels[0].patterns',
  )
})

test('readAssetPackage: 1.0.0 包声明 dimension 时按 format-version-feature 拒绝', () => {
  expectFailure(
    document(['strategies'], {
      strategies: [{
        id: 'daily',
        version: '1.0.0',
        rules: [{ label: 'tone', dimension: 'length', strategy: { temperature: 0.5 } }],
      }],
    }),
    'format-version-feature',
    'contents.strategies[0].rules[0].dimension',
  )
})

test('readAssetPackage: 1.1.0 包的 1.1.0 特性全部放行', () => {
  const result = readAssetPackage({
    metadata: metadata110(['labels', 'strategies', 'examples']),
    contents: {
      labels: [{ id: 'a', keywords: ['k'], exclude_keywords: ['x'], patterns: ['^a$'] }],
      strategies: [{
        id: 'daily',
        version: '1.1.0',
        rules: [{ label: 'a', dimension: 'language', strategy: { injection: '语言要求。' } }],
      }],
      examples: [exampleItem],
    },
  })
  assert.equal(result.ok, true)
})

test('readAssetPackage: formatVersion 不是三段数字时拒绝', () => {
  expectFailure(
    { metadata: { ...metadata(['persona']), formatVersion: '1.0' }, contents: { persona: [persona] } },
    'invalid-asset',
    'metadata.formatVersion',
  )
  expectFailure(
    { metadata: { ...metadata(['persona']), formatVersion: 'latest' }, contents: { persona: [persona] } },
    'invalid-asset',
    'metadata.formatVersion',
  )
})

test('readAssetPackage: 主版本不同的包按 format-version-unsupported 拒绝', () => {
  const legacy = { ...metadata(['persona']), formatVersion: '2.0.0' }
  expectFailure(
    { metadata: legacy, contents: { persona: [persona] } },
    'format-version-unsupported',
    'metadata.formatVersion',
  )
})
