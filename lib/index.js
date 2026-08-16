/**
 * dsh-github-flow — host 半区（v0.2）
 *
 * 能力：
 *  - 5 个对话工具：github_connect / github_status / github_repo_create / github_push / github_release
 *  - 设置页连接（webServer 路由，供 client 设置页调用）：
 *      GET  /dsh-github-flow/status                连接状态 + 仓库列表
 *      POST /dsh-github-flow/config                保存 OAuth Client ID
 *      POST /dsh-github-flow/auth/start            发起 OAuth 设备码流
 *      POST /dsh-github-flow/auth/poll             轮询设备码授权结果
 *      POST /dsh-github-flow/auth/pat              保存 Fine-grained PAT（备选）
 *      POST /dsh-github-flow/auth/disconnect       断开（清除本地凭据）
 *      POST /dsh-github-flow/quick/push            快捷推送当前工作区
 *      POST /dsh-github-flow/quick/release         快捷发版
 *
 * 凭据存储：~/.dsh/dsh-github-flow/config.json
 *   { clientId, auth: { mode:'oauth'|'pat', token, refreshToken?, expiresAt?, login, avatar?, scope?, connectedAt } }
 * 零运行时依赖：Node 内置 fetch。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, isAbsolute, sep } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-github-flow'

/** 挂载前置依赖：等工具注册表和 webServer 就绪后再 apply（否则工具/路由静默缺失） */
export const inject = ['tools', 'webServer']

const API = 'https://api.github.com'
const LOGIN = 'https://github.com'
const UA = 'dsh-github-flow'
const SCOPE = 'repo user'
const DEFAULT_IGNORE = new Set(['.git', 'node_modules', 'dist', 'build', '.DS_Store', '__pycache__', '.venv', '.idea', '.vscode'])
const MAX_FILES_PER_PUSH = 500
const flows = new Map() // flowId -> { deviceCode, clientId, expiresAt, interval }

// ---------------------------------------------------------------- 挂载诊断日志（临时）
function mountLog(msg) {
  try {
    const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-github-flow')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'mount.log'), `${new Date().toISOString()} ${msg}\n`, { flag: 'a' })
  } catch (e) { /* ignore */ }
}
mountLog('=== module loaded, cwd=' + process.cwd() + ', DSH_HOME=' + (process.env.DSH_HOME || ''))

// ---------------------------------------------------------------- 存储
function dshHome() { return process.env.DSH_HOME || join(homedir(), '.dsh') }
function configPath() { return join(dshHome(), 'dsh-github-flow', 'config.json') }
function legacyTokenPath() { return join(dshHome(), 'dsh-github-flow', 'token.json') }

function loadConfig() {
  try {
    const raw = readFileSync(configPath(), 'utf8').replace(/^\uFEFF/, '') // 容错 BOM
    const c = JSON.parse(raw)
    if (c && typeof c === 'object') return c
  } catch (e) { /* ignore */ }
  // 迁移旧 token.json
  try {
    if (existsSync(legacyTokenPath())) {
      const old = JSON.parse(readFileSync(legacyTokenPath(), 'utf8').replace(/^\uFEFF/, ''))
      if (old && old.token) {
        const c = { auth: { mode: 'pat', token: old.token, connectedAt: old.savedAt } }
        saveConfig(c)
        try { writeFileSync(legacyTokenPath(), '{}') } catch (e) { /* ignore */ }
        return c
      }
    }
  } catch (e) { /* ignore */ }
  return {}
}
function saveConfig(cfg) {
  const dir = join(dshHome(), 'dsh-github-flow')
  mkdirSync(dir, { recursive: true })
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 })
}

// ---------------------------------------------------------------- token
// DSH 将插件配置以 apply(ctx, config) 第二参数传入（不可用 ctx.config，会被守卫拦截）
let cfgHolder = {}

