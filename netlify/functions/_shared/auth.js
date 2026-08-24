'use strict';

/**
 * 管理员认证：服务端会话（随机 32 字节 token 存 Blobs，HttpOnly Cookie 下发）。
 *
 * 安全要点：
 *   - 密码哈希（scrypt）只存在于服务端存储/环境变量，前端永不接触；
 *   - 会话记录带 authVersion：修改密码后版本号 +1，所有旧会话立即失效；
 *   - 会话有过期时间，登出即从存储中删除；
 *   - 会话 Cookie：HttpOnly + SameSite=Strict（防 XSS 窃取 / CSRF），
 *     生产 HTTPS 下追加 Secure 与 __Host- 前缀。
 */

const { ApiError, parseCookies, getCookieName } = require('./http');
const { getImpl, updateConfig, CONFIG_KEY } = require('./storage');
const { hashPassword, verifyPassword, randomToken } = require('./crypto');

const SESSION_PREFIX = 'session:';

function isProd() {
  return process.env.NETLIFY === 'true';
}

function sessionTtlMs() {
  const h = Number(process.env.SESSION_TTL_HOURS || 12);
  return (Number.isFinite(h) && h > 0 ? h : 12) * 3600 * 1000;
}

/**
 * 读取（并按需初始化）配置文档。
 * 优先级：ADMIN_PASSWORD_OVERRIDE=1 强制重置 -> 已存储的哈希 ->
 * 环境变量 ADMIN_PASSWORD_HASH -> 环境变量 ADMIN_PASSWORD（仅本地便捷）-> 临时随机密码（仅本地）。
 */
async function loadConfig() {
  const impl = await getImpl();
  const { data } = await impl.getWithEtag(CONFIG_KEY);
  let config = data || null;

  // 紧急重置：部署新哈希 + ADMIN_PASSWORD_OVERRIDE=1，应用后所有旧会话失效
  if (
    config &&
    process.env.ADMIN_PASSWORD_OVERRIDE === '1' &&
    process.env.ADMIN_PASSWORD_HASH &&
    config.adminPasswordHash !== process.env.ADMIN_PASSWORD_HASH
  ) {
    console.warn('[auth] ADMIN_PASSWORD_OVERRIDE=1 已应用：密码哈希已重置，所有会话已失效');
    return updateConfig((c) => {
      c.adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
      c.authVersion = (Number(c.authVersion) || 1) + 1;
      c.updatedAt = new Date().toISOString();
      return c;
    });
  }

  if (config && config.adminPasswordHash) return config;

  // 首次引导：从环境变量生成初始哈希
  let hash = process.env.ADMIN_PASSWORD_HASH || null;
  if (!hash && process.env.ADMIN_PASSWORD) {
    hash = await hashPassword(process.env.ADMIN_PASSWORD);
    console.warn('[auth] 使用 ADMIN_PASSWORD 环境变量生成密码哈希（生产环境建议改用 ADMIN_PASSWORD_HASH）');
  }
  const isDev = !isProd();
  if (!hash) {
    if (!isDev) {
      throw new ApiError(500, 'CONFIG_ERROR', '服务未正确配置（缺少 ADMIN_PASSWORD_HASH 环境变量）');
    }
    const tmp = randomToken(6);
    hash = await hashPassword(tmp);
    console.log('==============================================================');
    console.log('[auth] 未配置管理员密码，已生成临时密码（仅限本地开发）: ' + tmp);
    console.log('        登录后请立即在「管理者 → 修改管理员密码」中修改！');
    console.log('==============================================================');
  }
  return updateConfig((c) => {
    if (!c.adminPasswordHash) {
      c.adminPasswordHash = hash;
      c.authVersion = 1;
      c.updatedAt = new Date().toISOString();
    }
    return c;
  });
}

async function createSession() {
  const config = await loadConfig();
  const token = randomToken(32);
  const rec = { createdAt: Date.now(), expiresAt: Date.now() + sessionTtlMs(), version: config.authVersion };
  await (await getImpl()).setPlain(SESSION_PREFIX + token, rec);
  return token;
}

async function readSession(event) {
  const cookies = parseCookies((event.headers || {}).cookie || '');
  const token = cookies[getCookieName(true)] || cookies[getCookieName(false)];
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const impl = await getImpl();
  const { data } = await impl.getWithEtag(SESSION_PREFIX + token);
  const rec = data || null;
  if (!rec) return null;
  const config = await loadConfig();
  if (rec.expiresAt <= Date.now() || rec.version !== config.authVersion) {
    try {
      await impl.del(SESSION_PREFIX + token);
    } catch (err) {
      /* 忽略删除失败 */
    }
    return null;
  }
  return { token, rec };
}

async function requireAdmin(event) {
  const session = await readSession(event);
  if (!session) {
    throw new ApiError(401, 'UNAUTHORIZED', '请先登录管理员账号');
  }
  return session;
}

async function destroySession(token) {
  if (token) {
    try {
      await (await getImpl()).del(SESSION_PREFIX + token);
    } catch (err) {
      /* 忽略删除失败 */
    }
  }
}

/** 修改密码：写入新哈希并让 authVersion +1，使所有已签发会话立即失效 */
async function updateConfigWithHash(newHash) {
  return updateConfig((c) => {
    c.adminPasswordHash = newHash;
    c.authVersion = (Number(c.authVersion) || 1) + 1;
    c.updatedAt = new Date().toISOString();
    return c;
  });
}

module.exports = { loadConfig, createSession, readSession, requireAdmin, destroySession, updateConfigWithHash };
