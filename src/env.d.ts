/**
 * 构建期注入的全局常量。
 *
 * build.mjs 从 certs/dsc-humanize/dsc-humanize-root-ca.crt 读取公开证书,
 * 以 esbuild define 注入为字符串;未经构建直接运行源码时该标识不存在,
 * 读取处必须先判 typeof,不能在模块顶层直接取值。
 */
declare const __ROOT_CA_PEM__: string
