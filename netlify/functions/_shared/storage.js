'use strict';

/**
 * 数据存储层。
 *
 * 生产环境：Netlify Blobs（site 级 store，跨部署持久化）。
 * 本地开发：若 Blobs 不可用（如未安装依赖 / 模拟器未开启），自动回退到
 *   项目根目录 .data/ 的本地 JSON 文件（同步 fs，单线程下天然原子）。
 *
 * 并发模型（核心）：
 *   - Netlify Blobs v11 支持条件写（onlyIfMatch / onlyIfNew，即 CAS）。
 *   - 抽奖等所有"读-改-写"操作都走 updateState()：读取 -> 克隆 ->
 *     变更 -> 携带 etag 条件写。若期间被并发写覆盖，条件写返回
 *     modified:false，自动重读重试，从根上杜绝丢失更新 / 并发超发。
 *   - 若运行环境不支持 CAS，自动降级为"写后校验 + 有限重试"策略。
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { ApiError } = require('./http');

const BLOBS_STORE = process.env.BLOBS_STORE_NAME || 'zerodim-lottery';
const STATE_KEY = 'state';
const CONFIG_KEY = 'config';

const DEFAULT_MAX_WINNERS = 500;

function isProd() {
  return process.env.NETLIFY === 'true';
}

function localDir() {
  return process.env.LOCAL_STORAGE_DIR || path.join(process.cwd(), '.data');
}

function keyToFile(key) {
  return path.join(localDir(), crypto.createHash('sha256').update(key).digest('hex') + '.json');
}

let implPromise = null;

/** 探测当前 Blobs 环境是否支持条件写（CAS） */
async function probeConditionalWrites(store) {
  const probe = '__cas_probe__';
  try {
    const first = await store.setJSON(probe, { t: 1 }, { onlyIfNew: true });
    if (!first || first.modified === false) return false;
    const second = await store.setJSON(probe, { t: 2 }, { onlyIfNew: true });
    const supported = !!(second && second.modified === false);
    await store.delete(probe).catch(() => {});
    return supported;
  } catch (err) {
    return false;
  }
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

async function getImpl() {
  if (implPromise) return implPromise;
  implPromise = (async () => {
    try {
      const blobs = require('@netlify/blobs');
      const store = blobs.getStore(BLOBS_STORE);
      const casSupported = await probeConditionalWrites(store);
      if (!casSupported) {
        console.warn('[storage] 当前 Blobs 环境不支持条件写（CAS），将使用降级策略（写后校验 + 重试）');
      }
      // 把所有 Blob 操作包一层：失败时转为明确的 STORAGE_ERROR（而不是笼统的 500），
      // 完整错误仍记录在函数日志中，便于排查。
      const wrap = (fn) => async (...args) => {
        try {
          return await fn(...args);
        } catch (err) {
          console.error('[storage] Netlify Blobs 操作失败:', err);
          throw new ApiError(500, 'STORAGE_ERROR', '数据存储服务暂时不可用，请稍后再试（详见函数日志）');
        }
      };
      return {
        mode: 'cloud',
        casSupported,
        // 优先强一致读取；个别环境不支持显式 consistency 参数时自动降级为默认
        getWithEtag: wrap(async (key) => {
          let res;
          try {
            res = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
          } catch (err) {
            res = await store.getWithMetadata(key, { type: 'json' });
          }
          return res ? { data: res.data, etag: res.etag || null } : { data: null, etag: null };
        }),
        setPlain: wrap(async (key, value) => {
          await store.setJSON(key, value);
        }),
        setConditional: wrap(async (key, value, etag) => {
          const res = await store.setJSON(key, value, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
          return { modified: res.modified !== false };
        }),
        del: wrap(async (key) => {
          await store.delete(key);
        }),
      };
    } catch (err) {
      if (isProd()) {
        console.error('[storage] Netlify Blobs 初始化失败:', err);
        throw new ApiError(500, 'STORAGE_ERROR', '数据存储服务初始化失败，请查看 Netlify 函数日志');
      }
      console.warn('[storage] Netlify Blobs 不可用，回退到本地文件存储（仅限本地开发）。原因: ' + err.message);
      return {
        mode: 'local-file',
        casSupported: true,
        getWithEtag(key) {
          const file = keyToFile(key);
          let raw = null;
          try {
            raw = fs.readFileSync(file, 'utf8');
          } catch (err) {
            if (err.code !== 'ENOENT') throw err;
          }
          if (raw === null) return { data: null, etag: null };
          return { data: JSON.parse(raw), etag: sha256Hex(raw) };
        },
        setPlain(key, value) {
          writeFileAtomic(keyToFile(key), JSON.stringify(value));
        },
        setConditional(key, value, etag) {
          const file = keyToFile(key);
          let current = null;
          try {
            current = fs.readFileSync(file, 'utf8');
          } catch (err) {
            if (err.code !== 'ENOENT') throw err;
          }
          if (etag === null) {
            if (current !== null) return { modified: false };
          } else if (current === null || sha256Hex(current) !== etag) {
            return { modified: false };
          }
          writeFileAtomic(file, JSON.stringify(value));
          return { modified: true };
        },
        del(key) {
          try {
            fs.unlinkSync(keyToFile(key));
          } catch (err) {
            if (err.code !== 'ENOENT') throw err;
          }
        },
      };
    }
  })();
  return implPromise;
}

/* ---------------- 状态文档 ---------------- */

function emptyState() {
  return { version: 0, prizes: [], users: {}, winners: [] };
}

function cloneState(s) {
  return {
    version: s.version,
    prizes: (s.prizes || []).map((p) => ({ ...p })),
    users: Object.fromEntries(Object.entries(s.users || {}).map(([k, u]) => [k, { ...u }])),
    winners: (s.winners || []).map((w) => ({ ...w })),
  };
}

async function readState() {
  const impl = await getImpl();
  const { data } = await impl.getWithEtag(STATE_KEY);
  const state = data || emptyState();
  if (
    !state ||
    typeof state !== 'object' ||
    !Array.isArray(state.prizes) ||
    !Array.isArray(state.winners) ||
    typeof state.users !== 'object'
  ) {
    throw new Error('状态数据损坏');
  }
  return state;
}

const DEFAULT_ATTEMPTS = 5;

/**
 * 原子更新状态文档。
 * @param {(next: object) => any} mutator 同步变更 next；抛 ApiError 则中止（不写盘）
 * @returns {{state: object, info: any}}
 */
async function updateState(mutator, { attempts = DEFAULT_ATTEMPTS } = {}) {
  const impl = await getImpl();
  for (let i = 0; i < attempts; i++) {
    const { data, etag } = await impl.getWithEtag(STATE_KEY);
    const cur = data || emptyState();
    const next = cloneState(cur);
    const info = mutator(next);
    next.version = (Number(cur.version) || 0) + 1;

    if (impl.casSupported) {
      // 原子路径：CAS 条件写，被并发覆盖则重试
      const res = await impl.setConditional(STATE_KEY, next, etag);
      if (res.modified) return { state: next, info: info || null };
      continue;
    }

    // 降级路径：写后校验 + 有限重试
    await impl.setPlain(STATE_KEY, next);
    await sleep(20);
    const after = await impl.getWithEtag(STATE_KEY);
    if (after && after.data && after.data.version === next.version) {
      return { state: after.data, info: info || null };
    }
  }
  throw new ApiError(503, 'BUSY', '系统繁忙，请稍后重试');
}

/** 原子更新配置文档（管理员密码哈希 / authVersion 等） */
async function updateConfig(mutator, { attempts = DEFAULT_ATTEMPTS } = {}) {
  const impl = await getImpl();
  for (let i = 0; i < attempts; i++) {
    const { data, etag } = await impl.getWithEtag(CONFIG_KEY);
    const next = mutator({ ...(data || {}) });
    if (impl.casSupported) {
      const res = await impl.setConditional(CONFIG_KEY, next, etag);
      if (res.modified) return next;
      continue;
    }
    await impl.setPlain(CONFIG_KEY, next);
    return next;
  }
  throw new ApiError(503, 'BUSY', '系统繁忙，请稍后重试');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 某奖品的已抽数量 = 中奖记录中该奖品出现次数（记录为唯一事实来源，杜绝计数漂移） */
function prizeDrawnCount(winners, prizeId) {
  let count = 0;
  for (const w of winners) {
    if (w.prizeId === prizeId) count++;
  }
  return count;
}

function maxWinners() {
  const n = Number(process.env.MAX_WINNERS || DEFAULT_MAX_WINNERS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_WINNERS;
}

module.exports = {
  getImpl,
  readState,
  updateState,
  updateConfig,
  emptyState,
  prizeDrawnCount,
  maxWinners,
  STATE_KEY,
  CONFIG_KEY,
};
