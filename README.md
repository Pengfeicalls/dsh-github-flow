# dsh-github-flow

**在 DeepSeek Harness 里直接托管你的 GitHub 项目**：设置页一键连接 GitHub，对话中建仓库、推代码、打版本发 Release，全程不用离开 Harness。

## 功能

| 能力 | 说明 |
|---|---|
| 🔗 设置页连接 | Settings → GitHub：OAuth 设备码一键登录（同 Codex 体验）+ Fine-grained PAT 备选 |
| 📦 建仓库 | 对话一句话创建仓库，可同时把本地目录作为初始内容推上去 |
| ⬆️ 增量推送 | git blob 哈希对比，只上传变化文件、删除远端已消失文件（目录=镜像） |
| 🏷️ 版本管理 | 打 git tag + 创建 GitHub Release（vX.Y.Z） |
| ⚡ 快捷操作 | 设置页一键「推送当前工作区」「发版」，不聊天也能用 |

## 安装

```powershell
# 需要：dsh CLI（npm install -g @deepseek-ai/dsh）+ git 在 PATH
dsh plugin --profile web add github:Pengfeicalls/dsh-github-flow#v0.2.1
# 重启 Harness 生效
```

## 使用

**第一步：连接 GitHub**（每台机器独立，凭据只存本地）

1. 打开 设置 → GitHub
2. 填 OAuth Client ID（1 分钟自建：GitHub → Settings → Developer settings → OAuth Apps → New OAuth App，Homepage/Callback 都填 `http://localhost`，勾选 Enable device flow）
3. 点「用 GitHub 登录」→ 浏览器输设备码 → 完成
4. 或者：直接粘贴 Fine-grained PAT（备选）

**第二步：对话指挥**

```
"把这个项目建个公开仓库叫 my-tool，推上去"
  → 建仓 + 推送全部文件

"改完了，更新到 my-tool，然后发 v0.2.0"
  → 增量推送变化文件 → 打 tag + 发 Release
```

## 对话工具

`github_connect` · `github_status` · `github_repo_create` · `github_push` · `github_release`

## 配置

- 凭据存 `~/.dsh/dsh-github-flow/config.json`（OAuth 自动续期）
- 默认忽略 `.git / node_modules / dist / build` 等；单次推送上限 500 文件

## 技术

纯 host 工具 + 设置页 client，零运行时依赖（Node 内置 fetch 直连 GitHub REST API）；支持 OAuth 设备码流与 PAT 两种认证。

MIT License
