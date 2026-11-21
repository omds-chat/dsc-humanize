/**
 * 资产侧的唯一信任锚。
 *
 * 构建时由 build.mjs 读取 certs/dsc-humanize/dsc-humanize-root-ca.crt,
 * 以 esbuild define 注入为字符串常量;源码直接运行时该标识不存在,按空串处理。
 * 只内嵌公开证书,根私钥不进入仓库,也不进入产物。
 */
export const ROOT_CA_SOURCE_PATH = 'certs/dsc-humanize/dsc-humanize-root-ca.crt'

const readInjectedRootCa = (): string =>
  typeof __ROOT_CA_PEM__ === 'string' ? __ROOT_CA_PEM__ : ''

/** 内嵌的根证书 PEM;未注入时为空串,表示运行时不具备锚点 */
export const EMBEDDED_ROOT_CA_PEM: string = readInjectedRootCa()

/** 是否已内嵌可用的根证书 PEM */
export const hasEmbeddedRootCa = (): boolean =>
  EMBEDDED_ROOT_CA_PEM.includes('-----BEGIN CERTIFICATE-----')
