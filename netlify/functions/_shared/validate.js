'use strict';

/**
 * 服务端输入校验：长度 / 字符集白名单。
 * 用户 ID 与奖品名称都限制字符集，配合前端 textContent 渲染双重防 XSS。
 */

const { ApiError } = require('./http');

// 用户 ID：中英文、数字、空格、_ - · （） 。 不包含任何 HTML/脚本元字符
const USER_ID_RE = /^[\p{L}\p{N} _\-·.（）()]+$/u;
// 奖品名称：排除 HTML/脚本元字符与控制字符
const PRIZE_NAME_RE = /^[^<>&"'`\\\u0000-\u001f\u007f]+$/u;

function cleanUserId(raw) {
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'INVALID_USER_ID', '用户 ID 格式不正确');
  }
  const value = raw.trim();
  if (value.length < 1 || value.length > 24) {
    throw new ApiError(400, 'INVALID_USER_ID', '用户 ID 长度需为 1-24 个字符');
  }
  if (!USER_ID_RE.test(value)) {
    throw new ApiError(400, 'INVALID_USER_ID', '用户 ID 只能包含中英文、数字、空格及 _ - · （ ） 等字符');
  }
  return value;
}

function cleanPrizeName(raw) {
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'INVALID_PRIZE_NAME', '奖品名称格式不正确');
  }
  const value = raw.trim();
  if (value.length < 1 || value.length > 40) {
    throw new ApiError(400, 'INVALID_PRIZE_NAME', '奖品名称长度需为 1-40 个字符');
  }
  if (!PRIZE_NAME_RE.test(value)) {
    throw new ApiError(400, 'INVALID_PRIZE_NAME', '奖品名称包含不允许的字符');
  }
  return value;
}

function cleanTotal(raw) {
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > 99999) {
    throw new ApiError(400, 'INVALID_TOTAL', '奖品总数需为 1-99999 的整数');
  }
  return n;
}

function cleanAmount(raw) {
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new ApiError(400, 'INVALID_AMOUNT', '增加次数需为 1-100 的整数');
  }
  return n;
}

function cleanLimit(raw) {
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new ApiError(400, 'INVALID_LIMIT', 'limit 需为 1-50 的整数');
  }
  return n;
}

function cleanPassword(raw, { field = '密码', min = 8, max = 64 } = {}) {
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'INVALID_PASSWORD', `${field}格式不正确`);
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new ApiError(400, 'INVALID_PASSWORD', `${field}包含不允许的字符`);
  }
  if (raw.length < min || raw.length > max) {
    throw new ApiError(400, 'INVALID_PASSWORD', `${field}长度需为 ${min}-${max} 个字符`);
  }
  return raw;
}

/** 奖品 ID 为 12 位十六进制（randomToken(6) 生成） */
function cleanPrizeId(raw) {
  if (typeof raw !== 'string' || !/^[0-9a-f]{12}$/.test(raw)) {
    throw new ApiError(404, 'NOT_FOUND', '奖品不存在');
  }
  return raw;
}

module.exports = {
  cleanUserId,
  cleanPrizeName,
  cleanTotal,
  cleanAmount,
  cleanLimit,
  cleanPassword,
  cleanPrizeId,
};
