import type { PluginManifest } from './types.js'

/**
 * 插件清单,从地址安装时由产物自带的 manifest 提供。
 *
 * conflicts 是本插件这一侧的互斥声明:dsc-llm-tune 也改写同一次请求的参数,
 * 两者同时安装时补丁按登记顺序合并,用户无法预测最终取值,因此按「同时安装即拒绝」处理。
 * 职责上两者互补:本插件提供预设,dsc-llm-tune 提供自由调节,按需切换但不并存。
 * 双向互斥的另一侧由 dsc-llm-tune 的清单声明。
 */
export const manifest: PluginManifest = {
  id: 'dsc-humanize',
  name: 'Humanize',
  version: '0.1.0',
  engines: '^1.0.0',
  conflicts: ['dsc-llm-tune'],
  capabilities: ['events:session', 'notify', 'plugins:storage', 'chat:request'],
  mounts: ['session:changed', 'chat:before-request'],
}
