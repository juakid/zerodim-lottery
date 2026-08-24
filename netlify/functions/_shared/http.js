'use strict';

/**
 * HTTP 通用工具：统一 JSON 响应、Cookie 解析/序列化、请求体解析。
 * 所有响应统一走 json()/error()，保证不会向客户端泄露堆栈信息。
 */

class ApiError extends Error {
  constructor(status, code, message, extraHeaders = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extraHeaders = extraHeaders;
  }
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function json(statusCode, data, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify(data),
  };
}

function error(statusCode, code, message, extraHeaders = {}) {
  return json(statusCode, { error: code, message }, extraHeaders);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch (err) {
      out[key] = value;
    }
  }
  return out;
}

function parseBody(event) {
  if (!event.body) return {};
  let raw = event.body;
  if (event.isBase64Encoded) {
    raw = Buffer.from(raw, 'base64').toString('utf8');
  }
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    throw new ApiError(400, 'BAD_REQUEST', '请求体格式不正确');
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, 'BAD_REQUEST', '请求体不是合法的 JSON');
  }
}

function getClientIp(event) {
  const h = event.headers || {};
  const nf = h['x-nf-client-connection-ip'];
  if (nf) return nf;
  const fwd = h['x-forwarded-for'] || '';
  const first = fwd.split(',')[0].trim();
  return first || 'unknown';
}

function isHttpsRequest(event) {
  const h = event.headers || {};
  return (h['x-forwarded-proto'] || '').toLowerCase() === 'https';
}

/** 生产环境（HTTPS）使用 __Host- 前缀 + Secure，本地开发使用普通名（http 下浏览器不认 __Host-） */
function getCookieName(secure) {
  return secure ? '__Host-zerodim_session' : 'zerodim_session';
}

function sessionCookie(token, { clear = false, secure = false, ttlSeconds = 12 * 3600 } = {}) {
  const parts = [`${getCookieName(secure)}=${clear ? '' : token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (secure) parts.push('Secure');
  parts.push(clear ? 'Max-Age=0' : `Max-Age=${ttlSeconds}`);
  return parts.join('; ');
}

module.exports = {
  ApiError,
  json,
  error,
  parseCookies,
  parseBody,
  getClientIp,
  isHttpsRequest,
  getCookieName,
  sessionCookie,
};