async function getToken(ctx) {
  const cfg = cfgHolder || {}
  if (typeof cfg.token === 'string' && cfg.token) return cfg.token.trim()
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim()
  const c = loadConfig()
  if (c.auth && c.auth.token) {
    await maybeRefresh(c)
    return c.auth.token.trim()
  }
  throw new Error('未配置 GitHub 凭据。请在 设置 → GitHub 里用 OAuth 登录或粘贴 PAT，或用 github_connect 工具，或设置环境变量 GITHUB_TOKEN。')
}
async function maybeRefresh(c) {
  const a = c.auth
  if (!a || a.mode !== 'oauth' || !a.refreshToken || !a.expiresAt) return
  if (Date.now() < a.expiresAt - 60_000) return
  try {
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: a.refreshToken, client_id: c.clientId || '' })
    const res = await fetch(`${LOGIN}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    const data = await res.json().catch(() => null)
    if (res.ok && data && data.access_token) {
      a.token = data.access_token
      if (data.refresh_token) a.refreshToken = data.refresh_token
      if (data.expires_in) a.expiresAt = Date.now() + data.expires_in * 1000
      if (data.scope) a.scope = data.scope
      saveConfig(c)
    }
  } catch (e) { /* 刷新失败则沿用旧 token，调用方会收到 401 */ }
}

// ---------------------------------------------------------------- GitHub API
async function gh(ctx, method, path, body) {
  const token = await getToken(ctx)
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': UA,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch (e) { data = null }
  if (!res.ok) {
    const msg = data && data.message ? data.message : res.statusText
    throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${msg}`)
  }
  return data
}
function ghPath(seg) { return seg.split('/').map(encodeURIComponent).join('/') }

