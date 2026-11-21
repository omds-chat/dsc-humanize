import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeStop,
  resolveStrategy,
  validateStrategyTable,
} from '../../src/humanize/strategy/engine.ts'
import type { IntentLabel, StrategyTable } from '../../src/humanize/types.ts'

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
