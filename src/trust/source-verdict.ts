/**
 * 导入路径的两轴结论,取值与判定口径对齐 asset-market.md 3.4。
 *
 * 两个轴各回答一个问题,互不替代:
 * - 签名结论回答「这份字节与签发时是否一致」;导入路径没有清单签名材料,
 *   当前恒为未校验。字段保留三态取值,签名覆盖范围定稿后(4.4)直接复用。
 * - 来源结论回答「这份内容是否出自该来源」;由「内嵌根 → 来源证书」的链校验给出,
 *   链通过再比对证书主题 CN 与包标识。
 *
 * 按设计口径,来源结论只提示、不阻断导入:链不通过时结论降级为未通过,
 * 导入照常完成,失败原因记在 sourceReason 里供排查与界面展示。
 */
import { EMBEDDED_ROOT_CA_PEM, hasEmbeddedRootCa } from './root-ca.js'
import { parseCertificatePem, verifyCertificateChain } from './x509.js'

/** 签名结论的三态:通过、未校验、失败;当前导入路径只会取未校验 */
export type AssetSignatureVerdict = 'passed' | 'unverified' | 'failed'

/**
 * 来源结论:已确认、未通过、本地。
 * 「无法确认」是市场取件路径的取值,本地导入拿不到证书时按「本地」计(3.4)。
 */
export type AssetSourceVerdict = 'confirmed' | 'rejected' | 'local'

/** 导入一次资产包文档得到的信任结论 */
export type AssetTrustVerdict = {
  /** 签名结论;导入路径没有清单签名材料,恒为未校验 */
  signature: AssetSignatureVerdict
  /** 来源结论;只由链校验给出,不阻断导入 */
  source: AssetSourceVerdict
  /** 来源结论未通过时的原因;只用于排查,不直接当文案展示 */
  sourceReason?: string
}

/** 导入时的来源校验参数 */
export type SourceTrustOptions = {
  /** 包的来源证书 PEM;缺省表示用户本地导入,没有来源材料 */
  sourceCertPem?: string
  /** 校验时刻;缺省取当前时间,测试用它构造过期与未生效的反例 */
  now?: Date
}

/** 来源结论的中文短语,供日志与将来的界面复用 */
const SOURCE_LABELS: Readonly<Record<AssetSourceVerdict, string>> = {
  confirmed: '已确认',
  rejected: '未通过',
  local: '本地',
}

/** 把两轴结论压成一行排查文本:来源结论带原因时一起给出 */
export const describeTrustVerdict = (trust: AssetTrustVerdict): string => {
  const label = SOURCE_LABELS[trust.source]
  return trust.source === 'rejected' && trust.sourceReason !== undefined
    ? label + '(' + trust.sourceReason + ')'
    : label
}

/**
 * 对一次导入计算两轴结论。
 *
 * 不带来源证书时按「用户本地导入」处理,来源结论为本地;
 * 带了证书就先过链校验,链不过时来源结论降级为未通过且不再比对标识,
 * 链通过后比对证书主题 CN 与包标识,不一致同样按未通过降级。
 * 本函数只给结论,不抛错、不阻断调用方的导入流程。
 */
export const verifySourceTrust = async (
  packageId: string,
  options: SourceTrustOptions = {},
): Promise<AssetTrustVerdict> => {
  const certPem = options.sourceCertPem
  if (certPem === undefined || certPem.trim() === '') {
    return { signature: 'unverified', source: 'local' }
  }

  if (!hasEmbeddedRootCa()) {
    return {
      signature: 'unverified',
      source: 'rejected',
      sourceReason: '运行时没有内嵌资产根证书,无法校验来源证书链',
    }
  }

  const chain = await verifyCertificateChain(EMBEDDED_ROOT_CA_PEM, certPem, options.now)
  if (!chain.ok) {
    return { signature: 'unverified', source: 'rejected', sourceReason: chain.reason }
  }

  const parsed = parseCertificatePem(certPem)
  const cn = parsed === null ? null : parsed.subjectCn
  if (cn !== null && cn !== '' && cn !== packageId) {
    return {
      signature: 'unverified',
      source: 'rejected',
      sourceReason: '来源证书主题与包标识不一致: 证书 CN=' + cn + ',包 id=' + packageId,
    }
  }

  return { signature: 'unverified', source: 'confirmed' }
}
