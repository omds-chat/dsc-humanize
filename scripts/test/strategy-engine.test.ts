import assert from 'node:assert/strict'
import test from 'node:test'

import {
  composeInjection,
  normalizeStop,
  resolveStrategy,
  validateStrategyTable,
} from '../../src/humanize/strategy/engine.ts'
import type { IntentLabel, StrategyRule, StrategyTable } from '../../src/humanize/types.ts'

/** 一条能通过校验的最小策略表 */
const validTable = (): StrategyTable => ({
  id: 'daily',
  version: 'v1',
  rules: [{ label: 'tone', strategy: { temperature: 0.5 } }],
})

const table = (value: StrategyTable): StrategyTable => value

const labels = (...items: [string, number][]): IntentLabel[] =>
  items.map(([label, confidence]) => ({ label, confidence }))

/* ---------- 校验 ---------- */

test('validateStrategyTable: 合法策略表返回空数组', () => {
  assert.deepEqual(validateStrategyTable(validTable()), [])
})

test('validateStrategyTable: 标识为空时报错', () => {
  const value = { ...validTable(), id: '   ' }
  assert.deepEqual(validateStrategyTable(value), ['strategies.id 不能为空'])
})

test('validateStrategyTable: 版本为空时报错', () => {
  const value = { ...validTable(), version: '   ' }
  assert.deepEqual(validateStrategyTable(value), ['strategies.version 不能为空'])
})

test('validateStrategyTable: 规则数组允许为空', () => {
  assert.deepEqual(validateStrategyTable({ id: 'daily', version: 'v1', rules: [] }), [])
  assert.deepEqual(
    validateStrategyTable({ id: 'daily', version: 'v1', base: { temperature: 0.5 }, rules: [] }),
    [],
  )
})

test('validateStrategyTable: 兜底策略越界时报错', () => {
  const value = table({
    id: 'daily',
    version: 'v1',
    base: { temperature: 3 },
    rules: validTable().rules,
  })
  assert.deepEqual(validateStrategyTable(value), ['strategies.base.temperature 须为 0 到 2 的有限数'])
})

test('validateStrategyTable: 规则 label 为空时报错', () => {
  const value = table({
    id: 'daily',
    version: 'v1',
    rules: [{ label: '  ', strategy: { temperature: 0.5 } }],
  })
  assert.deepEqual(validateStrategyTable(value), ['strategies.rules[0].label 不能为空'])
})

test('validateStrategyTable: priority 与 minConfidence 越界时报错', () => {
  const value = table({
    id: 'daily',
    version: 'v1',
    rules: [
      { label: 'a', priority: Number.NaN, minConfidence: 1.5, strategy: { temperature: 0.5 } },
    ],
  })
  assert.deepEqual(validateStrategyTable(value), [
    'strategies.rules[0].priority 须为有限数',
    'strategies.rules[0].minConfidence 须为 0 到 1 的有限数',
  ])
})

test('validateStrategyTable: temperature 与 topP 越界时报错', () => {
  const value = table({
    id: 'daily',
    version: 'v1',
    rules: [{ label: 'a', strategy: { temperature: -1, topP: 1.5 } }],
  })
  assert.deepEqual(validateStrategyTable(value), [
    'strategies.rules[0].strategy.temperature 须为 0 到 2 的有限数',
    'strategies.rules[0].strategy.topP 须为 0 到 1 的有限数',
  ])
})

test('validateStrategyTable: maxTokens 必须是范围内的整数', () => {
  const cases = [0, 2.5, 40000]
  for (const value of cases) {
    const problems = validateStrategyTable(table({
      id: 'daily',
      version: 'v1',
      rules: [{ label: 'a', strategy: { maxTokens: value } }],
    }))
    assert.deepEqual(problems, ['strategies.rules[0].strategy.maxTokens 须为 1 到 32768 的整数'])
  }
})

test('validateStrategyTable: stop 必须是字符串数组', () => {
  const value = table({
    id: 'daily',
    version: 'v1',
    rules: [{ label: 'a', strategy: { stop: 'stop' as unknown as readonly string[] } }],
  })
  assert.deepEqual(validateStrategyTable(value), ['strategies.rules[0].strategy.stop 必须是字符串数组'])
})

test('validateStrategyTable: 空白的 injection 被拒绝', () => {
  const value = table({
    id: 'daily',
    version: 'v1',
    rules: [{ label: 'a', strategy: { injection: '   ' } }],
  })
  assert.deepEqual(validateStrategyTable(value), [
    'strategies.rules[0].strategy.injection 必须是非空字符串,不注入时省略该字段',
  ])
})

