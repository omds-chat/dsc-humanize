import assert from 'node:assert/strict'
import test from 'node:test'

import { readAssetPackage } from '../../src/humanize/assets/loader.ts'
import { createHumanizeKernel } from '../../src/humanize/kernel.ts'
import { createRuleClassifier } from '../../src/humanize/intent/rule-classifier.ts'
import type {
  AssetContents,
  AssetSourceRef,
  InjectionFragment,
  LabelDefinition,
  PersonaProfile,
  StrategyTable,
} from '../../src/humanize/types.ts'

const labels: readonly LabelDefinition[] = [{ id: 'tone', keywords: ['please'] }]

const persona: PersonaProfile = { id: 'p1', name: 'Calm', prefix: 'You are friendly.' }

const strategyTable = (): StrategyTable => ({
  id: 'daily',
  version: 'v1',
  base: { injection: 'Base rules.' },
  rules: [{ label: 'tone', strategy: { temperature: 0.9, injection: 'Be polite.' } }],
})

const brief: InjectionFragment = { id: 'brief', name: 'Brief', text: 'Be brief.' }
const warm: InjectionFragment = { id: 'warm', name: 'Warm', text: 'Be warm.' }

const sourceOf = (id: string): AssetSourceRef => ({ id, version: '1.0.0' })

/** 四类各取一个来源的装配输入 */
const contents = (): AssetContents => ({
  persona: { source: sourceOf('dsc-persona'), items: [persona] },
  labels: { source: sourceOf('dsc-labels'), items: labels },
  strategies: { source: sourceOf('dsc-strategies'), items: [strategyTable()] },
  injection: { source: sourceOf('dsc-injection'), items: [brief, warm] },
})

test('createHumanizeKernel: plan 串起分类、策略、注入与来源记录', async () => {
  const kernel = createHumanizeKernel({ classifier: createRuleClassifier(), contents: contents() })

  const plan = await kernel.plan('please help', 'Existing prompt.')

  assert.equal(kernel.classifierId, 'rule-keyword')
  assert.deepEqual(plan.intent.labels, [{ label: 'tone', confidence: 0.5 }])
  assert.equal(plan.intent.primary?.label, 'tone')
  assert.equal(plan.strategy.strategy.temperature, 0.9)
  assert.equal(plan.strategy.strategy.injection, 'Be polite.')
  assert.equal(plan.strategy.tableVersion, 'v1')
  assert.deepEqual(plan.strategy.matched, ['tone'])
  assert.equal(
    plan.injection.prompt,
    'Existing prompt.\n\nYou are friendly.\n\nBe polite.\n\nBe brief.\n\nBe warm.',
  )
  assert.equal(plan.injection.added, 4)
  assert.deepEqual(plan.injection.dropped, [])
})

test('createHumanizeKernel: 每一类内容各自记录来源标识与版本', async () => {
  const kernel = createHumanizeKernel({ classifier: createRuleClassifier(), contents: contents() })
  const plan = await kernel.plan('please')

  assert.deepEqual(plan.attribution.map((entry) => entry.type), [
    'persona',
    'labels',
    'strategies',
    'injection',
  ])
  assert.deepEqual(plan.attribution.map((entry) => entry.source.id), [
    'dsc-persona',
    'dsc-labels',
    'dsc-strategies',
    'dsc-injection',
  ])
  assert.deepEqual(plan.attribution.map((entry) => entry.itemIds), [
    ['p1'],
    ['tone'],
    ['daily'],
    ['brief', 'warm'],
  ])
})

test('createHumanizeKernel: position 为 prepend 时片段放在已有提示词之前', async () => {
  const kernel = createHumanizeKernel({
    classifier: createRuleClassifier(),
    contents: contents(),
    position: 'prepend',
  })

  const plan = await kernel.plan('please', 'Existing prompt.')
  assert.equal(
    plan.injection.prompt,
    'You are friendly.\n\nBe polite.\n\nBe brief.\n\nBe warm.\n\nExisting prompt.',
  )
})

test('createHumanizeKernel: 缺省位置为追加', async () => {
  const kernel = createHumanizeKernel({
    classifier: createRuleClassifier(),
    contents: {
      strategies: { source: sourceOf('dsc-strategies'), items: [strategyTable()] },
    },
  })
  const plan = await kernel.plan('please', 'Existing prompt.')
  assert.equal(plan.injection.prompt, 'Existing prompt.\n\nBase rules.')
})

test('createHumanizeKernel: 不传已有提示词时只输出片段', async () => {
  const kernel = createHumanizeKernel({ classifier: createRuleClassifier(), contents: contents() })
  const plan = await kernel.plan('please')
  assert.equal(plan.injection.prompt, 'You are friendly.\n\nBe polite.\n\nBe brief.\n\nBe warm.')
})

test('createHumanizeKernel: 没有任何类型内容时规划等于不改变请求', async () => {
  const kernel = createHumanizeKernel({ classifier: createRuleClassifier(), contents: {} })
  const plan = await kernel.plan('please', 'Existing prompt.')

  assert.deepEqual(plan.intent.labels, [])
  assert.equal(plan.intent.primary, null)
  assert.equal(plan.strategy.strategy.temperature, null)
  assert.equal(plan.strategy.strategy.injection, '')
  assert.equal(plan.strategy.tableVersion, '')
  assert.equal(plan.injection.prompt, 'Existing prompt.')
  assert.equal(plan.injection.added, 0)
  assert.deepEqual(plan.attribution, [])
})

