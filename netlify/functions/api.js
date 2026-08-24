'use strict';

/**
 * 零次元动漫社抽奖机 · 后端统一入口（catch-all Netlify Function）
 *
 * netlify.toml 将 /api/* 重定向到本函数。所有敏感逻辑（认证、加权随机、
 * 库存扣减、次数扣减、记录写入）都在服务端完成，前端只传用户 ID。
 *
 * API 一览：
 *   GET  /api/health            健康检查（含存储模式，供前端状态指示）
 *   GET  /api/session           当前是否已登录管理员
 *   POST /api/login             管理员登录
 *   POST /api/logout            登出（锁定面板）
 *   POST /api/change-password   修改管理员密码（旧会话全部失效）
 *   GET  /api/prizes            奖品列表（含已抽/剩余，公开）
 *   POST /api/prizes            新增奖品（管理）
 *   PUT  /api/prizes/:id        编辑奖品（管理）
 *   DELETE /api/prizes/:id      删除奖品（管理）
 *   GET  /api/winners           最近中奖记录（?limit=，公开；?all=1 需管理）
 *   POST /api/draw              抽奖（服务端加权随机 + 原子扣减）
 *   GET  /api/chances?userId=   查询用户剩余次数（管理）
 *   POST /api/chances           为用户增加抽奖次数（管理）
 *   POST /api/reset             重置活动（清空中奖记录与所有用户次数）
 */

const crypto = require('crypto');
const {
  ApiError,
  json,
  error,
  parseBody,
  getClientIp,
  isHttpsRequest,
  sessionCookie,
} = require('./_shared/http');
const { hashPassword, verifyPassword, randomToken } = require('./_shared/crypto');
const { rateLimit } = require('./_shared/rate-limit');
const { getImpl, readState, updateState, prizeDrawnCount, maxWinners, invalidateImpl } = require('./_shared/storage');
const auth = require('./_shared/auth');
const v = require('./_shared/validate');

const MAX_PRIZES = 50;
const MAX_USERS = 1000;

/**
 * @netlify/blobs 的 Lambda 兼容模式要求先调用 connectLambda(event) 注入
 * Blobs 运行上下文（Netlify Functions v1 不会自动配置）。
 * 懒加载：本地无依赖（纯文件回退）时也不报错。
 */
let connectLambda = null;
try {
  connectLambda = require('@netlify/blobs').connectLambda;
} catch (err) {
  /* 未安装依赖时忽略 */
}

/* ---------------- 工具 ---------------- */

function parseRoute(event) {
  let path = event.path || '/';
  const raw = event.rawUrl;
  if (raw) {
    try {
      path = new URL(raw).pathname;
    } catch (err) {
      // 保留 event.path
    }
  }
  // 直接访问函数地址时归一化
  if (path === '/.netlify/functions/api') path = '/api';
  if (path.indexOf('/.netlify/functions/api/') === 0) {
    path = '/api' + path.slice('/.netlify/functions/api'.length);
  }
  const method = String(event.httpMethod || 'GET').toUpperCase();
  return { method, segments: path.split('/').filter(Boolean) };
}

function getQuery(event, name) {
  const q = event.queryStringParameters || {};
  return q[name] != null ? q[name] : null;
}

function withPrizeStats(prizes, winners) {
  return prizes.map((p) => {
    const drawn = prizeDrawnCount(winners, p.id);
    return { id: p.id, name: p.name, total: p.total, drawn, remaining: Math.max(0, p.total - drawn) };
  });
}

function drawIntervalMs() {
  const n = Number(process.env.DRAW_MIN_INTERVAL_MS || 800);
  return Number.isFinite(n) && n >= 0 ? n : 800;
}

/* ---------------- 处理器 ---------------- */