test('validateStrategyTable: 没有任何字段的策略被拒绝', () => {
  const value = table({ id: 'daily', version: 'v1', rules: [{ label: 'a', strategy: {} }] })
  assert.deepEqual(validateStrategyTable(value), [
    'strategies.rules[0].strategy 至少要有 temperature、topP、maxTokens、stop、injection 之一',
  ])
})

test('validateStrategyTable: 一次报告全部问题', () => {
  const value = table({ id: '  ', version: '', base: { topP: 2 }, rules: [] })
  assert.deepEqual(validateStrategyTable(value), [
    'strategies.id 不能为空',
    'strategies.version 不能为空',
    'strategies.base.topP 须为 0 到 1 的有限数',
  ])
})

/* ---------- 合并 ---------- */

test('resolveStrategy: 先合并兜底策略,再按 priority 升序覆盖', () => {
  const value = table({
    id: 'daily',
    version: 'v1',
    base: { temperature: 0.5 },
    rules: [
      { label: 'a', priority: 2, strategy: { temperature: 1.0 } },
      { label: 'b', priority: 1, strategy: { temperature: 0.9 } },
    ],
  })
  const resolved = resolveStrategy(value, labels(['a', 0.9], ['b', 0.9]))
  assert.equal(resolved.strategy.temperature, 1.0)
  assert.deepEqual(resolved.matched, ['b', 'a'])
  assert.equal(resolved.tableVersion, 'v1')
})

test('resolveStrategy: priority 相同时按声明顺序合并', () => {
  const value = table({
    id: 'daily',
    version: 'v1',
    rules: [
      { label: 'x', strategy: { temperature: 0.4 } },
      { label: 'y', strategy: { temperature: 0.6 } },
    ],
  })
  const resolved = resolveStrategy(value, labels(['x', 0.9], ['y', 0.9]))
  assert.deepEqual(resolved.matched, ['x', 'y'])
  assert.equal(resolved.strategy.temperature, 0.6)
})

test('resolveStrategy: 未命中的标签不参与合并', () => {
  const value = table({
    id: 'daily',
    version: 'v1',
    rules: [
      { label: 'a', strategy: { temperature: 0.3 } },
      { label: 'zzz', strategy: { temperature: 1.9 } },
    ],
  })
  const resolved = resolveStrategy(value, labels(['a', 0.9]))
  assert.deepEqual(resolved.matched, ['a'])
  assert.equal(resolved.strategy.temperature, 0.3)
})

test('resolveStrategy: 规则自身的 minConfidence 生效', () => {
  const value = table({
    id: 'daily',
    version: 'v1',
    rules: [{ label: 'a', minConfidence: 0.6, strategy: { temperature: 0.7 } }],
  })
  const resolved = resolveStrategy(value, labels(['a', 0.5]))
  assert.deepEqual(resolved.matched, [])
  assert.equal(resolved.strategy.temperature, null)
})

test('resolveStrategy: 调用参数给出的置信度下限与规则取较大值', () => {
  const value = table({
    id: 'daily',
    version: 'v1',
    rules: [{ label: 'a', strategy: { temperature: 0.7 } }],
  })
  const resolved = resolveStrategy(value, labels(['a', 0.5]), { minConfidence: 0.8 })
  assert.deepEqual(resolved.matched, [])
  assert.equal(resolved.strategy.temperature, null)
})

test('resolveStrategy: 同一标签出现多次时取最高置信度', () => {
  const value = table({
    id: 'daily',
    version: 'v1',
    rules: [{ label: 'a', minConfidence: 0.6, strategy: { temperature: 0.7 } }],
  })
  const resolved = resolveStrategy(value, labels(['a', 0.4], ['a', 0.8]))
  assert.deepEqual(resolved.matched, ['a'])
  assert.equal(resolved.strategy.temperature, 0.7)
})

test('resolveStrategy: stop 去重并保持首次出现的顺序', () => {
  const value = table({
    id: 'daily',
    version: 'v1',
    base: { stop: [' ok ', '', 'ok', 'stop'] },
    rules: [{ label: 'a', strategy: { stop: ['alt', 'alt '] } }],
  })
  const resolved = resolveStrategy(value, labels(['a', 0.9]))
  assert.deepEqual(resolved.strategy.stop, ['alt'])
})

test('resolveStrategy: 数值越界按边界收敛而不是丢弃', () => {
  const value = table({
    id: 'daily',
    version: 'v1',
    base: { temperature: 5, topP: -1, maxTokens: 99999 },
    rules: [{ label: 'a', strategy: { temperature: -3, topP: 2, maxTokens: 3.6 } }],
  })
  const resolved = resolveStrategy(value, labels(['a', 0.9]))
  assert.equal(resolved.strategy.temperature, 0)
  assert.equal(resolved.strategy.topP, 1)
  assert.equal(resolved.strategy.maxTokens, 4)
})

