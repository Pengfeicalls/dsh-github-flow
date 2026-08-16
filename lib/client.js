/**
 * dsh-github-flow — client 设置页（v0.2）
 *
 * settings.section「GitHub」：
 *  - 连接状态卡片（头像 / 登录名 / 连接方式 / 断开）
 *  - OAuth 设备码登录（对齐 Codex：显示设备码 → 浏览器授权 → 自动轮询）
 *  - Fine-grained PAT 备选
 *  - Client ID 配置（自建 GitHub OAuth App）
 *  - 快捷操作：推送当前工作区 / 发版
 *  - 最近仓库列表
 *
 * 纯 JS + React.createElement，免构建；与 host 通过同源 /dsh-github-flow/* 路由通信。
 */
window.__ModuleLoader__.load({
  id: 'dsh-github-flow',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useCallback, useRef } = React
    const h = React.createElement

    // ------------------------------------------------------------ fetch
    async function api(path, body) {
      const res = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let data = null
      try { data = await res.json() } catch (e) { /* ignore */ }
      if (!res.ok) throw new Error((data && data.error) || `请求失败 ${res.status}`)
      return data
    }

    // ------------------------------------------------------------ 组件
    function DeviceFlowModal({ flow, onClose, onDone }) {
      const [phase, setPhase] = useState('pending')
      const [error, setError] = useState(null)

      useEffect(() => {
        let alive = true
        let timer = null
        const poll = async () => {
          try {
            const r = await api('/dsh-github-flow/auth/poll', { flowId: flow.flowId })
            if (!alive) return
            if (r.status === 'success') { setPhase('success'); onDone && onDone(); return }
            if (r.status === 'error' || r.status === 'expired') { setPhase('error'); setError(r.error || r.status); return }
            timer = setTimeout(poll, flow.interval * 1000)
          } catch (e) {
            if (!alive) return
            setPhase('error'); setError(String(e.message))
          }
        }
        timer = setTimeout(poll, flow.interval * 1000)
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [flow.flowId, flow.interval, onDone])

      useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      return h('div', { className: 'ghf-overlay', onClick: onClose },
        h('div', { className: 'ghf-modal', onClick: (e) => e.stopPropagation() },
          h('div', { className: 'ghf-modal-head' },
            h('div', { className: 'ghf-modal-title' }, '用 GitHub 登录'),
            h('span', { className: 'ghf-spacer' }),
            h('button', { className: 'ghf-btn', onClick: onClose }, '✕'),
          ),
          h('div', { className: 'ghf-modal-body' },
            phase === 'success'
              ? h('div', { className: 'ghf-success' }, '✓ 已连接 GitHub！')
              : phase === 'error'
                ? h('div', { className: 'ghf-error' }, '登录失败：' + (error || '未知错误'))
                : h('div', null,
                    h('div', { className: 'ghf-step' }, '1. 打开下面的链接（或在浏览器输入）：'),
                    h('div', { className: 'ghf-uri' }, flow.verificationUri || 'https://github.com/login/device'),
                    h('div', { className: 'ghf-step' }, '2. 输入设备码：'),
                    h('div', { className: 'ghf-code' }, flow.userCode),
                    h('div', { className: 'ghf-hint' }, `自动检测授权（每 ${flow.interval}s），请勿关闭此窗口…（有效期 ${Math.round((flow.expiresIn || 900) / 60)} 分钟）`),
                  ),
          ),
        ),
      )
    }

    function GitHubSection() {
      const [status, setStatus] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [clientId, setClientId] = useState('')
      const [clientSaved, setClientSaved] = useState(false)
      const [flow, setFlow] = useState(null)
      const [flowStarting, setFlowStarting] = useState(false)
      const [pat, setPat] = useState('')
      const [patBusy, setPatBusy] = useState(false)
      const [pushRepo, setPushRepo] = useState('')
      const [pushPath, setPushPath] = useState('')
      const [pushBusy, setPushBusy] = useState(false)
      const [pushResult, setPushResult] = useState(null)
      const [relRepo, setRelRepo] = useState('')
      const [relVersion, setRelVersion] = useState('')
      const [relNotes, setRelNotes] = useState('')
      const [relBusy, setRelBusy] = useState(false)
      const [relResult, setRelResult] = useState(null)
      const busyRef = useRef(false)

      const refresh = useCallback(async () => {
        try {
          const s = await api('/dsh-github-flow/status')
          setStatus(s)
          if (s.clientIdConfigured && !clientId) setClientId('已配置')
          setError(null)
        } catch (e) {
          setError(String(e.message))
        } finally {
          setLoading(false)
        }
      }, [clientId])

      useEffect(() => { refresh(); const t = setInterval(refresh, 10000); return () => clearInterval(t) }, [refresh])

      const startFlow = async () => {
        setFlowStarting(true)
        try {
          const r = await api('/dsh-github-flow/auth/start')
          setFlow(r)
        } catch (e) { setError(String(e.message)) } finally { setFlowStarting(false) }
      }
      const saveClientId = async () => {
        try {
          await api('/dsh-github-flow/config', { clientId: clientId.trim() })
          setClientSaved(true); setTimeout(() => setClientSaved(false), 1200)
          refresh()
        } catch (e) { setError(String(e.message)) }
      }
      const savePat = async () => {
        setPatBusy(true)
        try {
          await api('/dsh-github-flow/auth/pat', { token: pat.trim() })
          setPat(''); refresh()
        } catch (e) { setError(String(e.message)) } finally { setPatBusy(false) }
      }
      const disconnect = async () => {
        if (!window.confirm('断开 GitHub 连接？（本地凭据将被清除）')) return
        try { await api('/dsh-github-flow/auth/disconnect', {}); refresh() } catch (e) { setError(String(e.message)) }
      }
      const quickPush = async () => {
        if (busyRef.current) return
        busyRef.current = true; setPushBusy(true); setPushResult(null)
        try {
          const r = await api('/dsh-github-flow/quick/push', { repo: pushRepo || undefined, path: pushPath || undefined })
          setPushResult(r)
        } catch (e) { setPushResult({ error: String(e.message) }) } finally { busyRef.current = false; setPushBusy(false) }
      }
      const quickRelease = async () => {
        if (busyRef.current) return
        busyRef.current = true; setRelBusy(true); setRelResult(null)
        try {
          const r = await api('/dsh-github-flow/quick/release', { repo: relRepo, version: relVersion, notes: relNotes || undefined })
          setRelResult(r)
        } catch (e) { setRelResult({ error: String(e.message) }) } finally { busyRef.current = false; setRelBusy(false) }
      }

      return h('div', { className: 'ghf-section' },
        h('style', null, CSS),
        h('div', { className: 'ghf-title' }, 'GitHub'),
        h('div', { className: 'ghf-sub' }, '连接你的 GitHub 账号：建仓库、推送项目、打版本，全部可在对话中完成。'),

        // 状态卡片
        status && status.connected
          ? h('div', { className: 'ghf-card' },
              h('div', { className: 'ghf-row' },
                status.avatar ? h('img', { className: 'ghf-avatar', src: status.avatar, alt: '' }) : h('div', { className: 'ghf-avatar ghf-avatar-fallback' }, '👤'),
                h('div', { className: 'ghf-id' },
                  h('div', { className: 'ghf-login' }, status.login),
                  h('div', { className: 'ghf-meta' }, `${status.authMode === 'oauth' ? 'OAuth 授权' : 'PAT'} · scope: ${status.scope || '未知'}`),
                ),
                h('span', { className: 'ghf-spacer' }),
                h('button', { className: 'ghf-btn ghf-btn-danger', onClick: disconnect }, '断开连接'),
              ),
            )
          : h('div', { className: 'ghf-card' },
              h('div', { className: 'ghf-row' }, h('div', { className: 'ghf-id' }, h('div', { className: 'ghf-login' }, '未连接')), h('span', { className: 'ghf-spacer' })),
              // OAuth 主路径
              h('div', { className: 'ghf-block' },
                h('div', { className: 'ghf-block-title' }, '用 GitHub 登录（推荐，同 Codex）'),
                h('button', { className: 'ghf-btn ghf-btn-primary', onClick: startFlow, disabled: flowStarting || !status || !status.clientIdConfigured },
                  flowStarting ? '发起中…' : '用 GitHub 登录'),
                !status || !status.clientIdConfigured
                  ? h('div', { className: 'ghf-hint' }, '需要先配置 OAuth Client ID（下方）。创建方法：GitHub → Settings → Developer settings → OAuth Apps → New OAuth App（名称随意，Homepage/Callback 填 http://localhost 即可）→ 复制 Client ID。')
                  : null,
              ),
              // PAT 备选
              h('div', { className: 'ghf-block' },
                h('div', { className: 'ghf-block-title' }, '或粘贴 Fine-grained PAT（备选）'),
                h('div', { className: 'ghf-row' },
                  h('input', { className: 'ghf-input', type: 'password', placeholder: 'github_pat_...', value: pat, onChange: (e) => setPat(e.target.value) }),
                  h('button', { className: 'ghf-btn ghf-btn-primary', onClick: savePat, disabled: patBusy || !pat.trim() }, patBusy ? '校验中…' : '连接'),
                ),
              ),
            ),

        // Client ID 配置
        h('div', { className: 'ghf-block' },
          h('div', { className: 'ghf-block-title' }, 'OAuth Client ID'),
          h('div', { className: 'ghf-row' },
            h('input', { className: 'ghf-input', placeholder: 'Iv1.xxxxxxxxxxxx', value: clientId === '已配置' ? '' : clientId, onChange: (e) => setClientId(e.target.value) }),
            h('button', { className: 'ghf-btn', onClick: saveClientId }, clientSaved ? '已保存 ✓' : '保存'),
          ),
        ),

        // 快捷操作（已连接时）
        status && status.connected
          ? h('div', { className: 'ghf-block' },
              h('div', { className: 'ghf-block-title' }, '快捷操作'),
              h('div', { className: 'ghf-row' },
                h('input', { className: 'ghf-input ghf-input-sm', placeholder: '仓库名（默认取工作区目录名）', value: pushRepo, onChange: (e) => setPushRepo(e.target.value) }),
                h('input', { className: 'ghf-input ghf-input-sm', placeholder: '本地路径（默认当前工作区）', value: pushPath, onChange: (e) => setPushPath(e.target.value) }),
                h('button', { className: 'ghf-btn ghf-btn-primary', onClick: quickPush, disabled: pushBusy }, pushBusy ? '推送中…' : '推送当前工作区'),
              ),
              pushResult
                ? h('div', { className: 'ghf-result' }, pushResult.error ? `✗ ${pushResult.error}` : `✓ 推送完成：+${pushResult.pushed} 更新 ${pushResult.unchanged} 不变${pushResult.deleted ? `，删除 ${pushResult.deleted}` : ''} → ${pushResult.fullName}`)
                : null,
              h('div', { className: 'ghf-row' },
                h('input', { className: 'ghf-input ghf-input-sm', placeholder: '仓库（owner/name）', value: relRepo, onChange: (e) => setRelRepo(e.target.value) }),
                h('input', { className: 'ghf-input ghf-input-sm', placeholder: '版本 vX.Y.Z', value: relVersion, onChange: (e) => setRelVersion(e.target.value) }),
                h('button', { className: 'ghf-btn ghf-btn-primary', onClick: quickRelease, disabled: relBusy || !relRepo || !relVersion }, relBusy ? '发布中…' : '发版'),
              ),
              h('input', { className: 'ghf-input', placeholder: '发布说明（可选，支持 Markdown）', value: relNotes, onChange: (e) => setRelNotes(e.target.value) }),
              relResult
                ? h('div', { className: 'ghf-result' }, relResult.error ? `✗ ${relResult.error}` : `✓ Release ${relResult.version} 已创建：${relResult.htmlUrl}`)
                : null,
            )
          : null,

        // 最近仓库
        status && status.repos && status.repos.length > 0
          ? h('div', { className: 'ghf-block' },
              h('div', { className: 'ghf-block-title' }, '最近仓库'),
              h('ul', { className: 'ghf-repos' },
                status.repos.map((r) => h('li', { key: r.fullName, className: 'ghf-repo' },
                  h('span', null, (r.private ? '🔒 ' : '') + r.fullName),
                  h('a', { className: 'ghf-link', href: r.htmlUrl, target: '_blank', rel: 'noreferrer' }, '打开 ↗'),
                )),
              ),
            )
          : null,

        error ? h('div', { className: 'ghf-error' }, error) : null,
        loading ? h('div', { className: 'ghf-hint' }, '加载中…') : null,

        flow ? h(DeviceFlowModal, { flow, onClose: () => setFlow(null), onDone: () => { setFlow(null); refresh() } }) : null,
      )
    }

    // ------------------------------------------------------------ 样式
    const CSS = `
.ghf-section{font-size:13px;line-height:1.5}
.ghf-title{font-weight:700;font-size:14px}
.ghf-sub{font-size:12px;opacity:.65;margin:4px 0 10px}
.ghf-card{border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:10px;padding:10px 12px;margin-bottom:10px;
  background:color-mix(in srgb,var(--dsw-alias-bg-base,#000) 55%,transparent)}
.ghf-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ghf-avatar{width:32px;height:32px;border-radius:50%;background:color-mix(in srgb,currentColor 12%,transparent)}
.ghf-avatar-fallback{display:flex;align-items:center;justify-content:center;font-size:16px}
.ghf-login{font-weight:600}
.ghf-meta{font-size:11px;opacity:.6}
.ghf-block{margin:10px 0}
.ghf-block-title{font-weight:600;font-size:12px;margin-bottom:6px;opacity:.85}
.ghf-btn{font-size:12px;padding:5px 12px;border-radius:6px;cursor:pointer;border:1px solid color-mix(in srgb,currentColor 22%,transparent);
  background:transparent;color:inherit;white-space:nowrap}
.ghf-btn:hover{background:color-mix(in srgb,currentColor 10%,transparent)}
.ghf-btn:disabled{opacity:.5;cursor:not-allowed}
.ghf-btn-primary{background:color-mix(in srgb,currentColor 12%,transparent);font-weight:600}
.ghf-btn-danger{color:#e5484d;border-color:color-mix(in srgb,#e5484d 40%,transparent)}
.ghf-input{flex:1;min-width:160px;font-size:12px;padding:6px 8px;border-radius:6px;background:transparent;color:inherit;
  border:1px solid color-mix(in srgb,currentColor 16%,transparent)}
.ghf-input-sm{flex:0 1 auto;min-width:120px}
.ghf-hint{font-size:11px;opacity:.6;margin-top:4px}
.ghf-result{font-size:12px;margin-top:6px;padding:6px 8px;border-radius:6px;
  background:color-mix(in srgb,var(--dsw-alias-bg-base,#000) 60%,transparent);border:1px solid color-mix(in srgb,currentColor 10%,transparent)}
.ghf-error{font-size:12px;color:#e5484d;margin-top:6px}
.ghf-repos{list-style:none;margin:0;padding:0}
.ghf-repo{display:flex;align-items:center;justify-content:space-between;padding:5px 2px;border-bottom:1px solid color-mix(in srgb,currentColor 6%,transparent);font-size:12px}
.ghf-link{font-size:11px;opacity:.7;text-decoration:none}
.ghf-link:hover{text-decoration:underline}
.ghf-overlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;padding:16px}
.ghf-modal{width:min(420px,100%);border-radius:12px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-text-primary,currentColor);
  border:1px solid color-mix(in srgb,currentColor 14%,transparent);box-shadow:0 18px 50px rgba(0,0,0,.35);overflow:hidden}
.ghf-modal-head{display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent)}
.ghf-modal-title{font-weight:600}
.ghf-modal-body{padding:16px}
.ghf-step{font-size:12px;margin:8px 0 4px;opacity:.8}
.ghf-uri{font-family:ui-monospace,monospace;font-size:13px;padding:8px;border-radius:8px;word-break:break-all;
  background:color-mix(in srgb,var(--dsw-alias-bg-base,#000) 60%,transparent);border:1px solid color-mix(in srgb,currentColor 10%,transparent)}
.ghf-code{font-family:ui-monospace,monospace;font-size:28px;font-weight:700;letter-spacing:4px;text-align:center;padding:14px;margin:6px 0;border-radius:10px;
  background:color-mix(in srgb,var(--dsw-alias-bg-base,#000) 60%,transparent);border:1px dashed color-mix(in srgb,currentColor 26%,transparent)}
.ghf-success{font-size:14px;font-weight:600;text-align:center;padding:16px}
.ghf-spacer{flex:1}
`

    // ------------------------------------------------------------ 插件
    const apply = (ctx) => {
      const slots = ctx.get('slots')
      if (!slots) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'dsh-github-flow', order: -90, label: () => 'GitHub' },
        () => h(GitHubSection, null),
      ))
    }
    const inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
