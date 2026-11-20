import assert from 'node:assert/strict'
import test from 'node:test'

import { createHumanizeKernel } from '../../src/humanize/kernel.ts'
import { createRuleClassifier } from '../../src/humanize/intent/rule-classifier.ts'
import type { LabelDefinition, PersonaProfile, StrategyTable } from '../../src/humanize/types.ts'

const labels: readonly LabelDefinition[] = [{ id: 'tone', keywords: ['please'] }]

const strategyTable = (): StrategyTable => ({
  version: 'v1',
  base: { injection: 'Base rules.' },
  rules: [{ label: 'tone', strategy: { temperature: 0.9, injection: 'Be polite.' } }],
})

const persona: PersonaProfile = { id: 'p1', name: 'Calm', prefix: 'You are friendly.' }

test('createHumanizeKernel: plan 串起分类、策略与注入', async () => {
  const kernel = createHumanizeKernel({
    classifier: createRuleClassifier(),
    labels,
    strategyTable: strategyTable(),
    persona,
  })

  const plan = await kernel.plan('please help', 'Existing prompt.')

  assert.equal(kernel.classifierId, 'rule-keyword')
  assert.deepEqual(plan.intent.labels, [{ label: 'tone', confidence: 0.5 }])
  assert.equal(plan.intent.primary?.label, 'tone')
  assert.equal(plan.strategy.strategy.temperature, 0.9)
  assert.equal(plan.strategy.strategy.injection, 'Be polite.')
  assert.equal(plan.strategy.tableVersion, 'v1')
  assert.deepEqual(plan.strategy.matched, ['tone'])
  assert.equal(plan.injection.prompt, 'Existing prompt.\n\nYou are friendly.\n\nBe polite.')
  assert.equal(plan.injection.added, 2)
  assert.deepEqual(plan.injection.dropped, [])
})

test('createHumanizeKernel: position 为 prepend 时片段放在已有提示词之前', async () => {
  const kernel = createHumanizeKernel({
    classifier: createRuleClassifier(),
    labels,
    strategyTable: strategyTable(),
    persona,
    position: 'prepend',
  })

  const plan = await kernel.plan('please', 'Existing prompt.')
  assert.equal(plan.injection.prompt, 'You are friendly.\n\nBe polite.\n\nExisting prompt.')
})

test('createHumanizeKernel: 缺省位置为追加', async () => {
  const kernel = createHumanizeKernel({
    classifier: createRuleClassifier(),
    labels,
    strategyTable: strategyTable(),
  })
  const plan = await kernel.plan('please', 'Existing prompt.')
  assert.equal(plan.injection.prompt, 'Existing prompt.\n\nBe polite.')
})

test('createHumanizeKernel: 不传已有提示词时只输出片段', async () => {
  const kernel = createHumanizeKernel({
    classifier: createRuleClassifier(),
    labels,
    strategyTable: strategyTable(),
    persona,
  })
  const plan = await kernel.plan('please')
  assert.equal(plan.injection.prompt, 'You are friendly.\n\nBe polite.')
})

test('createHumanizeKernel: 没有人设时空片段被丢弃', async () => {
  const kernel = createHumanizeKernel({
    classifier: createRuleClassifier(),
    labels,
    strategyTable: strategyTable(),
  })
  const plan = await kernel.plan('please', 'Existing prompt.')
  assert.deepEqual(plan.injection.dropped, [{ reason: 'empty', text: '' }])
  assert.equal(plan.injection.added, 1)
})

test('createHumanizeKernel: 未命中标签时只用兜底策略', async () => {
  const kernel = createHumanizeKernel({
    classifier: createRuleClassifier(),
    labels,
    strategyTable: strategyTable(),
    persona,
  })
  const plan = await kernel.plan('hello', 'Existing prompt.')
  assert.deepEqual(plan.intent.labels, [])
  assert.equal(plan.intent.primary, null)
  assert.deepEqual(plan.strategy.matched, [])
  assert.equal(plan.strategy.strategy.temperature, null)
  assert.equal(plan.strategy.strategy.injection, 'Base rules.')
  assert.equal(plan.injection.prompt, 'Existing prompt.\n\nYou are friendly.\n\nBase rules.')
})

test('createHumanizeKernel: 已有提示词包含人设前缀时不再重复加入', async () => {
  const kernel = createHumanizeKernel({
    classifier: createRuleClassifier(),
    labels,
    strategyTable: strategyTable(),
    persona,
  })
  const plan = await kernel.plan('please', 'You are friendly.')
  assert.deepEqual(plan.injection.dropped, [{ reason: 'already-present', text: 'You are friendly.' }])
  assert.equal(plan.injection.prompt, 'You are friendly.\n\nBe polite.')
})

test('createHumanizeKernel: plan 不修改传入的标签集与策略表', async () => {
  const table = strategyTable()
  const before = JSON.stringify({ table, labels })
  const kernel = createHumanizeKernel({
    classifier: createRuleClassifier(),
    labels,
    strategyTable: table,
    persona,
  })

  await kernel.plan('please', 'Existing prompt.')

  assert.equal(JSON.stringify({ table, labels }), before)
})

test('createHumanizeKernel: classifierId 跟随装配时使用的分类器', () => {
  const kernel = createHumanizeKernel({
    classifier: createRuleClassifier({ id: 'rule-custom' }),
    labels,
    strategyTable: strategyTable(),
  })
  assert.equal(kernel.classifierId, 'rule-custom')
})
