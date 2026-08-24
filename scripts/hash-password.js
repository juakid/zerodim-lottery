'use strict';

/**
 * 生成管理员密码的 scrypt 哈希（与后端 _shared/crypto.js 同算法同格式）。
 *
 * 用法: node scripts/hash-password.js "你的密码"
 * 输出: scrypt$16384$8$1$<salt>$<hash>
 * 将输出填入 .env 或 Netlify 环境变量的 ADMIN_PASSWORD_HASH。
 */

const crypto = require('crypto');

const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(SALT_LEN);
    crypto.scrypt(password, salt, KEY_LEN, { N, r: R, p: P }, (err, key) => {
      if (err) return reject(err);
      resolve(`scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`);
    });
  });
}

(async () => {
  const password = process.argv[2];
  if (!password) {
    console.error('用法: node scripts/hash-password.js "你的密码"');
    process.exit(1);
  }
  const hash = await hashPassword(password);
  console.log(hash);
})().catch((err) => {
  console.error('生成失败:', err);
  process.exit(1);
});
