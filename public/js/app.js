'use strict';

/**
 * 零次元动漫社抽奖机 · 前端逻辑（原生 JS，无构建链）
 *
 * 安全约定：
 *   - 所有动态内容一律使用 textContent / input.value 渲染，绝不拼接 innerHTML，
 *     从根本上防止 XSS（配合服务端输入白名单校验 + 严格 CSP）；
 *   - 无任何内联脚本 / 内联样式（满足 CSP: script-src 'self'; style-src 'self'）；
 *   - 抽奖结果完全由服务端生成，前端只提交用户 ID。
 */

(() => {
  const API = '/api';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ================= 工具 ================= */

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /* ================= Toast ================= */

  function toast(msg, type = 'info') {
    const item = el('div', `toast toast-${type}`, msg);
    $('#toast-root').appendChild(item);
    requestAnimationFrame(() => item.classList.add('is-show'));
    setTimeout(() => {
      item.classList.remove('is-show');
      setTimeout(() => item.remove(), 320);
    }, 3200);
  }

  /* ================= 确认弹窗 ================= */

  function confirmDialog({ title = '确认操作', text = '确定要执行此操作吗？', danger = true, okText = '确认' } = {}) {
    return new Promise((resolve) => {
      const root = $('#modal-root');
      const okBtn = $('#modal-ok');
      const cancelBtn = $('#modal-cancel');
      const mask = $('.modal-mask', root);
      $('#modal-title').textContent = title;
      $('#modal-text').textContent = text;
      okBtn.textContent = okText;
      okBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
      const close = (val) => {
        root.hidden = true;
        document.body.classList.remove('modal-open');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        mask.removeEventListener('click', onCancel);
        resolve(val);
      };
      const onOk = () => close(true);
      const onCancel = () => close(false);
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      mask.addEventListener('click', onCancel);
      root.hidden = false;
      document.body.classList.add('modal-open');
      okBtn.focus();
    });
  }

  /* ================= API 封装（统一错误处理） ================= */

  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    opts.signal = ctrl.signal;
    let res;
    try {
      res = await fetch(API + path, opts);
    } catch (err) {
      clearTimeout(timer);
      const e = new Error('无法连接服务器（离线 / 本地模式）');
      e.kind = 'network';
      throw e;
    }
    clearTimeout(timer);
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      /* 非 JSON 响应 */
    }
    if (!res.ok) {
      const e = new Error((data && data.message) || `请求失败（HTTP ${res.status}）`);
      e.code = data && data.error;
      e.status = res.status;
      e.kind = 'http';
      throw e;
    }
    return data || {};
  }

  /* ================= 状态指示（连接中 / 已连接 / 同步中 / 离线） ================= */

  let statusKind = 'connecting';

  const STATUS_TEXT = {
    connecting: '连接中…',
    online: '已连接 · 云端同步正常',
    syncing: '同步中…',
    offline: '离线 / 本地模式',
  };

  /** 状态标签缓存：本地开发模式与云端模式文案不同 */
  let lastMode = 'cloud';

  function setStatus(kind) {
    statusKind = kind;
    const pill = $('#status-pill');
    pill.className = 'status-pill is-' + kind;
    $('#status-label').textContent = STATUS_TEXT[kind] || kind;
    $('#offline-banner').hidden = kind !== 'offline';
    $('#btn-draw').disabled = kind === 'offline' || kind === 'syncing' || kind === 'connecting';
  }

  function applyOnlineLabel() {
    $('#status-label').textContent =
      lastMode === 'local-file' ? '已连接 · 本地开发模式' : STATUS_TEXT.online;
  }

  /**
   * 健康检查。force=true 时忽略「同步中」守卫——
   * 操作结束后的状态回读必须强制执行，否则状态胶囊会永远停在「同步中…」。
   */
  async function healthCheck(force = false) {
    if (statusKind === 'syncing' && !force) return;
    try {
      const d = await api('GET', '/health');
      lastMode = d.mode || 'cloud';
      setStatus('online');
      applyOnlineLabel();
    } catch (err) {
      setStatus('offline');
    }
  }

  /** 包裹任意操作：期间状态显示「同步中」，结束后强制回读真实状态 */
  async function withSync(fn) {
    setStatus('syncing');
    try {
      return await fn();
    } finally {
      await healthCheck(true);
    }
  }

  /* ================= 标签页切换 ================= */

  function switchTab(name) {
    const isParticipant = name === 'participant';
    $('#tab-participant').classList.toggle('is-active', isParticipant);
    $('#tab-admin').classList.toggle('is-active', !isParticipant);
    $('#tab-participant').setAttribute('aria-selected', String(isParticipant));
    $('#tab-admin').setAttribute('aria-selected', String(!isParticipant));
    $('#panel-participant').classList.toggle('is-active', isParticipant);
    $('#panel-admin').classList.toggle('is-active', !isParticipant);
    if (isParticipant) {
      loadPrizePool();
      loadWinners();
    } else {
      checkAdmin();
    }
  }

  /* ================= 参与者：奖品池 ================= */

  async function loadPrizePool() {
    try {
      const d = await api('GET', '/prizes');
      const list = $('#prize-pool');
      list.replaceChildren();
      let remaining = 0;
      for (const p of d.prizes) {
        remaining += p.remaining;
        const chip = el('li', 'chip');
        chip.append(el('span', 'chip-name', p.name), el('span', 'chip-count', `×${p.remaining}`));
        list.appendChild(chip);
      }
      $('#prize-pool-summary').textContent = `共 ${d.prizes.length} 种 · 剩余 ${remaining} 份`;
    } catch (err) {
      if (err.kind === 'network') setStatus('offline');
      $('#prize-pool-summary').textContent = '奖品池加载失败';
    }
  }

  /* ================= 参与者：最近中奖 ================= */

  async function loadWinners() {
    try {
      const d = await api('GET', '/winners?limit=10');
      const list = $('#recent-winners');
      list.replaceChildren();
      $('#winners-empty').hidden = d.winners.length > 0;
      for (const w of d.winners) {
        const li = el('li', 'winner-item');
        li.append(
          el('span', 'winner-user', w.userId),
          el('span', 'winner-prize', `抽中「${w.prizeName}」`),
          el('span', 'winner-time', fmtTime(w.time))
        );
        list.appendChild(li);
      }
    } catch (err) {
      if (err.kind === 'network') setStatus('offline');
    }
  }

  /* ================= 参与者：抽奖 ================= */

  function showDrawError(msg) {
    const box = $('#draw-error');
    box.textContent = msg;
    box.hidden = false;
  }

  function showDrawResult(prizeName, chances) {
    const box = $('#draw-result');
    $('#result-prize').textContent = prizeName;
    $('#result-chances').textContent = `剩余抽奖次数：${chances}`;
    box.hidden = false;
    box.classList.remove('is-show');
    void box.offsetWidth; // 重启动画
    box.classList.add('is-show');
    burstConfetti();
    $('#draw-error').hidden = true;
  }

  function burstConfetti() {
    const box = $('#confetti');
    box.replaceChildren();
    const colors = ['#ff6ec7', '#ffd166', '#7ee8fa', '#b388ff', '#ff8fab', '#80ffdb'];
    for (let i = 0; i < 26; i++) {
      const piece = el('i');
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = colors[i % colors.length];
      piece.style.animationDelay = `${Math.random() * 0.4}s`;
      piece.style.animationDuration = `${1.1 + Math.random() * 1}s`;
      box.appendChild(piece);
    }
  }

  async function doDraw() {
    const userId = $('#draw-user').value.trim();
    if (!userId) {
      showDrawError('请先输入用户 ID 或昵称再抽奖～');
      return;
    }
    const btn = $('#btn-draw');
    btn.disabled = true;
    btn.textContent = '🎲 抽奖中…';
    $('#draw-error').hidden = true;
    try {
      const d = await withSync(() => api('POST', '/draw', { userId }));
      showDrawResult(d.prize.name, d.remainingChances);
      toast('🎉 恭喜中奖！', 'success');
      loadWinners();
      loadPrizePool();
    } catch (err) {
      const msgs = {
        NO_CHANCES: '抽奖次数不足，请联系管理员增加次数～',
        OUT_OF_STOCK: '奖品已经全部抽完啦，下次活动再来吧～',
        TOO_FAST: '手速太快啦，请慢一点再试～',
        RATE_LIMITED: '操作太频繁了，请稍后再试～',
        BUSY: '系统繁忙，请稍后重试～',
      };
      showDrawError(msgs[err.code] || err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ 抽 奖 ✨';
    }
  }

  /* ================= 管理者：会话与视图 ================= */

  async function checkAdmin() {
    try {
      const d = await api('GET', '/session');
      renderAdminView(!!d.authed);
    } catch (err) {
      renderAdminView(false);
    }
  }

  function renderAdminView(authed) {
    $('#admin-login').hidden = authed;
    $('#admin-panel').hidden = !authed;
    if (authed) {
      loadAdminData();
    }
  }

  async function loadAdminData() {
    await Promise.all([loadPrizesAdmin(), loadWinnersAdmin(), loadUsersAdmin()]);
  }

  /* ---------- 登录 / 锁定 ---------- */

  async function doLogin() {
    const password = $('#admin-pass').value;
    const errBox = $('#login-error');
    errBox.hidden = true;
    if (!password) {
      errBox.textContent = '请输入管理员密码';
      errBox.hidden = false;
      return;
    }
    const btn = $('#btn-login');
    btn.disabled = true;
    try {
      await withSync(() => api('POST', '/login', { password }));
      $('#admin-pass').value = '';
      toast('登录成功', 'success');
      await checkAdmin();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  async function doLock() {
    try {
      await withSync(() => api('POST', '/logout'));
    } catch (err) {
      /* 即使网络失败也要切回登录视图 */
    }
    renderAdminView(false);
    toast('面板已锁定');
  }

  /* ---------- 奖品管理 ---------- */

  async function loadPrizesAdmin() {
    try {
      const d = await api('GET', '/prizes');
      renderPrizeRows(d.prizes);
    } catch (err) {
      if (err.status === 401) {
        renderAdminView(false);
        toast('登录已过期，请重新登录', 'error');
      } else {
        toast(err.message, 'error');
      }
    }
  }

  function renderPrizeRows(prizes) {
    const tb = $('#prize-rows');
    tb.replaceChildren();
    let drawn = 0;
    let remaining = 0;
    for (const p of prizes) {
      drawn += p.drawn;
      remaining += p.remaining;
    }
    $('#prize-summary').textContent = `共 ${prizes.length} 种 · 已抽 ${drawn} · 剩余 ${remaining}`;
    if (!prizes.length) {
      const tr = el('tr');
      const td = el('td', 'muted center', '还没有奖品，先添加一个吧！');
      td.colSpan = 5;
      tr.appendChild(td);
      tb.appendChild(tr);
      return;
    }
    for (const p of prizes) tb.appendChild(buildPrizeRow(p));
  }

  function buildPrizeRow(p) {
    const tr = el('tr');
    tr.append(
      el('td', null, p.name),
      el('td', null, String(p.total)),
      el('td', null, String(p.drawn)),
      el('td', null, String(p.remaining))
    );
    const tdAct = el('td');
    const btnEdit = el('button', 'btn btn-ghost btn-sm', '编辑');
    const btnDel = el('button', 'btn btn-danger btn-sm', '删除');
    btnEdit.addEventListener('click', () => tr.replaceWith(buildPrizeEditRow(p)));
    btnDel.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '删除奖品',
        text: `确定删除「${p.name}」吗？已有的中奖记录会保留。`,
        okText: '删除',
      });
      if (!ok) return;
      try {
        await withSync(() => api('DELETE', `/prizes/${p.id}`));
        toast('奖品已删除', 'success');
        loadPrizesAdmin();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    tdAct.append(btnEdit, btnDel);
    tr.appendChild(tdAct);
    return tr;
  }

  function buildPrizeEditRow(p) {
    const tr = el('tr');
    const tdName = el('td');
    const inName = el('input', 'row-input');
    inName.type = 'text';
    inName.maxLength = 40;
    inName.value = p.name;
    tdName.appendChild(inName);
    const tdTotal = el('td');
    const inTotal = el('input', 'row-input');
    inTotal.type = 'number';
    inTotal.min = 1;
    inTotal.max = 99999;
    inTotal.value = p.total;
    tdTotal.appendChild(inTotal);
    tr.append(tdTotal, el('td', null, String(p.drawn)), el('td', null, String(p.remaining)));
    const tdAct = el('td');
    const btnSave = el('button', 'btn btn-primary btn-sm', '保存');
    const btnCancel = el('button', 'btn btn-ghost btn-sm', '取消');
    btnSave.addEventListener('click', async () => {
      const name = inName.value.trim();
      const total = Number(inTotal.value);
      if (!name) {
        toast('奖品名称不能为空', 'error');
        return;
      }
      if (!Number.isInteger(total) || total < 1) {
        toast('总数需为大于 0 的整数', 'error');
        return;
      }
      try {
        await withSync(() => api('PUT', `/prizes/${p.id}`, { name, total }));
        toast('奖品已更新', 'success');
        loadPrizesAdmin();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    btnCancel.addEventListener('click', () => loadPrizesAdmin());
    tdAct.append(btnSave, btnCancel);
    tr.appendChild(tdAct);
    return tr;
  }

  async function doAddPrize() {
    const nameInput = $('#prize-name');
    const totalInput = $('#prize-total');
    const errBox = $('#prize-admin-error');
    const name = nameInput.value.trim();
    const total = Number(totalInput.value);
    errBox.hidden = true;
    if (!name) {
      errBox.textContent = '请输入奖品名称';
      errBox.hidden = false;
      return;
    }
    if (!Number.isInteger(total) || total < 1) {
      errBox.textContent = '总数需为大于 0 的整数';
      errBox.hidden = false;
      return;
    }
    try {
      await withSync(() => api('POST', '/prizes', { name, total }));
      nameInput.value = '';
      totalInput.value = '';
      toast('奖品已添加', 'success');
      loadPrizesAdmin();
      loadPrizePool();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  }

  /* ---------- 次数管理 ---------- */

  async function doAddChance() {
    const userId = $('#chance-user').value.trim();
    const amount = Number($('#chance-amount').value || 1);
    const out = $('#chance-result');
    if (!userId) {
      toast('请输入用户 ID', 'error');
      return;
    }
    if (!Number.isInteger(amount) || amount < 1) {
      toast('增加次数需为大于 0 的整数', 'error');
      return;
    }
    try {
      const d = await withSync(() => api('POST', '/chances', { userId, amount }));
      out.hidden = false;
      out.textContent = `已为「${d.userId}」增加 ${amount} 次，当前剩余 ${d.chances} 次`;
      loadUsersAdmin();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------- 用户列表与批量次数（管理） ---------- */

  async function loadUsersAdmin() {
    try {
      const d = await api('GET', '/users');
      const tb = $('#user-rows');
      tb.replaceChildren();
      $('#user-count').textContent = String(d.users.length);
      $('#users-empty').hidden = d.users.length > 0;
      for (const u of d.users) tb.appendChild(buildUserRow(u));
    } catch (err) {
      if (err.status === 401) {
        renderAdminView(false);
      } else {
        toast(err.message, 'error');
      }
    }
  }

  function buildUserRow(u) {
    const tr = el('tr');
    tr.dataset.userId = u.userId;
    tr.append(el('td', null, u.userId), el('td', null, String(u.chances)));
    const tdNew = el('td');
    const input = el('input', 'row-input chances-input');
    input.type = 'number';
    input.min = 0;
    input.max = 9999;
    input.value = u.chances;
    input.dataset.original = String(u.chances);
    tdNew.appendChild(input);
    tr.appendChild(tdNew);
    const tdAct = el('td');
    const btnDel = el('button', 'btn btn-danger btn-sm', '删除');
    btnDel.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '删除用户',
        text: `确定删除用户「${u.userId}」吗？其抽奖次数将被清除，历史中奖记录会保留。`,
        okText: '删除',
      });
      if (!ok) return;
      try {
        await withSync(() => api('DELETE', '/users/' + encodeURIComponent(u.userId)));
        toast('用户已删除', 'success');
        loadUsersAdmin();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    tdAct.appendChild(btnDel);
    tr.appendChild(tdAct);
    return tr;
  }

  /** 收集表格中修改过的行；任一输入非法时返回 { error } */
  function collectUserChanges() {
    const changes = [];
    for (const tr of $$('#user-rows tr')) {
      const input = $('.chances-input', tr);
      const userId = tr.dataset.userId;
      const original = Number(input.dataset.original);
      const raw = input.value.trim();
      const value = Number(raw);
      if (raw === '' || !Number.isInteger(value) || value < 0 || value > 9999) {
        return { error: `「${userId}」的次数需为 0-9999 的整数` };
      }
      if (value !== original) changes.push({ userId, chances: value });
    }
    return { changes };
  }

  /** 分批提交（后端单次上限 300 条），整批为原子操作 */
  async function sendBatchOps(operations) {
    let updated = 0;
    for (let i = 0; i < operations.length; i += 200) {
      const d = await api('POST', '/users/chances', { operations: operations.slice(i, i + 200) });
      updated += d.updated || 0;
    }
    return updated;
  }

  async function doSaveUsers() {
    const { changes, error } = collectUserChanges();
    if (error) {
      toast(error, 'error');
      return;
    }
    if (!changes.length) {
      toast('没有需要保存的修改', 'info');
      return;
    }
    try {
      const updated = await withSync(() => sendBatchOps(changes));
      toast(`已保存 ${updated} 项修改`, 'success');
      loadUsersAdmin();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function doSetAll() {
    const value = Number($('#batch-set-value').value);
    if (!Number.isInteger(value) || value < 0 || value > 9999) {
      toast('请输入 0-9999 的整数', 'error');
      return;
    }
    const rows = $$('#user-rows tr');
    if (!rows.length) {
      toast('还没有注册用户', 'info');
      return;
    }
    const ok = await confirmDialog({
      title: '批量设置次数',
      text: `确定把所有 ${rows.length} 名用户的抽奖次数都设为 ${value} 次吗？`,
      okText: '确认设置',
    });
    if (!ok) return;
    try {
      const updated = await withSync(() =>
        sendBatchOps(rows.map((tr) => ({ userId: tr.dataset.userId, chances: value })))
      );
      toast(`已设置 ${updated} 名用户`, 'success');
      loadUsersAdmin();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------- 中奖记录（管理） ---------- */

  async function loadWinnersAdmin() {
    try {
      const d = await api('GET', '/winners?limit=50&all=1');
      const tb = $('#winner-rows');
      tb.replaceChildren();
      $('#winners-admin-empty').hidden = d.winners.length > 0;
      for (const w of d.winners) {
        const tr = el('tr');
        tr.append(el('td', null, w.userId), el('td', null, w.prizeName), el('td', null, fmtTime(w.time)));
        tb.appendChild(tr);
      }
    } catch (err) {
      if (err.status === 401) {
        renderAdminView(false);
      } else {
        toast(err.message, 'error');
      }
    }
  }

  /* ---------- 重置活动 ---------- */

  async function doReset() {
    const ok = await confirmDialog({
      title: '重置活动',
      text: '确定要重置活动吗？将清空所有中奖记录、所有用户抽奖次数，并归零各奖品已抽数量。此操作不可恢复！',
      okText: '确认重置',
    });
    if (!ok) return;
    try {
      const d = await withSync(() => api('POST', '/reset'));
      toast(d.message || '活动已重置', 'success');
      loadAdminData();
      loadPrizePool();
      loadWinners();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------- 修改密码 ---------- */

  async function doChangePassword() {
    const current = $('#pw-current').value;
    const next = $('#pw-new').value;
    const confirm = $('#pw-confirm').value;
    const errBox = $('#pw-error');
    errBox.hidden = true;
    if (!current) {
      errBox.textContent = '请输入当前密码';
      errBox.hidden = false;
      return;
    }
    if (next.length < 8 || next.length > 64) {
      errBox.textContent = '新密码长度需为 8-64 位';
      errBox.hidden = false;
      return;
    }
    if (next !== confirm) {
      errBox.textContent = '两次输入的新密码不一致';
      errBox.hidden = false;
      return;
    }
    const btn = $('#btn-change-pw');
    btn.disabled = true;
    try {
      const d = await withSync(() =>
        api('POST', '/change-password', { currentPassword: current, newPassword: next, confirmPassword: confirm })
      );
      $('#pw-current').value = '';
      $('#pw-new').value = '';
      $('#pw-confirm').value = '';
      renderAdminView(false);
      toast(d.message || '密码已修改，请重新登录', 'success');
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  /* ================= 事件绑定与启动 ================= */

  function bindEvents() {
    $('#tab-participant').addEventListener('click', () => switchTab('participant'));
    $('#tab-admin').addEventListener('click', () => switchTab('admin'));

    $('#btn-draw').addEventListener('click', doDraw);
    $('#btn-refresh-winners').addEventListener('click', loadWinners);
    $('#draw-user').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doDraw();
    });

    $('#btn-login').addEventListener('click', doLogin);
    $('#admin-pass').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLogin();
    });
    $('#btn-lock').addEventListener('click', doLock);
    $('#btn-refresh-admin').addEventListener('click', loadAdminData);
    $('#btn-add-prize').addEventListener('click', doAddPrize);
    $('#btn-add-chance').addEventListener('click', doAddChance);
    $('#btn-save-users').addEventListener('click', doSaveUsers);
    $('#btn-set-all').addEventListener('click', doSetAll);
    $('#batch-set-value').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSetAll();
    });
    $('#btn-reset').addEventListener('click', doReset);
    $('#btn-change-pw').addEventListener('click', doChangePassword);
  }

  function init() {
    bindEvents();
    switchTab('participant');
    setStatus('connecting');
    healthCheck();
    loadPrizePool();
    loadWinners();
    // 定时健康检查：反映后端/数据同步状态
    setInterval(healthCheck, 20000);
    // 参与者页可见时自动刷新最近中奖
    setInterval(() => {
      if (
        statusKind !== 'offline' &&
        statusKind !== 'syncing' &&
        $('#tab-participant').classList.contains('is-active')
      ) {
        loadWinners();
      }
    }, 15000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
