import type { PluginManifest } from './types.js'

/**
 * 插件清单,从地址安装时由产物自带的 manifest 提供。
 */
export const manifest: PluginManifest = {
  id: 'dsc-humanize',
  name: 'Humanize',
  version: '0.1.0',
  engines: '^1.0.0',
  capabilities: ['events:session', 'notify'],
  contributions: ['session:changed'],
}
