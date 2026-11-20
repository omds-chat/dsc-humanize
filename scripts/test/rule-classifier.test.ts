import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRuleClassifier,
  ruleClassifier,
  scoreLabels,
} from '../../src/humanize/intent/rule-classifier.ts'
import type { LabelDefinition } from '../../src/humanize/types.ts'

/** 置信度按公式计算,浮点比较留一点余量 */
const closeTo = (actual: number, expected: number): void => {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    '期望 ' + String(expected) + ',实际 ' + String(actual),
  )
}

const label = (id: string, keywords: readonly string[], weight?: number): LabelDefinition =>
  weight === undefined ? { id, keywords } : { id, keywords, weight }

test('scoreLabels: 未命中任何关键词的标签不返回', () => {
  assert.deepEqual(scoreLabels('hello there', [label('tone', ['polite'])]), [])
})

test('scoreLabels: 标签没有 keywords 时被跳过', () => {
  assert.deepEqual(scoreLabels('hello', [{ id: 'bare' }]), [])
})

test('scoreLabels: 命中 1 个关键词得 0.5', () => {
  const scored = scoreLabels('please help', [label('tone', ['please'])])
  assert.equal(scored.length, 1)
  assert.equal(scored[0]?.label, 'tone')
  closeTo(scored[0]?.confidence ?? 0, 0.5)
})

test('scoreLabels: 命中 2 个与 3 个关键词时置信度递增', () => {
  const two = scoreLabels('please help me', [label('tone', ['please', 'help'])])
  const three = scoreLabels('please help me', [label('tone', ['please', 'help', 'me'])])
  closeTo(two[0]?.confidence ?? 0, 2 / 3)
  closeTo(three[0]?.confidence ?? 0, 0.75)
})

test('scoreLabels: 标签权重乘进置信度', () => {
  const scored = scoreLabels('please', [label('tone', ['please'], 0.5)])
  closeTo(scored[0]?.confidence ?? 0, 0.25)
})

test('scoreLabels: 权重放大后置信度收敛到 1', () => {
  const scored = scoreLabels('please', [label('tone', ['please'], 4)])
  assert.equal(scored[0]?.confidence, 1)
})

test('scoreLabels: 关键词匹配忽略大小写与首尾空白', () => {
  const scored = scoreLabels('It is RAINING outside', [label('tone', ['  rain  '])])
  assert.equal(scored.length, 1)
  closeTo(scored[0]?.confidence ?? 0, 0.5)
})

test('scoreLabels: 重复关键词只计一次', () => {
  const once = scoreLabels('hi', [label('tone', ['hi'])])
  const twice = scoreLabels('hi', [label('tone', ['hi', 'hi', ' HI '])])
  closeTo(twice[0]?.confidence ?? 0, once[0]?.confidence ?? 0)
})

test('scoreLabels: 空白关键词被忽略', () => {
  assert.deepEqual(scoreLabels('anything', [label('tone', ['', '   '])]), [])
})

test('scoreLabels: 按置信度降序排列', () => {
  const scored = scoreLabels('alpha beta', [
    label('low', ['alpha']),
    label('high', ['alpha', 'beta']),
  ])
  assert.deepEqual(scored.map((item) => item.label), ['high', 'low'])
})

test('scoreLabels: 同分时按标签 id 升序排列', () => {
  const scored = scoreLabels('key', [label('zeta', ['key']), label('alpha', ['key'])])
  assert.deepEqual(scored.map((item) => item.label), ['alpha', 'zeta'])
})

test('scoreLabels: 未声明权重的标签按 1 计算', () => {
  const withWeight = scoreLabels('key', [label('tone', ['key'], 1)])
  const withoutWeight = scoreLabels('key', [label('tone', ['key'])])
  closeTo(
    withoutWeight[0]?.confidence ?? 0,
    withWeight[0]?.confidence ?? 0,
  )
})

test('createRuleClassifier: 默认 id 为 rule-keyword,kind 为 rule', async () => {
  const classifier = createRuleClassifier()
  assert.equal(classifier.id, 'rule-keyword')
  assert.equal(classifier.kind, 'rule')

  const result = await classifier.classify({ text: 'please', labels: [label('tone', ['please'])] })
  assert.equal(result.classifier, 'rule-keyword')
  assert.equal(result.text, 'please')
  assert.equal(result.primary?.label, 'tone')
})

test('createRuleClassifier: 可自定义分类器 id', async () => {
  const classifier = createRuleClassifier({ id: 'rule-custom' })
  const result = await classifier.classify({ text: 'please', labels: [label('tone', ['please'])] })
  assert.equal(result.classifier, 'rule-custom')
})

test('createRuleClassifier: 默认阈值 0.3 过滤掉低置信度标签', async () => {
  const classifier = createRuleClassifier()
  const result = await classifier.classify({
    text: 'please',
    labels: [label('low', ['please'], 0.4), label('weak', ['please'], 0.8), label('strong', ['please'], 1)],
  })
  // low 折算 0.2 未达阈值被丢弃,weak 0.4 与 strong 0.5 保留
  assert.deepEqual(result.labels.map((item) => item.label), ['strong', 'weak'])
  assert.equal(result.primary?.label, 'strong')
})

test('createRuleClassifier: 配置阈值高于全部置信度时结果为空', async () => {
  const classifier = createRuleClassifier({ minConfidence: 0.9 })
  const result = await classifier.classify({ text: 'please', labels: [label('tone', ['please'])] })
  assert.deepEqual(result.labels, [])
  assert.equal(result.primary, null)
})

test('createRuleClassifier: 调用参数里的 minConfidence 覆盖装配时的缺省值', async () => {
  const classifier = createRuleClassifier({ minConfidence: 0.9 })
  const result = await classifier.classify({
    text: 'please help',
    labels: [label('tone', ['please', 'help'])],
    minConfidence: 0.6,
  })
  assert.equal(result.labels.length, 1)
  assert.equal(result.primary?.label, 'tone')
})

test('ruleClassifier: 默认实例可直接使用', async () => {
  const result = await ruleClassifier.classify({
    text: 'please',
    labels: [label('tone', ['please'])],
  })
  assert.equal(ruleClassifier.id, 'rule-keyword')
  assert.equal(result.primary?.label, 'tone')
})
