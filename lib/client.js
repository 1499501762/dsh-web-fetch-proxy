window.__ModuleLoader__.load({
  id: 'dsh-web-fetch-proxy',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')

    const LOCALE_NS = 'settings.webFetchProxy'
    const SETTINGS_NS = 'web-fetch-proxy'
    const STATUS_PATH = '/web-fetch-proxy/api'
    const MODE_AUTO = 'auto'
    const MODE_OFF = 'off'
    const MODE_MANUAL = 'manual'

    const styles =
      '.dshWfpRow{border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:14px;padding:16px 0}' +
      '.dshWfpHeader{display:flex;align-items:flex-start;gap:24px}' +
      '.dshWfpCopy{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px}' +
      '.dshWfpTitle{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}' +
      '.dshWfpDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}' +
      '.dshWfpModes{display:grid;grid-template-columns:repeat(3,minmax(76px,1fr));flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:2px;background:var(--dsw-alias-bg-module-platform)}' +
      '.dshWfpMode{height:30px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}' +
      '.dshWfpMode:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}' +
      '.dshWfpMode[data-active=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv1)}' +
      '.dshWfpMode:disabled{cursor:default;opacity:.6}' +
      '.dshWfpStatus{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}' +
      '.dshWfpStatusText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.dshWfpStatus[data-error=true] .dshWfpStatusText{color:var(--dsw-alias-state-error-primary)}' +
      '.dshWfpStatus[data-state=ready] .dshWfpStatusText{color:var(--dsw-alias-state-success-primary)}' +
      '.dshWfpGhost{flex:none;height:26px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:0 10px;cursor:pointer}' +
      '.dshWfpGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}' +
      '.dshWfpGhost:disabled{cursor:default;opacity:.55}' +
      '.dshWfpField{display:flex;align-items:center;gap:8px}' +
      '.dshWfpLabel{flex:none;width:88px;color:var(--dsw-alias-label-secondary);font-size:13px}' +
      '.dshWfpInput{box-sizing:border-box;flex:1;min-width:0;height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-input);color:var(--dsw-alias-label-primary);padding:0 11px;font:inherit;font-size:13px;outline:none}' +
      '.dshWfpInput:focus{border-color:var(--dsw-alias-border-primary)}' +
      '.dshWfpApply{flex:none;height:36px;border:0;border-radius:8px;padding:0 14px;background:var(--dsw-alias-interactive-bg-primary);color:var(--dsw-alias-label-on-primary);font:inherit;font-size:13px;cursor:pointer}' +
      '.dshWfpApply:disabled{cursor:default;opacity:.55}' +
      '@media(max-width:680px){.dshWfpHeader{flex-direction:column;gap:12px}.dshWfpModes{width:100%}.dshWfpField{flex-wrap:wrap}.dshWfpLabel{width:100%}}'

    function ensureStyles() {
      if (document.querySelector('style[data-plugin-css="dsh-web-fetch-proxy"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-web-fetch-proxy'
      tag.dataset.pluginCss = 'dsh-web-fetch-proxy'
      tag.textContent = styles
      document.head.appendChild(tag)
    }

    const zh = {
      title: 'Web Fetch 代理',
      description: '让内置 web_fetch 经由本地代理出网，绕过 TUN fake-ip 假地址被 SSRF 防护拦截的问题。修改后立即生效。',
      auto: '自动检测',
      manual: '手动代理',
      off: '关闭',
      placeholder: 'http://127.0.0.1:7897',
      apply: '应用',
      save: '保存',
      bypass: '绕过列表',
      bypassPlaceholder: 'localhost,.internal',
      saving: '正在应用...',
      checking: '正在检测...',
      redetect: '重新检测',
      ready: '已生效',
      readyHost: '宿主已配置代理',
      source: '来源',
      disabled: '已关闭，web_fetch 直连',
      searching: '未找到可用代理，正在重试...',
      notFound: '未找到可用的本地代理',
      unavailableHost: '无法访问宿主网络模块',
      unreachable: '状态接口不可达',
      unknown: '状态未知',
      unavailable: 'Web Fetch 代理设置不可用',
    }
    const en = {
      title: 'Web Fetch proxy',
      description: 'Route the built-in web_fetch through a local proxy, so TUN fake-ip addresses stop tripping the SSRF guard. Changes apply immediately.',
      auto: 'Auto-detect',
      manual: 'Manual proxy',
      off: 'Off',
      placeholder: 'http://127.0.0.1:7897',
      apply: 'Apply',
      save: 'Save',
      bypass: 'Bypass list',
      bypassPlaceholder: 'localhost,.internal',
      saving: 'Applying...',
      checking: 'Checking...',
      redetect: 'Re-detect',
      ready: 'Active',
      readyHost: 'Host already proxied',
      source: 'via',
      disabled: 'Off - web_fetch connects directly',
      searching: 'No proxy found, retrying...',
      notFound: 'No reachable local proxy found',
      unavailableHost: 'Harness network modules unavailable',
      unreachable: 'Status endpoint unreachable',
      unknown: 'Status unknown',
      unavailable: 'Web fetch proxy settings are unavailable',
    }

    function errorText(error) {
      if (error === undefined || error === null) return 'settings request failed'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string') return error.message
      if (typeof error.code === 'string') return error.code
      return String(error)
    }

    function modeOf(proxy) {
      const text = typeof proxy === 'string' ? proxy.trim() : ''
      if (text === '' || text.toLowerCase() === MODE_AUTO) return MODE_AUTO
      const lower = text.toLowerCase()
      if (lower === MODE_OFF || lower === 'none' || lower === 'direct') return MODE_OFF
      return MODE_MANUAL
    }

    class WebFetchProxyController {
      constructor(remote) {
        this.remote = remote
        this.view = undefined
        this.generation = 0
        this.store = createSnapshotStore({
          status: 'idle',
          error: null,
          writable: false,
          mode: MODE_AUTO,
          proxy: 'auto',
          url: '',
          noProxy: '',
          revision: 0,
          runtime: { loading: false, phase: 'unknown', url: undefined, source: undefined, message: undefined, attempts: 0, updatedAt: 0 },
        })
      }

      async load() {
        const generation = ++this.generation
        this.store.update((state) => { state.status = 'loading'; state.error = null })
        try {
          const response = await this.remote.settings.describe()
          if (!response.ok) throw new Error(errorText(response.error))
          if (generation !== this.generation) return
          const view = response.value.namespaces.find((entry) => entry.ns === SETTINGS_NS)
          if (!view) {
            this.view = undefined
            this.store.update((state) => { state.status = 'unavailable'; state.writable = false })
            return
          }
          this.accept(view, response.value.writable)
          void this.refreshRuntime('status')
        } catch (error) {
          if (generation !== this.generation) return
          this.fail(error)
        }
      }

      async save(patch) {
        if (!this.view || !this.store.getSnapshot().writable) return
        const generation = ++this.generation
        this.store.update((state) => { state.status = 'saving'; state.error = null })
        try {
          const ops = Object.entries(patch).map(([key, value]) => ({ op: 'set', path: [key], value }))
          const response = await this.remote.settings.mutate(SETTINGS_NS, ops, this.view.revision)
          if (generation !== this.generation) return
          if (!response.ok) throw new Error(errorText(response.error))
          this.accept(response.value, true)
          void this.refreshRuntime('status')
          setTimeout(() => { void this.refreshRuntime('status') }, 1500)
        } catch (error) {
          if (generation !== this.generation) return
          this.fail(error)
        }
      }

      async refreshRuntime(action) {
        this.store.update((state) => { state.runtime = Object.assign({}, state.runtime, { loading: true }) })
        try {
          const response = await fetch(STATUS_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: action || 'status' }),
            credentials: 'same-origin',
          })
          const payload = await response.json().catch(() => undefined)
          if (!response.ok || !payload || payload.ok !== true) throw new Error(errorText(payload && payload.error))
          const value = payload.value || {}
          this.store.update((state) => {
            state.runtime = {
              loading: false,
              phase: typeof value.phase === 'string' ? value.phase : 'unknown',
              url: value.url,
              source: value.source,
              message: value.message,
              attempts: typeof value.attempts === 'number' ? value.attempts : 0,
              updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
            }
          })
        } catch (error) {
          this.store.update((state) => {
            state.runtime = { loading: false, phase: 'unreachable', message: errorText(error), url: undefined, source: undefined, attempts: 0, updatedAt: 0 }
          })
        }
      }

      accept(view, writable) {
        const value = view.value || {}
        const proxy = typeof value.proxy === 'string' ? value.proxy : 'auto'
        this.view = view
        this.store.update((state) => {
          state.status = 'ready'
          state.error = null
          state.writable = writable
          state.proxy = proxy
          state.mode = modeOf(proxy)
          state.url = state.mode === MODE_MANUAL ? proxy : ''
          state.noProxy = typeof value.noProxy === 'string' ? value.noProxy : ''
          state.revision = view.revision
        })
      }

      fail(error) {
        this.store.update((state) => {
          state.status = 'error'
          state.error = error instanceof Error ? error.message : String(error)
        })
      }

      dispose() {
        this.generation += 1
        this.view = undefined
      }
    }

    function runtimeText(runtime, t) {
      if (runtime.loading) return t('checking')
      const phase = runtime.phase
      if (phase === 'ready') {
        const label = runtime.source === 'host' ? t('readyHost') : t('ready')
        const parts = [label]
        if (runtime.url) parts.push(runtime.url)
        if (runtime.source && runtime.source !== 'host') parts.push('(' + t('source') + ': ' + runtime.source + ')')
        return parts.join('  ')
      }
      if (phase === 'disabled') return t('disabled')
      if (phase === 'searching') return t('searching')
      if (phase === 'error') return t('notFound') + (runtime.message ? ' - ' + runtime.message : '')
      if (phase === 'unavailable') return t('unavailableHost') + (runtime.message ? ': ' + runtime.message : '')
      if (phase === 'unreachable') return t('unreachable')
      return t('unknown')
    }

    function WebFetchProxyRow({ controller, useRow, t }) {
      const state = useRow((snapshot) => snapshot)
      const [url, setUrl] = React.useState(state.url)
      const [bypass, setBypass] = React.useState(state.noProxy)
      const [draftManual, setDraftManual] = React.useState(false)

      React.useEffect(() => { controller.load() }, [controller])
      React.useEffect(() => { setUrl(state.url) }, [state.url])
      React.useEffect(() => { setBypass(state.noProxy) }, [state.noProxy])
      React.useEffect(() => {
        if (state.status === 'ready' && state.mode === MODE_MANUAL) setDraftManual(false)
      }, [state.status, state.mode])

      if (state.status === 'unavailable') return null

      const busy = state.status === 'loading' || state.status === 'saving'
      const disabled = busy || !state.writable
      const manualActive = state.mode === MODE_MANUAL || draftManual
      const statusText = state.error || (state.status === 'saving' ? t('saving') : '')
      const runtime = state.runtime || { phase: 'unknown' }
      const runtimeFailed = runtime.phase === 'error' || runtime.phase === 'unreachable' || runtime.phase === 'unavailable'

      const choose = (mode) => {
        if (disabled) return
        if (mode === state.mode && !draftManual) return
        if (mode === MODE_MANUAL) {
          if (state.mode === MODE_MANUAL) return
          setDraftManual(true)
          return
        }
        setDraftManual(false)
        controller.save({ proxy: mode === MODE_OFF ? MODE_OFF : MODE_AUTO })
      }

      return React.createElement('div', { className: 'dshWfpRow' },
        React.createElement('div', { className: 'dshWfpHeader' },
          React.createElement('div', { className: 'dshWfpCopy' },
            React.createElement('div', { className: 'dshWfpTitle' }, t('title')),
            React.createElement('div', { className: 'dshWfpDesc' }, t('description')),
            statusText
              ? React.createElement('div', { className: 'dshWfpStatus', 'data-error': Boolean(state.error), role: state.error ? 'alert' : undefined },
                  React.createElement('span', { className: 'dshWfpStatusText' }, statusText))
              : null),
          React.createElement('div', { className: 'dshWfpModes', role: 'radiogroup', 'aria-label': t('title') },
            [MODE_AUTO, MODE_MANUAL, MODE_OFF].map((mode) => React.createElement('button', {
              key: mode,
              type: 'button',
              role: 'radio',
              'aria-checked': mode === MODE_MANUAL ? manualActive : state.mode === mode,
              'data-active': mode === MODE_MANUAL ? manualActive : state.mode === mode,
              className: 'dshWfpMode',
              disabled,
              onClick: () => choose(mode),
            }, t(mode))))),
        React.createElement('div', { className: 'dshWfpStatus', 'data-error': runtimeFailed, 'data-state': runtime.phase },
          React.createElement('span', { className: 'dshWfpStatusText' }, runtimeText(runtime, t)),
          React.createElement('button', {
            type: 'button',
            className: 'dshWfpGhost',
            disabled: runtime.loading,
            onClick: () => { void controller.refreshRuntime('redetect') },
          }, runtime.loading ? t('checking') : t('redetect'))),
        manualActive
          ? React.createElement('form', {
              className: 'dshWfpField',
              onSubmit: (event) => { event.preventDefault(); controller.save({ proxy: url.trim() }) },
            },
              React.createElement('span', { className: 'dshWfpLabel' }, t('manual')),
              React.createElement('input', {
                className: 'dshWfpInput',
                type: 'text',
                inputMode: 'url',
                value: url,
                placeholder: t('placeholder'),
                disabled,
                required: true,
                autoFocus: draftManual,
                'aria-label': t('manual'),
                onChange: (event) => setUrl(event.target.value),
              }),
              React.createElement('button', {
                className: 'dshWfpApply',
                type: 'submit',
                disabled: disabled || !url.trim() || (state.mode === MODE_MANUAL && url.trim() === state.proxy),
              }, t('apply')))
          : null,
        React.createElement('form', {
          className: 'dshWfpField',
          onSubmit: (event) => { event.preventDefault(); controller.save({ noProxy: bypass.trim() }) },
        },
          React.createElement('span', { className: 'dshWfpLabel' }, t('bypass')),
          React.createElement('input', {
            className: 'dshWfpInput',
            type: 'text',
            value: bypass,
            placeholder: t('bypassPlaceholder'),
            disabled,
            'aria-label': t('bypass'),
            onChange: (event) => setBypass(event.target.value),
          }),
          React.createElement('button', {
            className: 'dshWfpApply',
            type: 'submit',
            disabled: disabled || bypass.trim() === state.noProxy,
          }, t('save'))))
    }

    const inject = ['slots', 'locale', 'remote', 'remote.settings']

    function apply(ctx) {
      ensureStyles()
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'web-fetch-proxy: dictionaries')
      const t = ctx.locale.bind(LOCALE_NS)
      const controller = new WebFetchProxyController(ctx.remote)
      const useRow = (selector) => React.useSyncExternalStore(
        (listener) => controller.store.subscribe(listener),
        () => selector(controller.store.getSnapshot()),
        () => selector(controller.store.getSnapshot()),
      )
      const injected = () => ({ controller, useRow, t })
      ctx.effect(() => {
        const refresh = () => {
          if (controller.store.getSnapshot().status !== 'idle') controller.load()
        }
        const disposers = [
          ctx.remote.$on('settings/document-updated', (ns) => { if (ns === SETTINGS_NS) refresh() }),
          ctx.on('connection/reset', refresh),
        ]
        return () => { controller.dispose(); for (const dispose of disposers) dispose() }
      }, 'web-fetch-proxy: invalidations')
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'web-fetch-proxy',
        order: 20,
        locale: LOCALE_NS,
        inject: injected,
      }, WebFetchProxyRow))
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