// ---------------------------------------------------------------- 本地文件
function walkDir(dir, ignoreSet, out, base) {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (ignoreSet.has(entry.name)) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) walkDir(abs, ignoreSet, out, base)
    else {
      const rel = abs.slice(base.length + 1).split(sep).join('/')
      out.push({ rel, abs })
    }
  }
  return out
}
function resolveLocalDir(p) {
  const target = p ? (isAbsolute(p) ? resolve(p) : resolve(process.cwd(), p)) : process.cwd()
  if (!existsSync(target)) throw new Error(`本地路径不存在：${target}`)
  return target
}
function gitBlobSha(buffer) { return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex') }

// ---------------------------------------------------------------- 推送 / 发版核心
async function doPush(ctx, fullName, dir, branchArg, message, deleteMissing, ignoreSet) {
  const info = await gh(ctx, 'GET', `/repos/${ghPath(fullName)}`)
  const branch = branchArg ? String(branchArg) : info.default_branch
  const ref = await gh(ctx, 'GET', `/repos/${ghPath(fullName)}/git/ref/heads/${ghPath(branch)}`)
  const headSha = ref.object.sha
  const tree = await gh(ctx, 'GET', `/repos/${ghPath(fullName)}/git/trees/${headSha}?recursive=1`)
  const remoteMap = new Map()
  if (tree && Array.isArray(tree.tree)) {
    for (const item of tree.tree) if (item.type === 'blob') remoteMap.set(item.path, item.sha)
  }
  const localFiles = walkDir(dir, ignoreSet, [], dir)
  if (localFiles.length > MAX_FILES_PER_PUSH) throw new Error(`文件数 ${localFiles.length} 超过单次上限 ${MAX_FILES_PER_PUSH}。`)
  const toPut = []
  const toDelete = []
  for (const f of localFiles) {
    const buf = readFileSync(f.abs)
    const sha = gitBlobSha(buf)
    if (remoteMap.get(f.rel) !== sha) toPut.push({ rel: f.rel, base64: buf.toString('base64') })
  }
  if (deleteMissing) {
    for (const [rel, sha] of remoteMap.entries()) {
      if (!localFiles.some((f) => f.rel === rel)) toDelete.push({ rel, sha })
    }
  }
  const results = []
  const runner = async (jobs, fn) => {
    let idx = 0
    const workers = Array.from({ length: 4 }, async () => {
      while (idx < jobs.length) {
        const job = jobs[idx++]
        results.push(await fn(job))
      }
    })
    await Promise.all(workers)
  }
  await runner(toPut, async (job) => {
    await gh(ctx, 'PUT', `/repos/${ghPath(fullName)}/contents/${ghPath(job.rel)}`, {
      message, content: job.base64, sha: remoteMap.get(job.rel) || undefined, branch,
    })
    return job.rel
  })
  await runner(toDelete, async (job) => {
    await gh(ctx, 'DELETE', `/repos/${ghPath(fullName)}/contents/${ghPath(job.rel)}`, { message, sha: job.sha, branch })
    return job.rel
  })
  return {
    ok: true, fullName, branch, headSha,
    pushed: toPut.length, pushedFiles: results.slice(0, toPut.length),
    deleted: toDelete.length, deletedFiles: results.slice(toPut.length),
    unchanged: localFiles.length - toPut.length, totalLocalFiles: localFiles.length, message,
  }
}
async function doRelease(ctx, fullName, version, name, notes, branchArg) {
  const info = await gh(ctx, 'GET', `/repos/${ghPath(fullName)}`)
  const branch = branchArg ? String(branchArg) : info.default_branch
  const ref = await gh(ctx, 'GET', `/repos/${ghPath(fullName)}/git/ref/heads/${ghPath(branch)}`)
  const headSha = ref.object.sha
  let tagCreated = false
  try {
    await gh(ctx, 'POST', `/repos/${ghPath(fullName)}/git/refs`, { ref: `refs/tags/${version}`, sha: headSha })
    tagCreated = true
  } catch (e) {
    if (!String(e.message).includes('422') && !String(e.message).includes('Reference already exists')) throw e
  }
  const release = await gh(ctx, 'POST', `/repos/${ghPath(fullName)}/releases`, {
    tag_name: version, name: name || version, body: notes || '', target_commitish: headSha,
  })
  return { ok: true, version, tagCreated, branch, headSha, htmlUrl: release.html_url }
}
function resolveRepoFullName(repo, login) {
  if (repo.includes('/')) return repo
  return `${login}/${repo}`
}

// ---------------------------------------------------------------- 工具
const text = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
const loose = { type: 'object', additionalProperties: true }

function registerTools(ctx) {
  const tools = ctx.get('tools')
  if (!tools) return
  const disposers = []
  const reg = (tool) => disposers.push(tools.register(tool))

  reg(defineTool({
    name: 'github_connect',
    description: '连接 GitHub：校验并保存 Fine-grained PAT 到本地。之后所有 github_* 工具自动使用。也可在 设置 → GitHub 里用 OAuth 登录（推荐）。',
    parameters: {
      token: { type: 'string', required: true, description: 'GitHub Personal Access Token（ghp_ 或 github_pat_ 开头）。' },
    },
    output: { schema: loose, render: text },
    async execute(args) {
      const token = String(args.token).trim()
      const res = await fetch(API + '/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': UA, 'X-GitHub-Api-Version': '2022-11-28' },
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(`GitHub token 校验失败 → ${res.status}: ${data && data.message ? data.message : res.statusText}`)
      const cfg = loadConfig()
      cfg.auth = { mode: 'pat', token, login: data.login, avatar: data.avatar_url, connectedAt: new Date().toISOString() }
      saveConfig(cfg)
      return { ok: true, login: data.login, savedTo: configPath() }
    },
  }))

  reg(defineTool({
    name: 'github_status',
    description: '查看 GitHub 连接状态与最近仓库列表。',
    parameters: {
      limit: { type: 'integer', description: '最多列出的仓库数，默认 10。' },
    },
    output: { schema: loose, render: text },
    async execute(args) {
      const me = await gh(ctx, 'GET', '/user')
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 100)
      const repos = await gh(ctx, 'GET', `/user/repos?sort=updated&per_page=${limit}&affiliation=owner`)
      const cfg = loadConfig()
      return {
        ok: true, login: me.login, authMode: (cfg.auth && cfg.auth.mode) || 'none',
        repoCount: Array.isArray(repos) ? repos.length : 0,
        repos: (Array.isArray(repos) ? repos : []).map((r) => ({
          fullName: r.full_name, private: r.private, defaultBranch: r.default_branch, updatedAt: r.updated_at, htmlUrl: r.html_url,
        })),
      }
    },
  }))

  reg(defineTool({
    name: 'github_repo_create',
    description: '在 GitHub 上新建仓库，可选把本地目录内容作为初始提交推上去（自动忽略 .git/node_modules/dist/build 等）。',
    parameters: {
      name: { type: 'string', required: true, description: '仓库名（小写字母/数字/连字符）。' },
      description: { type: 'string', description: '仓库描述。' },
      private: { type: 'boolean', description: '是否私有，默认 false（公开）。' },
      path: { type: 'string', description: '要上传的本地目录（相对当前工作区或绝对路径）；省略则只建空仓库。' },
      branch: { type: 'string', description: '默认分支名，默认 main。' },
      message: { type: 'string', description: '初始提交信息，默认 "init: <repo>"。' },
    },
    output: { schema: loose, render: text },
    async execute(args) {
      const repoName = String(args.name).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-')
      if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(repoName)) throw new Error(`仓库名不合法：${repoName}`)
      const repo = await gh(ctx, 'POST', '/user/repos', {
        name: repoName,
        description: args.description ? String(args.description) : undefined,
        private: !!args.private,
        auto_init: true,
      })
      const fullName = repo.full_name
      const branch = args.branch ? String(args.branch) : repo.default_branch || 'main'
      let push = null
      if (args.path) {
        push = await doPush(ctx, fullName, resolveLocalDir(args.path), branch, args.message || `init: ${repoName}`, true, ignoreSet(ctx))
      }
      return { ok: true, fullName, htmlUrl: repo.html_url, defaultBranch: branch, push }
    },
  }))

  reg(defineTool({
    name: 'github_push',
    description: '把本地目录增量同步到 GitHub 仓库：按 git blob 哈希对比远端，只上传变化文件、删除本地已不存在的文件（可选）。',
    parameters: {
      repo: { type: 'string', required: true, description: '仓库，格式 "owner/name" 或纯 "name"（用当前账号）。' },
      path: { type: 'string', description: '本地目录（相对当前工作区或绝对路径）；省略 = 当前工作区根目录。' },
      message: { type: 'string', description: '提交信息，默认 "sync: <时间>"。' },
      deleteMissing: { type: 'boolean', description: '是否删除远端有而本地没有的文件，默认 true。' },
      ignore: { type: 'array', description: '额外忽略的文件/目录名（如 ["secret.txt"]）。' },
      branch: { type: 'string', description: '目标分支，默认仓库默认分支。' },
    },
    output: { schema: loose, render: text },
    async execute(args) {
      const repo = String(args.repo).trim()
      if (!/^[^/]+\/[^/]+$/.test(repo) && !/^[A-Za-z0-9._-]+$/.test(repo)) throw new Error(`仓库名不合法：${repo}`)
      const me = await gh(ctx, 'GET', '/user')
      const fullName = resolveRepoFullName(repo, me.login)
      const dir = resolveLocalDir(args.path)
      const extra = new Set(Array.isArray(args.ignore) ? args.ignore.map(String) : [])
      return doPush(ctx, fullName, dir, args.branch, args.message || `sync: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`, args.deleteMissing !== false, new Set([...DEFAULT_IGNORE, ...extra]))
    },
  }))

  reg(defineTool({
    name: 'github_release',
    description: '为仓库打版本：创建 git tag 并发布 GitHub Release。配合 github_push 使用。',
    parameters: {
      repo: { type: 'string', required: true, description: '仓库 "owner/name" 或 "name"。' },
      version: { type: 'string', required: true, description: '版本号，建议 vX.Y.Z（如 v0.2.0）。' },
      name: { type: 'string', description: 'Release 标题，默认 = 版本号。' },
      notes: { type: 'string', description: '发布说明（支持 Markdown）。' },
      branch: { type: 'string', description: '打 tag 的目标分支，默认默认分支。' },
    },
    output: { schema: loose, render: text },
    async execute(args) {
      const repo = String(args.repo).trim()
      if (!/^[^/]+\/[^/]+$/.test(repo) && !/^[A-Za-z0-9._-]+$/.test(repo)) throw new Error(`仓库名不合法：${repo}`)
      const version = String(args.version).trim().replace(/^v/i, 'v')
      if (!/^v\d+\.\d+\.\d+/.test(version)) throw new Error(`版本号建议使用 vX.Y.Z 格式（如 v0.2.0），收到：${version}`)
      const me = await gh(ctx, 'GET', '/user')
      const fullName = resolveRepoFullName(repo, me.login)
      return doRelease(ctx, fullName, version, args.name, args.notes, args.branch)
    },
  }))

  ctx.on('dispose', () => { for (const d of disposers) { try { d() } catch (e) { /* ignore */ } } })
}

