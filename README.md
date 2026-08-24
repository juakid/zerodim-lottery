# 零次元动漫社抽奖机 🎴

二次元风格的社团活动抽奖应用：参与者输入用户 ID 抽奖，管理员在线管理奖品、次数与中奖记录。
**纯 HTML/CSS/JS 前端（无构建链）+ Netlify Functions 后端 + Netlify Blobs 持久化存储**，一次部署即可长期使用。

## 功能一览

| 角色 | 功能 |
| --- | --- |
| 参与者 | 输入用户 ID / 昵称抽奖；服务端加权随机；显示中奖结果与剩余次数；查看最近中奖记录；查看当前奖品池 |
| 管理者 | 密码登录 / 锁定面板（登出）；修改管理员密码（旧会话全部失效）；奖品增删改查（总数 / 已抽 / 剩余 / 总剩余）；中奖记录全览；重置活动；按用户增加抽奖次数；**用户列表 + 批量/统一设置次数 + 删除用户** |
| 状态提示 | 顶栏状态胶囊：连接中 / 已连接·云端同步正常 / 同步中 / 离线·本地模式（20 秒自动健康检查） |

## 目录结构

```
.
├── netlify.toml                  # Netlify 配置：发布目录 / 函数目录 / API 重定向 / 安全响应头
├── package.json                  # 依赖：@netlify/blobs（运行时）+ netlify-cli（开发）
├── .env.example                  # 环境变量示例（复制为 .env 使用）
├── .gitignore
├── README.md
├── public/                       # 前端静态文件（发布目录）
│   ├── index.html                # 单页应用（双标签页：抽奖入口 / 管理者）
│   ├── favicon.svg
│   ├── css/style.css             # 二次元风格样式（移动端适配）
│   └── js/app.js                 # 前端逻辑（原生 JS，全部 textContent 渲染防 XSS）
├── netlify/functions/
│   ├── api.js                    # 后端统一入口（catch-all 函数，/api/* 路由到此处）
│   └── _shared/                  # 共享模块（下划线前缀目录不会被 Netlify 当作函数）
│       ├── http.js               # 统一 JSON 响应 / Cookie / 请求体解析
│       ├── crypto.js             # scrypt 密码哈希与校验（timingSafeEqual）
│       ├── validate.js           # 服务端输入校验（长度 / 字符集白名单）
│       ├── storage.js            # Netlify Blobs 存储层 + CAS 原子更新 + 本地文件回退
│       ├── auth.js               # 服务端会话（HttpOnly Cookie + authVersion 失效机制）
│       └── rate-limit.js         # 令牌桶速率限制（持久化计数）
├── scripts/
│   └── hash-password.js          # 生成 ADMIN_PASSWORD_HASH（node scripts/hash-password.js "密码"）
└── test/
    ├── smoke.js                  # 本地冒烟测试（直接调用函数，56 项断言）
    └── dev-server.js             # 可选：无 CLI 的本地预览服务器
```

## 技术架构

- **前端**：`public/` 下的静态文件，无框架、无构建步骤。所有动态渲染使用 `textContent`，不拼接 `innerHTML`。
- **后端**：单一 catch-all Netlify Function（`netlify/functions/api.js`），`netlify.toml` 将 `/api/*` 重定向到它，路由在函数内分发。
- **存储**：Netlify Blobs（site 级 store，跨部署持久化）。数据模型为单文档 `state`（奖品 / 用户次数 / 中奖记录），全部业务状态通过**条件写（CAS，`onlyIfMatch` etag）**实现原子读-改-写，杜绝并发超发。
- **密码**：Node 内置 `crypto.scrypt`（OWASP 推荐 KDF）哈希存储，随机盐 + 常量时间比较。

## 快速开始（本地开发）

要求：Node.js ≥ 18。

```bash
# 1. 安装依赖（含 netlify-cli）
npm install

# 2. 生成管理员密码哈希（任选其一）
node scripts/hash-password.js "你的密码"        # 输出形如 scrypt$16384$8$1$... 的哈希

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env：填入 ADMIN_PASSWORD_HASH（或本地开发直接用 ADMIN_PASSWORD=你的密码）

# 4. 启动（同时运行静态站点 + 函数，模拟生产环境）
npm run dev        # 打开 http://localhost:8888
```

