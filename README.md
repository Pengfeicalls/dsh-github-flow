# dsh-github-flow — GitHub 仓库托管插件（v0.2）

设置页一键连接 GitHub（OAuth 设备码登录，同 Codex 体验）+ 对话工具（建仓 / 推送 / 发版）。

## 功能

### 设置页（Settings → GitHub）
| 区块 | 内容 |
|---|---|
| 连接卡片 | 头像 / 登录名 / 连接方式 / 断开连接 |
| OAuth 登录 | 「用 GitHub 登录」→ 弹出设备码窗口（`github.com/login/device` + 6 位码）→ 浏览器授权 → 自动轮询完成 |
| PAT 备选 | 粘贴 Fine-grained PAT 直接连接 |
| Client ID | 自建 GitHub OAuth App 的 Client ID（存 `~/.dsh/dsh-github-flow/config.json`） |
| 快捷操作 | 推送当前工作区 / 发版（仓库 + vX.Y.Z + 发布说明） |
| 最近仓库 | 最近 10 个仓库列表 |

### 对话工具
`github_connect` · `github_status` · `github_repo_create` · `github_push` · `github_release`（见下表）

| 工具 | 作用 |
|---|---|
| `github_connect` | 校验并保存 PAT |
| `github_status` | 连接状态 + 仓库列表 |
| `github_repo_create` | 建仓（可推入本地目录） |
| `github_push` | 增量同步本地目录 → 仓库（git blob 哈希对比） |
| `github_release` | 打 tag + GitHub Release |

## 安装

```powershell
dsh plugin --profile web add link:C:\Users\Pengfei\.dsh\profiles\web\plugins-src\dsh-github-flow
# 重启壳 exe 并刷新页面
```

> 源码放 profile 目录内（`~/.dsh/profiles/web/plugins-src/`）以便 host 侧解析 `@deepseek-ai/*` 依赖；`D:\Deepseek Harness\engineer\dsh-github-flow` 是交付镜像。改 `lib/index.js` / `lib/client.js` 后重启壳即生效。

## 第一步：创建 GitHub OAuth App（1 分钟，免费）

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**
2. Application name 随意（如 `dsh-github-flow`）
3. **Homepage URL** 填 `http://localhost`
4. **Authorization callback URL** 填 `http://localhost`
5. 创建后复制 **Client ID**（`Iv1.xxxxxxxxxxxx`）→ 粘贴到 设置 → GitHub → OAuth Client ID → 保存

> 设备码流是 public client 流程，**不需要 Client Secret**。授权范围固定 `repo user`。

## 使用流程

```
设置页：填 Client ID → 点「用 GitHub 登录」→ 浏览器输入设备码 → 已连接
对话：  "把这个项目建个公开仓库叫 my-tool 推上去"
        "把改完的代码更新到 my-tool，然后发 v0.2.0，写更新说明"
设置页：快捷操作 → 推送当前工作区 / 发版（不聊天也能用）
```

## 凭据与安全

- 存于 `~/.dsh/dsh-github-flow/config.json`（0600 权限）：`{ clientId, auth: { mode, token, refreshToken?, expiresAt?, login, avatar, scope, connectedAt } }`
- OAuth token 过期自动刷新（refresh_token）；GitHub 侧授权撤销需到 GitHub → Settings → Applications 手动处理（公开客户端无法 API 撤销）。
- 断开连接 = 清除本地凭据。

## 已知边界

- 推送为"目录镜像"语义（仅保留变化文件的提交），适合个人项目托管。
- 单次推送上限 500 文件；默认忽略 `.git/node_modules/dist/build` 等。
- PAT 模式下 `github_connect` 工具与设置页等效。