test('createHumanizeKernel: 没有人设时空前缀被丢弃', async () => {
  const kernel = createHumanizeKernel({
    classifier: createRuleClassifier(),
    contents: { strategies: { source: sourceOf('dsc-strategies'), items: [strategyTable()] } },
  })
  const plan = await kernel.plan('please', 'Existing prompt.')
  assert.deepEqual(plan.injection.dropped, [{ reason: 'empty', text: '' }])
  assert.equal(plan.injection.added, 1)
})

test('createHumanizeKernel: 没有策略表时只按标签集分类', async () => {
  const kernel = createHumanizeKernel({
    classifier: createRuleClassifier(),
    contents: { labels: { source: sourceOf('dsc-labels'), items: labels } },
  })
  const plan = await kernel.plan('please', 'Existing prompt.')

  assert.deepEqual(plan.intent.labels, [{ label: 'tone', confidence: 0.5 }])
  assert.deepEqual(plan.strategy.matched, [])
  assert.equal(plan.strategy.strategy.temperature, null)
  assert.equal(plan.strategy.tableVersion, '')
  assert.equal(plan.injection.prompt, 'Existing prompt.')
})

test('createHumanizeKernel: 没有标签集时分类结果为空', async () => {
  const kernel = createHumanizeKernel({ classifier: createRuleClassifier(), contents: {} })
  const plan = await kernel.plan('please')
  assert.deepEqual(plan.intent.labels, [])
  assert.equal(plan.intent.primary, null)
})

test('createHumanizeKernel: 空的类型集合允许出现,且不进入来源记录', async () => {
  const kernel = createHumanizeKernel({
    classifier: createRuleClassifier(),
    contents: {
      injection: { source: sourceOf('dsc-injection'), items: [] },
      strategies: { source: sourceOf('dsc-strategies'), items: [strategyTable()] },
    },
  })
  const plan = await kernel.plan('please', 'Existing prompt.')
  assert.deepEqual(plan.attribution.map((entry) => entry.type), ['strategies'])
  assert.equal(plan.injection.prompt, 'Existing prompt.\n\nBase rules.')
})

test('createHumanizeKernel: 人设给出多个条目时拒绝装配', () => {
  assert.throws(
    () => createHumanizeKernel({
      classifier: createRuleClassifier(),
      contents: {
        persona: { source: sourceOf('dsc-persona'), items: [persona, { ...persona, id: 'p2' }] },
      },
    }),
    /persona 只能有一个条目/,
  )
})

test('createHumanizeKernel: 策略表给出多个条目时拒绝装配', () => {
  assert.throws(
    () => createHumanizeKernel({
      classifier: createRuleClassifier(),
      contents: {
        strategies: {
          source: sourceOf('dsc-strategies'),
          items: [strategyTable(), { ...strategyTable(), id: 'strict' }],
        },
      },
    }),
    /strategies 只能有一个条目/,
  )
})

test('createHumanizeKernel: 已有提示词包含人设前缀时不再重复加入', async () => {
  const kernel = createHumanizeKernel({ classifier: createRuleClassifier(), contents: contents() })
  const plan = await kernel.plan('please', 'You are friendly.')
  assert.deepEqual(plan.injection.dropped, [{ reason: 'already-present', text: 'You are friendly.' }])
  assert.equal(plan.injection.prompt, 'You are friendly.\n\nBe polite.\n\nBe brief.\n\nBe warm.')
})

test('createHumanizeKernel: plan 不修改传入的标签集与策略表', async () => {
  const input = contents()
  const before = JSON.stringify(input)
  const kernel = createHumanizeKernel({ classifier: createRuleClassifier(), contents: input })

  await kernel.plan('please', 'Existing prompt.')

  assert.equal(JSON.stringify(input), before)
})

test('createHumanizeKernel: classifierId 跟随装配时使用的分类器', () => {
  const kernel = createHumanizeKernel({
    classifier: createRuleClassifier({ id: 'rule-custom' }),
    contents: {},
  })
  assert.equal(kernel.classifierId, 'rule-custom')
})

test('createHumanizeKernel: 加载后的资产包可以直接作为装配输入', async () => {
  const loaded = readAssetPackage({
    metadata: {
      formatVersion: '1.0.0',
      id: 'dsc-example-asset',
      name: '示例资产包',
      version: '0.1.0',
      description: '测试用包',
      author: 'omds-chat',
      types: ['persona', 'labels', 'strategies', 'injection'],
    },
    contents: {
      persona: [{ id: 'calm', name: 'Calm', prefix: 'You are calm.' }],
      labels: [{ id: 'tone', keywords: ['please'] }],
      strategies: [{
        id: 'daily',
        version: '1.0.0',
        rules: [{ label: 'tone', strategy: { temperature: 0.8 } }],
      }],
      injection: [{ id: 'brief', name: 'Brief', text: 'Be brief.' }],
    },
  })
  assert.equal(loaded.ok, true)
  if (!loaded.ok) return

  const kernel = createHumanizeKernel({
    classifier: createRuleClassifier(),
    contents: loaded.asset.contents,
  })
  const plan = await kernel.plan('please', 'Existing.')

  assert.equal(plan.strategy.strategy.temperature, 0.8)
  assert.equal(plan.injection.prompt, 'Existing.\n\nYou are calm.\n\nBe brief.')
  assert.deepEqual(
    plan.attribution.map((entry) => entry.source.id),
    ['dsc-example-asset', 'dsc-example-asset', 'dsc-example-asset', 'dsc-example-asset'],
  )
})
