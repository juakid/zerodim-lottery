'use strict';

/**
 * 密码哈希 / 校验：Node 内置 crypto.scrypt（OWASP 推荐的 KDF 之一），
 * 随机盐 + 常量时间比较（timingSafeEqual），无需任何第三方依赖。
 *
 * 存储格式: scrypt$N$r$p$saltBase64$hashBase64
 */

const crypto = require('crypto');
const { promisify } = require('util');

const SCRYPT_N = 16384; // CPU/内存成本（2^14）
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

const scryptAsync = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = await scryptAsync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || !password) return false;
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // 防御：拒绝异常的 KDF 参数（防止畸形存储值导致资源耗尽）
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N < 1024 || N > 65536 || r < 1 || r > 16 || p < 1 || p > 8) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch (err) {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await scryptAsync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (err) {
    return false;
  }
}

/** 随机 token（hex），用于会话令牌 / 记录 ID 等 */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

module.exports = { hashPassword, verifyPassword, randomToken, sha256Hex };