// ---------------------------------------------------------------- webServer 路由（设置页连接）
function ignoreSet(ctx) {
  return new Set([...DEFAULT_IGNORE, ...((cfgHolder && cfgHolder.ignore) || [])])
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ''
    req.on('data', (c) => { d += c; if (d.length > 1e6) { req.destroy(); reject(new Error('body too large')) } })
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}
function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const u = new URL(origin)
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1'
  } catch (e) { return false }
}
function routeGuard(req, res) {
  if (!sameOrigin(req)) { json(res, 403, { error: 'forbidden' }); return false }
  return true
}

async function authStatus(ctx) {
  const cfg = loadConfig()
  const out = { connected: false, authMode: 'none', clientIdConfigured: !!cfg.clientId, login: null, avatar: null, scope: null, connectedAt: null, repos: [] }
  if (cfg.auth && cfg.auth.token) {
    try {
      const me = await gh(ctx, 'GET', '/user')
      out.connected = true
      out.authMode = cfg.auth.mode || 'oauth'
      out.login = me.login
      out.avatar = me.avatar_url
      out.scope = cfg.auth.scope || null
      out.connectedAt = cfg.auth.connectedAt || null
      const repos = await gh(ctx, 'GET', '/user/repos?sort=updated&per_page=10&affiliation=owner')
      out.repos = (Array.isArray(repos) ? repos : []).map((r) => ({ fullName: r.full_name, private: r.private, defaultBranch: r.default_branch, htmlUrl: r.html_url }))
    } catch (e) {
      out.connected = false
      out.authError = String(e.message)
    }
  }
  return out
}

