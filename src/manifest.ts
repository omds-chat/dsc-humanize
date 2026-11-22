import type { PluginManifest } from './types.js'

/**
 * 插件清单,从地址安装时由产物自带的 manifest 提供。
 *
 * conflicts 是本插件这一侧的互斥声明:dsc-llm-tune 也改写同一次请求的参数,
 * 两者同时安装时补丁按登记顺序合并,用户无法预测最终取值,因此按「同时安装即拒绝」处理。
 * 职责上两者互补:本插件提供预设,dsc-llm-tune 提供自由调节,按需切换但不并存。
 * 双向互斥的另一侧由 dsc-llm-tune 的清单声明。
 *
 * assets:read 是资产市场的远端取件通道:只 GET、只 https 与回环 http、不带凭证、
 * 上限 512KB、三态结果,市场按它读来源索引、证书与包内文件,不自行发请求。
 * settings:surface 用于登记来源开关与自建来源字段,宿主渲染设置表单,插件不交控件。
 * ui:slot 用于登记资产市场条目,slots 白名单声明允许登记的挂载点,当前是
 * conversation.tabs(会话视图标签栏里的一个标签 + 主区整页);ui:slot-action 与
 * ui:slot-data 是配套的动作回调与模型索取挂载点(引擎要求申请能力 ui:slot、
 * 在 slots 白名单内声明挂载点并声明这两个挂载点)。
 */
export const manifest: PluginManifest = {
  id: 'dsc-humanize',
  name: 'Humanize',
  version: '0.1.0',
  engines: '^1.0.0',
  conflicts: ['dsc-llm-tune'],
  capabilities: ['events:session', 'notify', 'plugins:storage', 'chat:request', 'assets:read', 'settings:surface', 'ui:slot'],
  mounts: ['session:changed', 'chat:before-request', 'ui:slot-action', 'ui:slot-data'],
  slots: ['conversation.tabs'],
}
