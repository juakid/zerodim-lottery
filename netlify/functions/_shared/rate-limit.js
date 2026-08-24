'use strict';

/**
 * 令牌桶速率限制（按 IP 维度），计数持久化到 Blobs（跨函数实例共享），
 * 带窗口重置。用于防暴力破解（登录/改密）与脚本刷奖（抽奖/管理接口）。
 */

const crypto = require('crypto');
const { ApiError } = require('./http');
const { getImpl } = require('./storage');

function envNum(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const LIMITS = {
  login: { max: () => envNum('RATE_LIMIT_LOGIN_MAX', 5), window: () => envNum('RATE_LIMIT_LOGIN_WINDOW', 900) },
  draw: { max: () => envNum('RATE_LIMIT_DRAW_MAX', 30), window: () => envNum('RATE_LIMIT_DRAW_WINDOW', 60) },
  admin: { max: () => envNum('RATE_LIMIT_ADMIN_MAX', 120), window: () => envNum('RATE_LIMIT_ADMIN_WINDOW', 60) },
  changePw: { max: () => envNum('RATE_LIMIT_CHANGE_PW_MAX', 3), window: () => envNum('RATE_LIMIT_CHANGE_PW_WINDOW', 900) },
};

async function rateLimit(scope, key) {
  const cfg = LIMITS[scope];
  if (!cfg) return;
  const impl = await getImpl();
  const id = `rl:${scope}:${crypto.createHash('sha256').update(String(key)).digest('hex')}`;
  const now = Date.now();
  const { data } = await impl.getWithEtag(id);
  let rec = data || null;
  if (!rec || rec.resetAt <= now) {
    rec = { count: 0, resetAt: now + cfg.window() * 1000 };
  }
  rec.count += 1;
  await impl.setPlain(id, rec);
  if (rec.count > cfg.max()) {
    const retryAfter = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
    throw new ApiError(429, 'RATE_LIMITED', '操作太频繁了，请稍后再试', { 'Retry-After': String(retryAfter) });
  }
}

module.exports = { rateLimit };
