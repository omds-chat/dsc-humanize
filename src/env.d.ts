/**
 * 构建期注入的全局常量。
 *
 * build.mjs 从 certs/dsc-humanize/dsc-humanize-root-ca.crt 读取公开证书,
 * 以 esbuild define 注入为字符串;未经构建直接运行源码时该标识不存在,
 * 读取处必须先判 typeof,不能在模块顶层直接取值。
 */
declare const __ROOT_CA_PEM__: string

/**
 * 两个内置资产来源的本地联调地址,来源为 .env 的 DSC_HUMANIZE_INNER_ASSET_PAGES_LINK
 * 与 AWESOME_DSC_HUMANIZE_ASSET_PAGES_LINK;未配置或未构建时为空串,
 * 读取处先判 typeof 与取值,空串与非法地址都退回线上地址(设计 2.2)。
 */
declare const __INNER_ASSET_PAGES_URL__: string
declare const __AWESOME_ASSET_PAGES_URL__: string
