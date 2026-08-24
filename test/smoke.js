'use strict';

/**
 * 本地冒烟测试：直接调用函数处理器（无需 netlify dev / 网络）。
 * 存储自动回退到本地文件（LOCAL_STORAGE_DIR 指向临时目录，每次全新）。
 *
 * 运行: node test/smoke.js
 */

const path = require('path');
const os = require('os');

process.env.LOCAL_STORAGE_DIR = path.join(os.tmpdir(), 'zerodim-test-' + Date.now());
process.env.ADMIN_PASSWORD = 'TestPass-12345';
process.env.RATE_LIMIT_LOGIN_MAX = '3';
process.env.RATE_LIMIT_CHANGE_PW_MAX = '10';
process.env.DRAW_MIN_INTERVAL_MS = '300';
process.env.MAX_WINNERS = '500';

const { handler } = require('../netlify/functions/api');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✔ ' + name);
  } else {
    fail++;
    failures.push(name);
    console.error('  ✘ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
  }
}

async function call(method, apiPath, { body, cookie, ip } = {}) {
  const headers = { 'x-nf-client-connection-ip': ip || '203.0.113.10', cookie: cookie || '' };
  const qIndex = apiPath.indexOf('?');
  const pathOnly = qIndex === -1 ? apiPath : apiPath.slice(0, qIndex);
  const queryStringParameters = {};
  if (qIndex !== -1) {
    for (const pair of apiPath.slice(qIndex + 1).split('&')) {
      const eq = pair.indexOf('=');
      if (eq === -1) queryStringParameters[decodeURIComponent(pair)] = '';
      else queryStringParameters[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
    }
  }
  const event = {
    httpMethod: method,
    path: pathOnly,
    rawUrl: 'http://localhost' + apiPath,
    headers,
    body: body !== undefined ? JSON.stringify(body) : null,
    queryStringParameters,
  };
  const res = await handler(event);
  let data = null;
  try {
    data = JSON.parse(res.body);
  } catch (err) {
    /* 非 JSON */
  }
  return { status: res.statusCode, headers: res.headers || {}, data };
}

function cookieFrom(res) {
  const sc = res.headers['Set-Cookie'] || res.headers['set-cookie'] || '';
  return sc.split(';')[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('== 零次元动漫社抽奖机 · 本地冒烟测试 ==');
  console.log('存储目录: ' + process.env.LOCAL_STORAGE_DIR + '\n');

  // ---------- 健康检查 ----------
  let r = await call('GET', '/api/health');
  check('GET /api/health -> 200 ok', r.status === 200 && r.data.ok === true);
  check('健康检查返回本地文件存储模式', r.data.mode === 'local-file');

  // ---------- 会话 / 登录 ----------
  r = await call('GET', '/api/session');
  check('未登录 GET /api/session -> authed=false', r.status === 200 && r.data.authed === false);

  r = await call('POST', '/api/login', { body: { password: 'wrong-pass' } });
  check('错误密码登录 -> 401', r.status === 401 && r.data.error === 'INVALID_CREDENTIALS');

  r = await call('POST', '/api/login', { body: {} });
  check('空密码登录 -> 400', r.status === 400);

  r = await call('POST', '/api/login', { body: { password: 'TestPass-12345' } });
  const cookie = cookieFrom(r);
  check('正确密码登录 -> 200 并下发会话 Cookie', r.status === 200 && cookie.startsWith('zerodim_session='));
  check(
    '会话 Cookie 含 HttpOnly / SameSite=Strict',
    /HttpOnly/i.test(r.headers['Set-Cookie']) && /SameSite=Strict/i.test(r.headers['Set-Cookie'])
  );

  r = await call('GET', '/api/session', { cookie });
  check('携带 Cookie 后 GET /api/session -> authed=true', r.status === 200 && r.data.authed === true);

  // ---------- 权限拦截 ----------
  r = await call('POST', '/api/prizes', { body: { name: '未授权奖品', total: 5 } });
  check('未登录添加奖品 -> 401', r.status === 401);

  // ---------- 奖品 CRUD ----------
  r = await call('POST', '/api/prizes', { body: { name: '测试手办', total: 3 }, cookie });
  check('添加奖品「测试手办」', r.status === 201 && !!r.data.prize && !!r.data.prize.id);
  const prize1 = r.data.prize;

  r = await call('POST', '/api/prizes', { body: { name: '测试徽章', total: 2 }, cookie });
  check('添加奖品「测试徽章」', r.status === 201);
  const prize2 = r.data.prize;

  r = await call('GET', '/api/prizes');
  check(
    '公开 GET /api/prizes 返回 2 个奖品且剩余=总数',
    r.status === 200 && r.data.prizes.length === 2 && r.data.prizes.every((p) => p.remaining === p.total)
  );

  // 输入校验
  r = await call('POST', '/api/prizes', { body: { name: '<script>alert(1)</script>', total: 1 }, cookie });
  check('奖品名含 <> 被拒绝', r.status === 400);
  r = await call('POST', '/api/prizes', { body: { name: 'x'.repeat(41), total: 1 }, cookie });
  check('奖品名超长被拒绝', r.status === 400);
  r = await call('POST', '/api/prizes', { body: { name: '合法奖品', total: 0 }, cookie });
  check('奖品总数 0 被拒绝', r.status === 400);
  r = await call('POST', '/api/prizes', { body: { name: '合法奖品', total: 'abc' }, cookie });
  check('奖品总数非数字被拒绝', r.status === 400);
  r = await call('POST', '/api/prizes', { body: { name: '   ', total: 1 }, cookie });
  check('奖品名为空白被拒绝', r.status === 400);

  // ---------- 次数管理 ----------
  r = await call('POST', '/api/chances', { body: { userId: '测试酱' }, cookie });
  check('为「测试酱」+1 次', r.status === 200 && r.data.chances === 1);
  r = await call('POST', '/api/chances', { body: { userId: '<img src=x onerror=alert(1)>' }, cookie });
  check('非法用户 ID（HTML 字符）被拒绝', r.status === 400);
  r = await call('POST', '/api/chances', { body: { userId: 'a'.repeat(25) }, cookie });
  check('用户 ID 超长被拒绝', r.status === 400);

  // ---------- 抽奖 ----------
  r = await call('POST', '/api/draw', { body: { userId: '测试酱' } });
  check(
    '「测试酱」抽奖成功且奖品合法、次数归零',
    r.status === 200 &&
      !!r.data.prize &&
      ['测试手办', '测试徽章'].includes(r.data.prize.name) &&
      r.data.remainingChances === 0
  );

  await sleep(350); // 等待抽奖间隔窗口
  r = await call('POST', '/api/draw', { body: { userId: '测试酱' } });
  check('次数耗尽后抽奖 -> NO_CHANCES', r.status === 400 && r.data.error === 'NO_CHANCES');

  r = await call('GET', '/api/winners?limit=10');
  check(
    '公开最近中奖记录包含该用户',
    r.status === 200 && r.data.winners.length === 1 && r.data.winners[0].userId === '测试酱'
  );

  // ---------- 管理端中奖记录 ----------
  r = await call('GET', '/api/winners?limit=50&all=1');
  check('未登录查看全部中奖记录 -> 401', r.status === 401);
  r = await call('GET', '/api/winners?limit=50&all=1', { cookie });
  check('管理员查看全部中奖记录', r.status === 200 && r.data.winners.length === 1);

  // ---------- 编辑 / 删除奖品 ----------
  r = await call('PUT', '/api/prizes/' + prize2.id, { body: { name: '测试徽章·改' }, cookie });
  check('编辑奖品名称', r.status === 200 && r.data.prize.name === '测试徽章·改');
  r = await call('PUT', '/api/prizes/' + prize2.id, { body: { total: 5 }, cookie });
  check('编辑奖品总数', r.status === 200 && r.data.prize.total === 5);
  r = await call('PUT', '/api/prizes/' + prize2.id, { body: {}, cookie });
  check('空编辑请求 -> 400', r.status === 400);
  r = await call('PUT', '/api/prizes/000000000000', { body: { name: 'x' }, cookie });
  check('编辑不存在的奖品 -> 404', r.status === 404);
  r = await call('DELETE', '/api/prizes/' + prize2.id, { cookie });
  check('删除奖品', r.status === 200);
  r = await call('GET', '/api/prizes');
  check('删除后奖品列表剩 1 个', r.status === 200 && r.data.prizes.length === 1);

  // ---------- 次数查询（管理） ----------
  r = await call('GET', '/api/chances?userId=' + encodeURIComponent('测试酱'));
  check('未登录查询次数 -> 401', r.status === 401);
  r = await call('GET', '/api/chances?userId=' + encodeURIComponent('测试酱'), { cookie });
  check('管理员查询「测试酱」次数 = 0', r.status === 200 && r.data.chances === 0);

  // ---------- 修改密码 ----------
  r = await call('POST', '/api/change-password', {
    body: { currentPassword: 'wrong', newPassword: 'NewPass-67890', confirmPassword: 'NewPass-67890' },
    cookie,
  });
  check('当前密码错误 -> 401', r.status === 401);
  r = await call('POST', '/api/change-password', {
    body: { currentPassword: 'TestPass-12345', newPassword: 'NewPass-67890', confirmPassword: 'NewPass-67890x' },
    cookie,
  });
  check('两次新密码不一致 -> 400', r.status === 400);
  r = await call('POST', '/api/change-password', {
    body: { currentPassword: 'TestPass-12345', newPassword: 'short12', confirmPassword: 'short12' },
    cookie,
  });
  check('新密码过短 -> 400', r.status === 400);
  r = await call('POST', '/api/change-password', {
    body: { currentPassword: 'TestPass-12345', newPassword: 'TestPass-12345', confirmPassword: 'TestPass-12345' },
    cookie,
  });
  check('新密码与当前相同 -> 400', r.status === 400);
  r = await call('POST', '/api/change-password', {
    body: { currentPassword: 'TestPass-12345', newPassword: 'NewPass-67890', confirmPassword: 'NewPass-67890' },
    cookie,
  });
  check('修改密码成功', r.status === 200);

  r = await call('GET', '/api/chances?userId=' + encodeURIComponent('测试酱'), { cookie });
  check('修改密码后旧会话已失效 -> 401', r.status === 401);
  // 换新 IP：此前 203.0.113.10 的登录额度已用完（RATE_LIMIT_LOGIN_MAX=3）
  r = await call('POST', '/api/login', { body: { password: 'TestPass-12345' }, ip: '203.0.113.50' });
  check('旧密码登录 -> 401', r.status === 401);
  r = await call('POST', '/api/login', { body: { password: 'NewPass-67890' }, ip: '203.0.113.50' });
  const cookie2 = cookieFrom(r);
  check('新密码登录 -> 200', r.status === 200 && cookie2.startsWith('zerodim_session='));

  // ---------- 速率限制（登录防爆破） ----------
  let limited = false;
  for (let i = 0; i < 4; i++) {
    r = await call('POST', '/api/login', { body: { password: 'nope' }, ip: '203.0.113.77' });
    if (r.status === 429) limited = true;
  }
  check('登录接口速率限制生效（3 次后 429）', limited);
  r = await call('POST', '/api/login', { body: { password: 'nope' }, ip: '203.0.113.78' });
  check('不同 IP 不受影响', r.status === 401);

  // ---------- 抽奖间隔限制（防连点刷奖） ----------
  await call('POST', '/api/chances', { body: { userId: '慢速酱', amount: 2 }, cookie: cookie2 });
  r = await call('POST', '/api/draw', { body: { userId: '慢速酱' } });
  check('首次抽奖成功', r.status === 200);
  r = await call('POST', '/api/draw', { body: { userId: '慢速酱' } });
  check('立即连点 -> TOO_FAST', r.status === 429 && r.data.error === 'TOO_FAST');
  await sleep(350);
  r = await call('POST', '/api/draw', { body: { userId: '慢速酱' } });
  check('间隔后再次抽奖成功', r.status === 200);

  // ---------- 并发抽奖（不超发） ----------
  // 5 个不同用户各 1 次机会，并发抽取仅剩 3 份的奖品：必须恰好 3 次成功、不超发。
  // （同用户的连点由 DRAW_MIN_INTERVAL_MS 门禁拦截，已在上面 TOO_FAST 用例验证）
  await call('DELETE', '/api/prizes/' + prize1.id, { cookie: cookie2 });
  await call('POST', '/api/prizes', { body: { name: '并发奖品', total: 3 }, cookie: cookie2 });
  for (let i = 1; i <= 5; i++) {
    await call('POST', '/api/chances', { body: { userId: '并发酱' + i, amount: 1 }, cookie: cookie2 });
  }
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      call('POST', '/api/draw', { body: { userId: '并发酱' + (i + 1) }, ip: '203.0.113.99' })
    )
  );
  const successCount = results.filter((x) => x.status === 200).length;
  r = await call('GET', '/api/prizes');
  const cp = r.data.prizes.find((p) => p.name === '并发奖品');
  check('5 个用户并发抽 3 份奖品恰好 3 次成功', successCount === 3, results.map((x) => x.status));
  check('并发后库存不超发（已抽=3 / 剩余=0）', !!cp && cp.drawn === 3 && cp.remaining === 0);
  let chancesLeft = 0;
  for (let i = 1; i <= 5; i++) {
    r = await call('GET', '/api/chances?userId=' + encodeURIComponent('并发酱' + i), { cookie: cookie2 });
    chancesLeft += r.data.chances;
  }
  check('并发后 5 名用户剩余总次数 = 2', chancesLeft === 2);

  // ---------- 重置活动 ----------
  r = await call('POST', '/api/reset');
  check('未登录重置 -> 401', r.status === 401);
  r = await call('POST', '/api/reset', { cookie: cookie2 });
  check('重置活动成功', r.status === 200);
  r = await call('GET', '/api/winners?limit=10');
  check('重置后中奖记录已清空', r.status === 200 && r.data.winners.length === 0 && r.data.total === 0);
  r = await call('GET', '/api/chances?userId=' + encodeURIComponent('慢速酱'), { cookie: cookie2 });
  check('重置后用户次数归零', r.status === 200 && r.data.chances === 0);
  r = await call('GET', '/api/prizes');
  check('重置后各奖品已抽归零、剩余恢复', r.status === 200 && r.data.prizes.every((p) => p.drawn === 0 && p.remaining === p.total));

  // ---------- 登出 ----------
  r = await call('POST', '/api/logout', { cookie: cookie2 });
  check('登出成功', r.status === 200);
  r = await call('GET', '/api/chances?userId=x', { cookie: cookie2 });
  check('登出后会话失效 -> 401', r.status === 401);

  // ---------- 汇总 ----------
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  if (failures.length) {
    console.error('失败项: ' + failures.join(' | '));
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('测试崩溃:', err);
  process.exit(1);
});