test('resolveStrategy: 兜底策略的数值同样收敛到边界', () => {
  const value = table({
    id: 'daily',
    version: 'v1',
    base: { temperature: 5, topP: -1, maxTokens: 99999 },
    rules: [{ label: 'a', strategy: { stop: ['x'] } }],
  })
  const resolved = resolveStrategy(value, labels(['a', 0.9]))
  assert.equal(resolved.strategy.temperature, 2)
  assert.equal(resolved.strategy.topP, 0)
  assert.equal(resolved.strategy.maxTokens, 32768)
})

test('resolveStrategy: injection 去掉首尾空白,空值不覆盖已有注入', () => {
  const value = table({
    id: 'daily',
    version: 'v1',
    base: { injection: 'base text' },
    rules: [
      { label: 'a', strategy: { injection: '   ' } },
      { label: 'b', strategy: { injection: '  rule text  ' } },
    ],
  })
  const blank = resolveStrategy(value, labels(['a', 0.9]))
  assert.equal(blank.strategy.injection, 'base text')

  const trimmed = resolveStrategy(value, labels(['b', 0.9]))
  assert.equal(trimmed.strategy.injection, 'rule text')
})

test('resolveStrategy: 没有任何命中时返回空策略', () => {
  const value = table({ id: 'daily', version: 'v9', rules: [{ label: 'a', strategy: { temperature: 0.7 } }] })
  const resolved = resolveStrategy(value, labels())
  assert.deepEqual(resolved.strategy, {
    temperature: null,
    topP: null,
    maxTokens: null,
    stop: [],
    injection: '',
  })
  assert.deepEqual(resolved.matched, [])
  assert.equal(resolved.tableVersion, 'v9')
})

/* ---------- 停止词 ---------- */

test('normalizeStop: 去空白、去空串、去重并保持顺序', () => {
  assert.deepEqual(normalizeStop([' b ', 'a', '', '   ', 'b', 'c']), ['b', 'a', 'c'])
})

test('normalizeStop: 空输入返回空数组', () => {
  assert.deepEqual(normalizeStop([]), [])
})

/* ---------- 维度合成(1.1.0,规范 7.3) ---------- */

test('validateStrategyTable: dimension 须为四维之一', () => {
  const value = table({
    id: 'daily',
    version: '1.1.0',
    rules: [{ label: 'a', dimension: 'mood', strategy: { temperature: 0.5 } } as StrategyRule],
  })
  assert.deepEqual(validateStrategyTable(value), ['strategies.rules[0].dimension 须为 tone、length、structure、language 之一'])
})

test('resolveStrategy: 缺省 dimension 归 tone', () => {
  const value = table({
    id: 'daily',
    version: '1.1.0',
    rules: [{ label: 'a', strategy: { injection: 'Tone text.' } }],
  })
  const resolved = resolveStrategy(value, labels(['a', 0.9]))
  assert.equal(resolved.strategy.injection, 'Tone text.')
  assert.equal(resolved.injections.tone, 'Tone text.')
  assert.equal(resolved.injections.length, '')
  assert.equal(resolved.injections.structure, '')
  assert.equal(resolved.injections.language, '')
})

test('resolveStrategy: 同维度按 priority 覆盖,后合并者整体顶掉先合并者', () => {
  const value = table({
    id: 'daily',
    version: '1.1.0',
    rules: [
      { label: 'a', priority: 1, dimension: 'tone', strategy: { injection: '先合并的语气。' } },
      { label: 'b', priority: 10, dimension: 'tone', strategy: { injection: '后合并的语气。' } },
    ],
  })
  const resolved = resolveStrategy(value, labels(['a', 0.9], ['b', 0.9]))
  assert.equal(resolved.injections.tone, '后合并的语气。')
  assert.equal(resolved.strategy.injection, '后合并的语气。')
})

test('resolveStrategy: 同维度同级按 rules 数组顺序,后出现者后合并', () => {
  const value = table({
    id: 'daily',
    version: '1.1.0',
    rules: [
      { label: 'a', priority: 10, dimension: 'length', strategy: { injection: '先声明的长度。' } },
      { label: 'b', priority: 10, dimension: 'length', strategy: { injection: '后声明的长度。' } },
    ],
  })
  const resolved = resolveStrategy(value, labels(['a', 0.9], ['b', 0.9]))
  assert.equal(resolved.injections.length, '后声明的长度。')
})