function registerRoutes(ctx) {
  const webServer = ctx.get('webServer')
  if (!webServer) return
  const disposers = []
  const route = (path, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path, handler }))
  }

  route('/dsh-github-flow/status', async (req, res) => {
    if (!routeGuard(req, res)) return
    json(res, 200, await authStatus(ctx))
  })

  route('/dsh-github-flow/config', async (req, res) => {
    if (!routeGuard(req, res)) return
    const body = await readBody(req).catch(() => null)
    if (!body || typeof body.clientId !== 'string' || !body.clientId.trim()) { json(res, 400, { error: 'clientId 必填' }); return }
    const cfg = loadConfig()
    cfg.clientId = body.clientId.trim()
    saveConfig(cfg)
    json(res, 200, { ok: true, clientIdConfigured: true })
  })

  route('/dsh-github-flow/auth/start', async (req, res) => {
    if (!routeGuard(req, res)) return
    const cfg = loadConfig()
    if (!cfg.clientId) { json(res, 400, { error: '请先在设置页填写 GitHub OAuth App 的 Client ID' }); return }
    try {
      const form = new URLSearchParams({ client_id: cfg.clientId, scope: SCOPE })
      const r = await fetch(`${LOGIN}/login/device/code`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      })
      const data = await r.json().catch(() => null)
      if (!r.ok || !data || !data.device_code) {
        json(res, 502, { error: `GitHub 设备码请求失败：${r.status} ${data && data.error_description ? data.error_description : (data && data.message) || r.statusText}` })
        return
      }
      const flowId = createHash('sha1').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16)
      flows.set(flowId, {
        deviceCode: data.device_code, clientId: cfg.clientId,
        expiresAt: Date.now() + (data.expires_in || 900) * 1000,
        interval: Math.max(data.interval || 5, 5),
      })
      json(res, 200, { flowId, userCode: data.user_code, verificationUri: data.verification_uri || `${LOGIN}/login/device`, expiresIn: data.expires_in || 900, interval: Math.max(data.interval || 5, 5) })
    } catch (e) {
      json(res, 502, { error: String(e.message) })
    }
  })

  route('/dsh-github-flow/auth/poll', async (req, res) => {
    if (!routeGuard(req, res)) return
    const body = await readBody(req).catch(() => null)
    const flow = body && flows.get(body.flowId)
    if (!flow) { json(res, 404, { status: 'expired', error: '登录流程已失效，请重新发起' }); return }
    if (Date.now() > flow.expiresAt) { flows.delete(body.flowId); json(res, 200, { status: 'expired', error: '设备码已过期，请重新发起' }); return }
    try {
      const form = new URLSearchParams({
        client_id: flow.clientId, device_code: flow.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      })
      const r = await fetch(`${LOGIN}/login/oauth/access_token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      })
      const data = await r.json().catch(() => null)
      if (data && data.access_token) {
        flows.delete(body.flowId)
        // 取用户信息
        let login = null, avatar = null
        try {
          const me = await fetch(API + '/user', { headers: { Authorization: `Bearer ${data.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': UA, 'X-GitHub-Api-Version': '2022-11-28' } })
          const meData = await me.json().catch(() => null)
          if (me.ok && meData) { login = meData.login; avatar = meData.avatar_url }
        } catch (e) { /* ignore */ }
        const cfg = loadConfig()
        cfg.auth = {
          mode: 'oauth', token: data.access_token,
          refreshToken: data.refresh_token || undefined,
          expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
          scope: data.scope || SCOPE, login, avatar, connectedAt: new Date().toISOString(),
        }
        saveConfig(cfg)
        json(res, 200, { status: 'success', login, scope: data.scope })
        return
      }
      if (data && (data.error === 'authorization_pending' || data.error === 'slow_down')) {
        json(res, 200, { status: 'pending' })
        return
      }
      if (data && (data.error === 'expired_token' || data.error === 'access_denied')) {
        flows.delete(body.flowId)
        json(res, 200, { status: 'error', error: data.error_description || data.error })
        return
      }
      json(res, 200, { status: 'pending', detail: data })
    } catch (e) {
      json(res, 502, { status: 'error', error: String(e.message) })
    }
  })

  route('/dsh-github-flow/auth/pat', async (req, res) => {
    if (!routeGuard(req, res)) return
    const body = await readBody(req).catch(() => null)
    if (!body || typeof body.token !== 'string' || !body.token.trim()) { json(res, 400, { error: 'token 必填' }); return }
    const token = body.token.trim()
    const r = await fetch(API + '/user', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': UA, 'X-GitHub-Api-Version': '2022-11-28' } })
    const me = await r.json().catch(() => null)
    if (!r.ok) { json(res, 400, { error: `token 校验失败：${r.status} ${me && me.message ? me.message : r.statusText}` }); return }
    const cfg = loadConfig()
    cfg.auth = { mode: 'pat', token, login: me.login, avatar: me.avatar_url, connectedAt: new Date().toISOString() }
    saveConfig(cfg)
    json(res, 200, { ok: true, login: me.login })
  })

  route('/dsh-github-flow/auth/disconnect', async (req, res) => {
    if (!routeGuard(req, res)) return
    const cfg = loadConfig()
    cfg.auth = undefined
    saveConfig(cfg)
    json(res, 200, { ok: true, note: '本地凭据已清除。GitHub 侧授权如需撤销，请到 GitHub → Settings → Applications 处理（OAuth 公开客户端无法通过 API 撤销）。' })
  })

  route('/dsh-github-flow/quick/push', async (req, res) => {
    if (!routeGuard(req, res)) return
    try {
      const body = await readBody(req).catch(() => null) || {}
      const me = await gh(ctx, 'GET', '/user')
      const repo = body.repo || process.cwd().split(sep).pop() || 'workspace'
      const fullName = resolveRepoFullName(String(repo), me.login)
      const dir = resolveLocalDir(body.path)
      const result = await doPush(ctx, fullName, dir, body.branch, body.message || `sync: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`, body.deleteMissing !== false, ignoreSet(ctx))
      json(res, 200, result)
    } catch (e) { json(res, 400, { error: String(e.message) }) }
  })

  route('/dsh-github-flow/quick/release', async (req, res) => {
    if (!routeGuard(req, res)) return
    try {
      const body = await readBody(req).catch(() => null) || {}
      if (!body.repo || !body.version) { json(res, 400, { error: 'repo 与 version 必填' }); return }
      const me = await gh(ctx, 'GET', '/user')
      const fullName = resolveRepoFullName(String(body.repo), me.login)
      const result = await doRelease(ctx, fullName, String(body.version).replace(/^v/i, 'v'), body.name, body.notes, body.branch)
      json(res, 200, result)
    } catch (e) { json(res, 400, { error: String(e.message) }) }
  })

  ctx.on('dispose', () => { for (const d of disposers) { try { d() } catch (e) { /* ignore */ } } })
}

export const apply = (ctx, config) => {
  cfgHolder = config || {}
  mountLog('apply called, configKeys=' + Object.keys(cfgHolder).join(','))
  try {
    const tools = ctx.get('tools')
    const webServer = ctx.get('webServer')
    mountLog('tools=' + !!tools + ' webServer=' + !!webServer)
    registerTools(ctx)
    mountLog('registerTools OK')
    registerRoutes(ctx)
    mountLog('registerRoutes OK')
  } catch (e) {
    mountLog('APPLY ERROR: ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : String(e)))
  }
}
