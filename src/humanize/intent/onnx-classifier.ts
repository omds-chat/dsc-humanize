import type { ClassifyInput, IntentClassifier, IntentResult } from '../types.js'

/** ONNX 分类器的装配参数;本轮只固定接口形状 */
export interface OnnxClassifierOptions {
  /** 模型地址,由资产包或插件设置提供 */
  modelUrl: string
  /** 模型对应的标签集版本,须与提供标签集的来源版本一致 */
  labelSetVersion: string
  /** 置信度阈值,缺省 0.3 */
  minConfidence?: number
}

/** 未就绪时给调用方的统一提示 */
const NOT_READY = 'humanize: ONNX 分类器尚未实现,装配方应回退到规则分类器'

/**
 * 创建 ONNX 分类器。
 *
 * TODO(humanize-onnx),按顺序做:
 * 1. 选定浏览器端推理运行时,新增依赖前先报告,不要自行添加,也不要下载模型;
 * 2. 模型随资产包分发,加载前校验地址可达性与标签集版本;
 * 3. 文本预处理与分词须与模型训练时的配置一致,规则写进资产包;
 * 4. 推理输出映射回标签 id,再按 minConfidence 过滤并降序排序;
 * 5. 用 signal 支持取消,并给出首次推理的预热与失败降级策略。
 * 在以上完成之前,classify 一律拒绝,不返回猜测结果。
 */
export const createOnnxClassifier = (options: OnnxClassifierOptions): IntentClassifier => ({
  id: 'onnx:' + options.modelUrl,
  kind: 'onnx',
  classify: (_input: ClassifyInput): Promise<IntentResult> => Promise.reject(new Error(NOT_READY)),
})