test('resolveStrategy: 跨维度互不覆盖,按 tone→length→structure→language 拼接', () => {
  const value = table({
    id: 'daily',
    version: '1.1.0',
    rules: [
      { label: 'b', priority: 20, dimension: 'structure', strategy: { injection: '结构要求。' } },
      { label: 'a', priority: 10, dimension: 'tone', strategy: { injection: '语气要求。' } },
      { label: 'c', priority: 30, dimension: 'language', strategy: { injection: '语言要求。' } },
      { label: 'd', priority: 15, dimension: 'length', strategy: { injection: '长度要求。' } },
    ],
  })
  const resolved = resolveStrategy(value, labels(['a', 0.9], ['b', 0.9], ['c', 0.9], ['d', 0.9]))
  assert.equal(resolved.strategy.injection, '语气要求。\n\n长度要求。\n\n结构要求。\n\n语言要求。')
  // matched 按合并顺序(priority 升序),注入顺序由维度拼接决定,两者独立
  assert.deepEqual(resolved.matched, ['a', 'd', 'b', 'c'])
})

test('resolveStrategy: 兜底策略的 injection 归 tone 维,可被 tone 维规则覆盖', () => {
  const baseOnly = table({
    id: 'daily',
    version: '1.1.0',
    base: { injection: '兜底文案。' },
    rules: [{ label: 'a', dimension: 'length', strategy: { injection: '长度要求。' } }],
  })
  const base = resolveStrategy(baseOnly, labels(['a', 0.9]))
  assert.equal(base.strategy.injection, '兜底文案。\n\n长度要求。')

  const overridden = resolveStrategy(table({
    id: 'daily',
    version: '1.1.0',
    base: { injection: '兜底文案。' },
    rules: [{ label: 'a', dimension: 'tone', strategy: { injection: '覆盖兜底的语气。' } }],
  }), labels(['a', 0.9]))
  assert.equal(overridden.injections.tone, '覆盖兜底的语气。')
  assert.equal(overridden.strategy.injection, '覆盖兜底的语气。')
})

test('resolveStrategy: 语言维规则的注入只在文案语言与输入语言一致时生效', () => {
  const value = table({
    id: 'daily',
    version: '1.1.0',
    rules: [
      { label: 'a', dimension: 'language', strategy: { maxTokens: 2048, injection: '术语用中文,专有名词保留原文。' } },
    ],
  })
  const zh = resolveStrategy(value, labels(['a', 0.9]), { lang: 'zh' })
  assert.equal(zh.injections.language, '术语用中文,专有名词保留原文。')
  assert.equal(zh.strategy.maxTokens, 2048)

  const en = resolveStrategy(value, labels(['a', 0.9]), { lang: 'en' })
  // lang 门只作用于 injection,其余字段照常合并
  assert.equal(en.injections.language, '')
  assert.equal(en.strategy.maxTokens, 2048)
  assert.equal(en.strategy.injection, '')
  assert.deepEqual(en.matched, ['a'])
})

test('resolveStrategy: 英文文案的语言维规则对英文输入生效', () => {
  const value = table({
    id: 'daily',
    version: '1.1.0',
    rules: [
      { label: 'a', dimension: 'language', strategy: { injection: 'Keep terminology in English.' } },
    ],
  })
  const resolved = resolveStrategy(value, labels(['a', 0.9]), { lang: 'en' })
  assert.equal(resolved.injections.language, 'Keep terminology in English.')
})

test('resolveStrategy: 未给出 lang 时不做语言维门控', () => {
  const value = table({
    id: 'daily',
    version: '1.1.0',
    rules: [{ label: 'a', dimension: 'language', strategy: { injection: '术语用中文。' } }],
  })
  const resolved = resolveStrategy(value, labels(['a', 0.9]))
  assert.equal(resolved.injections.language, '术语用中文。')
})

test('composeInjection: 对比示例插在形状维之后、语言维之前', () => {
  const composed = composeInjection(
    { tone: '语气要求。', length: '长度要求。', structure: '', language: '语言要求。' },
    '正例:短回答。\n反例:长回答。',
  )
  assert.equal(composed, '语气要求。\n\n长度要求。\n\n正例:短回答。\n反例:长回答。\n\n语言要求。')
})

test('composeInjection: 不传对比示例时就是四维固定顺序拼接', () => {
  const composed = composeInjection({ tone: '', length: '', structure: '结构要求。', language: '' })
  assert.equal(composed, '结构要求。')
})

test('resolveStrategy: 1.0.0 包全部规则落在同一维度,合成结果与旧口径一致', () => {
  const value = table({
    id: 'daily',
    version: '1.0.0',
    base: { injection: '兜底文案。' },
    rules: [
      { label: 'a', priority: 1, strategy: { injection: '先合并的注入。' } },
      { label: 'b', priority: 5, strategy: { injection: '后合并的注入。' } },
    ],
  })
  const resolved = resolveStrategy(value, labels(['a', 0.9], ['b', 0.9]))
  assert.equal(resolved.strategy.injection, '后合并的注入。')
})