> 没有 netlify-cli 的环境可用 `node test/dev-server.js` 预览（零依赖，同样支持 /api/*）。
> 本地数据：`netlify dev` 支持 Blobs 时存本地 Blobs；不可用时自动回退到项目根目录 `.data/` 的 JSON 文件（已在 `.gitignore`）。

运行测试：

```bash
npm test           # 56 项冒烟测试：认证 / CRUD / 抽奖 / 并发不超发 / 速率限制 / XSS 输入 / 重置
```

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `ADMIN_PASSWORD_HASH` | 推荐 | — | 管理员密码哈希（`node scripts/hash-password.js "密码"` 生成） |
| `ADMIN_PASSWORD` | 本地 | — | 明文密码（启动时自动哈希，仅建议本地开发使用） |
| `ADMIN_PASSWORD_OVERRIDE` | 否 | `0` | 设为 `1` + 部署新哈希 = 紧急重置密码并使所有会话失效 |
| `SESSION_TTL_HOURS` | 否 | `12` | 管理员会话有效期（小时） |
| `DRAW_MIN_INTERVAL_MS` | 否 | `800` | 同一用户两次抽奖最小间隔，防脚本连点 |
| `MAX_WINNERS` | 否 | `500` | 中奖记录保留条数（超出丢最旧） |
| `RATE_LIMIT_LOGIN_MAX` / `_WINDOW` | 否 | `5` / `900` | 登录限流（次 / 秒窗口），防暴力破解 |
| `RATE_LIMIT_DRAW_MAX` / `_WINDOW` | 否 | `30` / `60` | 抽奖限流（每 IP） |
| `RATE_LIMIT_ADMIN_MAX` / `_WINDOW` | 否 | `120` / `60` | 管理接口限流 |
| `RATE_LIMIT_CHANGE_PW_MAX` / `_WINDOW` | 否 | `3` / `900` | 修改密码限流 |
| `BLOBS_STORE_NAME` | 否 | `zerodim-lottery` | Netlify Blobs store 名称 |

## API 一览

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | 公开 | 健康检查（含存储模式） |
| GET | `/api/session` | 公开 | 当前是否已登录管理员 |
| POST | `/api/login` | 公开·限流 | 登录，下发 HttpOnly 会话 Cookie |
| POST | `/api/logout` | 公开 | 登出（锁定面板） |
| POST | `/api/change-password` | 管理 | 修改密码（旧会话全部失效） |
| GET | `/api/prizes` | 公开 | 奖品列表（总数 / 已抽 / 剩余） |
| POST | `/api/prizes` | 管理 | 新增奖品 |
| PUT | `/api/prizes/:id` | 管理 | 编辑奖品名称 / 总数 |
| DELETE | `/api/prizes/:id` | 管理 | 删除奖品 |
| GET | `/api/winners?limit=10` | 公开 | 最近中奖记录（`all=1` 需管理，返回全部） |
| POST | `/api/draw` | 公开·限流 | 抽奖（服务端加权随机 + 原子扣减） |
| GET | `/api/chances?userId=` | 管理 | 查询用户剩余次数 |
| POST | `/api/chances` | 管理 | 为用户增加抽奖次数 |
| GET | `/api/users` | 管理 | 已注册用户列表（含剩余次数） |
| POST | `/api/users/chances` | 管理 | 批量修改用户次数（单次原子提交，上限 300 条） |
| DELETE | `/api/users/:userId` | 管理 | 删除用户（清除次数，历史中奖记录保留） |
| POST | `/api/reset` | 管理 | 重置活动（清空中奖记录与所有用户次数） |

## 部署到 Netlify

### 方式一：连接 Git 仓库（推荐）

1. **推送代码**：把本项目推送到 GitHub / GitLab / Bitbucket。
2. **导入站点**：登录 [Netlify](https://app.netlify.com) → **Add new site → Import an existing project** → 选择仓库。
3. **构建设置**（Netlify 自动识别 `netlify.toml`，无需手动填写）：
   - Build command：留空（纯静态，无构建步骤）
   - Publish directory：`public`
4. **配置环境变量**：站点创建后进入 **Site configuration → Environment variables**，点击 **Add a variable**，逐个添加 `.env.example` 中的键（至少）：
   - `ADMIN_PASSWORD_HASH` ← `node scripts/hash-password.js "你的密码"` 的输出
   - 可选：`DRAW_MIN_INTERVAL_MS`、`RATE_LIMIT_*`、`SESSION_TTL_HOURS` 等（不填用默认值）
5. **部署**：点击 **Deploy site**，等待构建完成（约 1 分钟）。
6. **验证**：打开站点 → 状态胶囊显示「已连接 · 云端同步正常」→ 管理者标签页用密码登录 → 添加奖品 → 抽奖入口抽奖。

### 方式二：Netlify CLI

```bash
npm install -g netlify-cli
netlify login
netlify init          # 关联已有站点或新建
netlify env:set ADMIN_PASSWORD_HASH "scrypt$16384$..."
netlify deploy --prod # 首次部署用 --prod 直接上线
```

### 部署后检查清单

- [ ] 状态胶囊显示「已连接 · 云端同步正常」（非离线）
- [ ] 管理员能登录、添加奖品、加次数、重置活动
- [ ] 参与者能抽奖并看到中奖记录
- [ ] 页面响应头含 CSP（浏览器开发者工具 → Network → Response Headers）
- [ ] 抽奖接口在 30 次/分钟/IP 内正常工作

## 安全设计说明

| 要求 | 实现方式 |
| --- | --- |
| 密钥不暴露给前端 | 所有敏感逻辑在 Netlify Functions 内；密码哈希、会话令牌、存储凭据只存在于服务端环境变量与 Blobs，前端仅通过 `/api/*` 交互 |
| 密码哈希存储 | `crypto.scrypt`（N=16384, r=8, p=1，OWASP 推荐 KDF）+ 16 字节随机盐 + `timingSafeEqual` 常量时间比较；存储格式 `scrypt$N$r$p$salt$hash`；改密时旧哈希被覆盖 |
| 服务端会话认证 | 登录成功生成 32 字节随机令牌存 Blobs，Cookie 为 `HttpOnly + SameSite=Strict`（生产 HTTPS 下加 `Secure` 与 `__Host-` 前缀）；会话 12 小时过期；登出即删除服务端记录 |
| 改密后旧会话失效 | 配置文档维护 `authVersion`，会话记录携带签发时的版本号；改密后版本 +1，所有旧会话即刻失效 |
| 防暴力破解 / 刷奖 | 持久化令牌桶限流：登录 5 次/15 分钟/IP、改密 3 次/15 分钟/IP、抽奖 30 次/分钟/IP、管理接口 120 次/分钟/IP；另有同一用户 800ms 抽奖间隔门禁 |
| 抽奖结果服务端生成 | 前端只提交用户 ID；加权随机（权重 = 剩余份数）用 `crypto.randomInt` 在服务端完成；奖品、结果均不可由前端指定 |
| 原子扣减 / 并发不超发 | 库存以中奖记录计数为唯一事实来源；整笔事务（校验次数 → 校验库存 → 加权选品 → 追加记录 → 扣减次数）在**单个 Blob 文档的条件写（CAS, `onlyIfMatch` etag）**内完成，被并发覆盖自动重读重试（最多 5 次），结构上不可能超发 |
| 输入校验 | 服务端对用户 ID（1-24 位，白名单字符集）、奖品名（1-40 位，排除 HTML 元字符）、总数/次数/limit（整数范围）、密码（长度与字符）全量校验 |
| XSS | 前端所有动态内容用 `textContent` / `input.value` 渲染，零 `innerHTML` 拼接；配合严格 CSP（`default-src 'none'`，仅 `'self'` + 必要指令）与输入白名单三重防护 |
| CSRF | 会话 Cookie `SameSite=Strict` + 所有变更接口要求 `application/json`（跨站表单无法伪造）+ 同源部署无 CORS |
| 安全响应头 | `netlify.toml` 全站下发：CSP、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Permissions-Policy`、HSTS |
| 错误处理不泄露堆栈 | 所有路由统一 try/catch：已知业务错误返回结构化 `{error, message}`；未知异常仅记服务端日志，客户端只收到泛化 500 文案 |
| 凭证与会话防护 | 密码哈希、会话令牌不落前端；Cookie 不可被 JS 读取（HttpOnly）；`.env` / `.data` / `node_modules` 均被 `.gitignore` 排除 |

## 并发与一致性模型（重要）

Netlify Blobs 提供**条件写（CAS）**能力（`onlyIfMatch`/`onlyIfNew`，SDK v11+）。本项目把全部可变状态放入单个 `state` 文档，抽奖与管理操作都按「读取（含 etag）→ 克隆 → 变更 → 条件写」执行：

- 若写期间被其他并发请求覆盖，条件写返回 `modified: false`，自动重读重试；
- 中奖记录是库存的唯一事实来源（剩余 = 总数 − 记录数），记录追加与次数扣减在同一原子写内完成；
- 因此 **5 个并发请求抢 3 份库存，必然恰好 3 次成功、2 次得到「奖品已抽完」**（冒烟测试已覆盖该场景）。

启动时会自动探测环境是否支持 CAS；若不支持（旧版运行时），降级为「写后校验 + 有限重试」策略并输出警告。对单机规模的活动（每秒数笔请求）该模型绰绰有余；若未来需要更高并发与更强事务能力，可平滑替换为 PostgreSQL / Supabase（存储层已隔离在 `_shared/storage.js`）。

## 常见问题

**忘记管理员密码？**
本地：删掉 `.data/` 后重启，或直接改 `.env` 的 `ADMIN_PASSWORD`。
线上：生成新哈希 → 在 Netlify 环境变量中把 `ADMIN_PASSWORD_HASH` 更新为新值、`ADMIN_PASSWORD_OVERRIDE` 设为 `1` → 重新部署（或触发一次函数部署）。下次请求会自动应用新哈希并使所有会话失效，用后把 `ADMIN_PASSWORD_OVERRIDE` 改回 `0`。

**收到 429 提示？**
命中速率限制（登录 5 次/15 分钟、抽奖 30 次/分钟等）。等待窗口重置，或调大对应 `RATE_LIMIT_*` 环境变量后重新部署。

**登录提示「服务器开小差了」或「数据存储服务…」？**
这是函数内部抛出了未预期异常（不是密码错误——密码错误会显示「管理员密码错误」）。请按顺序排查：
1. 打开 Netlify 站点 → **Logs → Functions**，点开失败的 `login` 请求，把报错堆栈发出来（或对照本文档排查）；
2. 确认环境变量（`ADMIN_PASSWORD` 或 `ADMIN_PASSWORD_HASH`）已设置，并且设置后**重新部署过**（Deploys → Redeploy）——不重新部署不生效；
3. 若是「数据存储服务初始化失败」：多为函数运行时无法访问 Netlify Blobs，检查函数日志中的 `[storage]` 报错；
4. 重新部署后仍失败，请把函数日志贴到 Issue 或反馈中。

**本地存储位置？**
`netlify dev` 支持 Blobs 时数据在本地 Blobs 模拟中；否则在项目根目录 `.data/`（JSON 文件）。删除 `.data/` 即重置本地数据。

**「离线 / 本地模式」？**
前端每 20 秒探测 `/api/health`。显示离线表示无法连接函数（部署异常 / 断网 / 函数报错），此时抽奖按钮被禁用，数据不会丢失。

**想清空活动重新开始？**
管理面板「中奖记录 → 重置活动」：清空中奖记录、所有用户次数归零、奖品已抽数量归零（奖品配置保留）。

**换存储方案？**
只需替换 `netlify/functions/_shared/storage.js` 中的 `getWithEtag / setConditional / setPlain / del` 四个原语，其余代码不变（`updateState` 依赖 CAS 语义，Postgres 可用 `SELECT ... FOR UPDATE` 或版本列实现等价原子性）。
