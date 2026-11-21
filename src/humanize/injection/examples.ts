import type { ContrastExample } from '../types.js'

/**
 * 把对比示例渲染成注入文本(规范 7.5)。
 *
 * 每个对比条目渲染成一个块:场景说明在最前,正例在前、反例紧随;
 * 条目之间空一行分隔。内核只提供「场景:」「正例:」「反例:」三个结构标记,
 * 不提供任何成句文案;标记之外的文本全部来自资产,资产未给场景时省略该行。
 * 文本是纯文本,不含变量、条件与占位符,与 7.4 的注入文本同口径。
 */
export const buildContrastText = (examples: readonly ContrastExample[]): string => {
  const blocks: string[] = []

  for (const example of examples) {
    for (const item of example.cases) {
      const lines: string[] = []
      const scene = item.scene?.trim()
      if (scene !== undefined && scene !== '') lines.push('场景:' + scene)
      lines.push('正例:' + item.positive.trim())
      lines.push('反例:' + item.negative.trim())
      blocks.push(lines.join('\n'))
    }
  }

  return blocks.join('\n\n')
}