exports.handler = async (event) => {
  try {
    // 注入 Netlify Blobs 运行上下文（必须最先调用；无 blobs 上下文的
    // 本地/测试事件会自动跳过）。每个请求的令牌都是新签发的，
    // 因此注入成功后必须丢弃旧 Store 句柄，否则令牌过期后全部请求失败。
    if (connectLambda) {
      try {
        connectLambda(event);
        invalidateImpl();
      } catch (err) {
        /* 事件中无 blobs 字段（本地开发 / 测试）时忽略 */
      }
    }
    const { method, segments } = parseRoute(event);
    if (segments.length < 2 || segments[0] !== 'api') {
      return error(404, 'NOT_FOUND', '接口不存在');
    }
    const r1 = segments[1];
    const r2 = segments[2] || null;
    const ip = getClientIp(event);

    /* ---------- 健康检查 ---------- */
    if (method === 'GET' && r1 === 'health') {
      const impl = await getImpl();
      return json(200, { ok: true, mode: impl.mode, time: new Date().toISOString() });
    }

    /* ---------- 会话状态 ---------- */
    if (method === 'GET' && r1 === 'session') {
      const session = await auth.readSession(event);
      return json(200, { authed: !!session });
    }

    /* ---------- 登录 ---------- */
    if (method === 'POST' && r1 === 'login') {
      await rateLimit('login', ip);
      const body = parseBody(event);
      if (typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 128) {
        throw new ApiError(400, 'INVALID_PASSWORD', '请输入管理员密码');
      }
      const config = await auth.loadConfig();
      const ok = await verifyPassword(body.password, config.adminPasswordHash);
      if (!ok) {
        throw new ApiError(401, 'INVALID_CREDENTIALS', '管理员密码错误');
      }
      const token = await auth.createSession();
      return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(token, { secure: isHttpsRequest(event) }) });
    }

    /* ---------- 登出（锁定面板） ---------- */
    if (method === 'POST' && r1 === 'logout') {
      const session = await auth.readSession(event);
      if (session) await auth.destroySession(session.token);
      return json(200, { ok: true }, { 'Set-Cookie': sessionCookie('', { clear: true, secure: isHttpsRequest(event) }) });
    }

    /* ---------- 修改密码（旧会话全部失效） ---------- */
    if (method === 'POST' && r1 === 'change-password') {
      await auth.requireAdmin(event);
      await rateLimit('changePw', ip);
      const body = parseBody(event);
      const currentPassword = v.cleanPassword(body.currentPassword, { field: '当前密码', min: 1, max: 128 });
      const newPassword = v.cleanPassword(body.newPassword, { field: '新密码', min: 8, max: 64 });
      const confirmPassword = v.cleanPassword(body.confirmPassword, { field: '确认密码', min: 8, max: 64 });
      if (newPassword !== confirmPassword) {
        throw new ApiError(400, 'PASSWORD_MISMATCH', '两次输入的新密码不一致');
      }
      if (newPassword === currentPassword) {
        throw new ApiError(400, 'SAME_PASSWORD', '新密码不能与当前密码相同');
      }
      const config = await auth.loadConfig();
      const ok = await verifyPassword(currentPassword, config.adminPasswordHash);
      if (!ok) {
        throw new ApiError(401, 'INVALID_CREDENTIALS', '当前密码错误');
      }
      const newHash = await hashPassword(newPassword);
      // authVersion +1：使所有已签发的会话立即失效
      await auth.updateConfigWithHash(newHash);
      const session = await auth.readSession(event);
      if (session) await auth.destroySession(session.token);
      return json(
        200,
        { ok: true, message: '密码已修改，请重新登录' },
        { 'Set-Cookie': sessionCookie('', { clear: true, secure: isHttpsRequest(event) }) }
      );
    }

    /* ---------- 奖品列表（公开，含已抽/剩余统计） ---------- */
    if (method === 'GET' && r1 === 'prizes' && !r2) {
      const state = await readState();
      return json(200, { prizes: withPrizeStats(state.prizes, state.winners) });
    }

    /* ---------- 新增奖品（管理） ---------- */
    if (method === 'POST' && r1 === 'prizes' && !r2) {
      await auth.requireAdmin(event);
      await rateLimit('admin', ip);
      const body = parseBody(event);
      const name = v.cleanPrizeName(body.name);
      const total = v.cleanTotal(body.total);
      const result = await updateState((next) => {
        if (next.prizes.length >= MAX_PRIZES) {
          throw new ApiError(400, 'TOO_MANY_PRIZES', `奖品数量已达上限（${MAX_PRIZES} 种）`);
        }
        const prize = { id: randomToken(6), name, total };
        next.prizes.push(prize);
        return prize;
      });
      return json(201, { ok: true, prize: result.info });
    }

    /* ---------- 编辑 / 删除奖品（管理） ---------- */
    if ((method === 'PUT' || method === 'DELETE') && r1 === 'prizes' && r2) {
      await auth.requireAdmin(event);
      await rateLimit('admin', ip);
      const prizeId = v.cleanPrizeId(r2);

      if (method === 'PUT') {
        const body = parseBody(event);
        let name = null;
        let total = null;
        if (body.name !== undefined && body.name !== null && body.name !== '') {
          name = v.cleanPrizeName(body.name);
        }
        if (body.total !== undefined && body.total !== null && body.total !== '') {
          total = v.cleanTotal(body.total);
        }
        if (name === null && total === null) {
          throw new ApiError(400, 'NOTHING_TO_UPDATE', '请提供要修改的名称或总数');
        }
        const result = await updateState((next) => {
          const prize = next.prizes.find((p) => p.id === prizeId);
          if (!prize) {
            throw new ApiError(404, 'NOT_FOUND', '奖品不存在');
          }
          const drawn = prizeDrawnCount(next.winners, prizeId);
          if (total !== null && total < drawn) {
            throw new ApiError(400, 'TOTAL_TOO_SMALL', `奖品总数不能小于已抽数量（已抽 ${drawn}）`);
          }
          if (name !== null) prize.name = name;
          if (total !== null) prize.total = total;
          return { ...prize };
        });
        return json(200, { ok: true, prize: result.info });
      }

      // DELETE
      await updateState((next) => {
        const idx = next.prizes.findIndex((p) => p.id === prizeId);
        if (idx === -1) {
          throw new ApiError(404, 'NOT_FOUND', '奖品不存在');
        }
        next.prizes.splice(idx, 1);
        return null;
      });
      return json(200, { ok: true });
    }

    /* ---------- 中奖记录 ---------- */
    if (method === 'GET' && r1 === 'winners' && !r2) {
      const limit = v.cleanLimit(getQuery(event, 'limit') || '10');
      const wantAll = getQuery(event, 'all') === '1';
      if (wantAll) {
        await auth.requireAdmin(event);
      }
      const state = await readState();
      const list = wantAll ? state.winners : state.winners.slice(0, limit);
      return json(200, {
        winners: list.map((w) => ({
          id: w.id,
          userId: w.userId,
          prizeId: w.prizeId,
          prizeName: w.prizeName,
          time: w.time,
        })),
        total: state.winners.length,
      });
    }

    /* ---------- 抽奖（核心：服务端加权随机 + 原子扣减） ---------- */
    if (method === 'POST' && r1 === 'draw') {
      await rateLimit('draw', ip);
      const body = parseBody(event);
      const userId = v.cleanUserId(body.userId);
      const interval = drawIntervalMs();

      const result = await updateState((next) => {
        const user = next.users[userId];
        const chances = user ? user.chances : 0;
        if (chances <= 0) {
          throw new ApiError(400, 'NO_CHANCES', '抽奖次数不足，请联系管理员增加次数');
        }
        const now = Date.now();
        if (user.lastDrawAt && now - user.lastDrawAt < interval) {
          throw new ApiError(429, 'TOO_FAST', '手速太快啦，请稍后再试');
        }
        // 剩余库存以中奖记录计数为准（唯一事实来源）
        const available = next.prizes.filter((p) => prizeDrawnCount(next.winners, p.id) < p.total);
        if (!available.length) {
          throw new ApiError(400, 'OUT_OF_STOCK', '奖品已经全部抽完啦，下次活动再来吧');
        }
        // 权重 = 该奖品剩余份数（库存越多越容易抽中）
        let weightTotal = 0;
        for (const p of available) {
          weightTotal += p.total - prizeDrawnCount(next.winners, p.id);
        }
        let r = crypto.randomInt(0, weightTotal);
        let chosen = available[0];
        for (const p of available) {
          const w = p.total - prizeDrawnCount(next.winners, p.id);
          if (r < w) {
            chosen = p;
            break;
          }
          r -= w;
        }
        const record = {
          id: randomToken(8),
          userId,
          prizeId: chosen.id,
          prizeName: chosen.name,
          time: new Date().toISOString(),
        };
        next.winners.unshift(record);
        const cap = maxWinners();
        if (next.winners.length > cap) next.winners.length = cap;
        // 原子扣减次数
        next.users[userId] = { chances: chances - 1, lastDrawAt: now };
        return { record };
      });

      const rec = result.info.record;
      const user = result.state.users[userId];
      return json(200, {
        ok: true,
        prize: { id: rec.prizeId, name: rec.prizeName },
        remainingChances: user ? user.chances : 0,
        winnerId: rec.id,
        time: rec.time,
      });
    }

    /* ---------- 查询用户剩余次数（管理） ---------- */
    if (method === 'GET' && r1 === 'chances' && !r2) {
      await auth.requireAdmin(event);
      const userId = v.cleanUserId(getQuery(event, 'userId') || '');
      const state = await readState();
      const user = state.users[userId];
      return json(200, { userId, chances: user ? user.chances : 0 });
    }

    /* ---------- 增加抽奖次数（管理） ---------- */
    if (method === 'POST' && r1 === 'chances' && !r2) {
      await auth.requireAdmin(event);
      await rateLimit('admin', ip);
      const body = parseBody(event);
      const userId = v.cleanUserId(body.userId);
      const amount = body.amount === undefined || body.amount === null || body.amount === '' ? 1 : v.cleanAmount(body.amount);
      const result = await updateState((next) => {
        if (!next.users[userId] && Object.keys(next.users).length >= MAX_USERS) {
          throw new ApiError(400, 'TOO_MANY_USERS', '用户数量已达上限');
        }
        const cur = next.users[userId] || { chances: 0, lastDrawAt: 0 };
        next.users[userId] = { chances: cur.chances + amount, lastDrawAt: cur.lastDrawAt || 0 };
        return { chances: next.users[userId].chances };
      });
      return json(200, { ok: true, userId, chances: result.info.chances });
    }

    /* ---------- 重置活动（管理） ---------- */
    if (method === 'POST' && r1 === 'reset') {
      await auth.requireAdmin(event);
      await rateLimit('admin', ip);
      await updateState((next) => {
        next.winners = [];
        for (const key of Object.keys(next.users)) {
          next.users[key] = { chances: 0, lastDrawAt: 0 };
        }
        return null;
      });
      return json(200, { ok: true, message: '活动已重置' });
    }

    return error(404, 'NOT_FOUND', '接口不存在');
  } catch (err) {
    // 统一错误出口：绝不向客户端泄露堆栈 / 内部细节
    if (err instanceof ApiError) {
      return error(err.status, err.code, err.message, err.extraHeaders || {});
    }
    console.error('[api] 未捕获异常:', err);
    return error(500, 'INTERNAL', '服务器开小差了，请稍后再试');
  }
};
