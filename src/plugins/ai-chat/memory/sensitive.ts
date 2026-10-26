/**
 * 敏感信息规则的服务端兜底（抽取器提示词里也有同样的要求，这里防模型漏网）：
 * - 凭证与可直接定位到个人的信息：永不入记忆；
 * - 健康、性取向、宗教、政治、家庭隐私：只记本人自述，并标记 sensitive（只在和本人对话时使用）。
 */

type Rule = { reason: string; test: (text: string) => boolean };

const re = (pattern: RegExp, reason: string): Rule => ({ reason, test: (t) => pattern.test(t) });

/** GB 11643 校验位 + 出生日期合理性，避免把 18 位的 Discord ID 当成身份证号 */
function hasChineseIdNumber(text: string): boolean {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = '10X98765432';
  for (const m of text.matchAll(/(?<!\d)(\d{17})([\dXx])(?!\d)/g)) {
    const body = m[1];
    const year = Number(body.slice(6, 10));
    const month = Number(body.slice(10, 12));
    const day = Number(body.slice(12, 14));
    if (year < 1900 || year > 2030 || month < 1 || month > 12 || day < 1 || day > 31) continue;
    const sum = weights.reduce((acc, w, i) => acc + w * Number(body[i]), 0);
    if (checks[sum % 11] === m[2].toUpperCase()) return true;
  }
  return false;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** 银行卡号：要有"卡号/银行卡"之类的上下文，且通过 Luhn 校验 */
function hasBankCard(text: string): boolean {
  for (const m of text.matchAll(/(?:卡号|银行卡|信用卡|储蓄卡|card\s*(?:no|number)?)\D{0,8}((?:\d[ -]?){15,18}\d)/gi)) {
    if (luhn(m[1].replace(/\D/g, ''))) return true;
  }
  return false;
}

const FORBIDDEN: Rule[] = [
  re(/\bsk-[A-Za-z0-9_-]{16,}/, 'API key'),
  re(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/, 'GitHub token'),
  re(/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'),
  re(/\bAKIA[0-9A-Z]{16}\b/, 'AWS key'),
  re(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/, 'JWT'),
  re(/\b[MNO][A-Za-z\d_-]{23,27}\.[\w-]{6}\.[\w-]{27,}/, 'Discord token'),
  re(/(?:密码|口令|password|passwd|pwd|密钥|token|api[ _-]?key)\s*(?:是|为|[:：=])\s*\S{4,}/i, '密码/密钥'),
  { reason: '身份证号', test: hasChineseIdNumber },
  { reason: '银行卡号', test: hasBankCard },
  re(/(?<!\d)1[3-9]\d{9}(?!\d)/, '手机号'),
  re(/\+\d{1,3}[ -]?\d{3,4}[ -]?\d{3,4}[ -]?\d{3,4}(?!\d)/, '电话号码'),
  re(/[\w.+-]+@[\w-]+\.[a-z]{2,}(?:\.[a-z]{2,})*/i, '邮箱'),
  re(/(?:路|街|大道|巷|弄|胡同)\s*\d+\s*号/, '详细住址'),
  re(/\d+\s*(?:号楼|栋|幢)\s*\d*\s*(?:单元)?\s*\d+\s*(?:室|号)/, '详细住址'),
];

const SENSITIVE_TOPICS: RegExp[] = [
  /抑郁|焦虑症|双相|精神(?:病|科)|心理医生|吃药|服药|住院|确诊|癌|肿瘤|手术|怀孕|流产|艾滋|HIV|残疾|自残|自杀/i,
  /糖尿病|高血压|心脏病|哮喘|癫痫|乙肝|肝炎|肾病|白血病|红斑狼疮|帕金森|阿尔茨海默|自闭症|多动症|ADHD|厌食症|暴食症|强迫症|失眠症|慢性病|绝症/i,
  /同性恋|异性恋|双性恋|性取向|出柜|\bgay\b|\blesbian\b|跨性别|LGBT/i,
  /信教|基督徒|天主教|佛教徒|伊斯兰|穆斯林|宗教信仰|教会|受洗/,
  /党员|政治立场|政见|支持.{0,6}(?:党|派)|反对.{0,6}(?:党|派)|选票|投票给/,
  /离婚|家暴|父母(?:吵架|离异)|欠债|负债|破产/,
];

/** 检查前先去掉 Discord 的提及标记和 "ID 123…" 这类标注，它们是公开 ID，不是个人信息 */
function stripIds(text: string): string {
  return text
    .replace(/<@[!&]?\d{15,25}>/g, ' ')
    // "身份证ID 110105…" 这种：数字本身通过了身份证校验就不当作 Discord ID 豁免（宁可误拦）
    .replace(/(?:ID|id|u:|uid:?)\s*(\d{15,25}[\dXx]?)/g, (m, digits: string) => (hasChineseIdNumber(digits) ? m : ' '));
}

/** 含有永不入记忆的内容时返回原因，否则 null */
export function forbiddenReason(text: string): string | null {
  const t = stripIds(String(text || ''));
  for (const rule of FORBIDDEN) {
    if (rule.test(t)) return rule.reason;
  }
  return null;
}

/** 是否涉及敏感话题（健康、性取向、宗教、政治、家庭隐私） */
export function looksSensitive(text: string): boolean {
  return SENSITIVE_TOPICS.some((r) => r.test(text));
}
