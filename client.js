window.__ModuleLoader__.load({
  id: '@local/dsh-workspace-fork',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'workspace-fork'

    const DICT = {
      en: {
        'menu.label': 'Fork to workspace…',
        'dialog.title': 'Fork into another workspace',
        'dialog.description': 'Choose the workspace that will own the new branch. It starts at the latest completed turn and keeps the conversation history.',
        'dialog.empty': 'No other workspace is available. Add one in the sidebar first.',
        'dialog.busy': 'Forking…',
        'dialog.cancel': 'Cancel',
        'dialog.close': 'Close',
        'dialog.success': 'Forked to “{title}”. The new conversation was created inside that workspace.',
      },
      zh: {
        'menu.label': '分叉到工作区…',
        'dialog.title': '分叉到其他工作区',
        'dialog.description': '选择新分支所在的工作区。分支从最近一个完成的回合开始，并保留此前的对话历史。',
        'dialog.empty': '没有其他可用的工作区。请先在侧栏添加一个工作区。',
        'dialog.busy': '正在分叉…',
        'dialog.cancel': '取消',
        'dialog.close': '关闭',
        'dialog.success': '已分叉到「{title}」。新对话已在该工作区中创建。',
      },
    }

    const CSS = `
.dsh-wsf-row {
  display: flex; align-items: center; gap: 8px;
  width: 100%; box-sizing: border-box; margin: 0;
  padding: 6px 10px; border: 0; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 18px;
  text-align: left; white-space: nowrap; cursor: pointer;
}
.dsh-wsf-row:hover, .dsh-wsf-row:focus-visible {
  background: var(--dsw-alias-bg-layer-2); outline: none;
}
.dsh-wsf-row > svg {
  width: 14px; height: 14px; flex: none;
  color: var(--dsw-alias-label-secondary);
}
.dsh-wsf-backdrop {
  position: fixed; inset: 0; z-index: 1200;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.32);
}
.dsh-wsf-dialog {
  display: flex; flex-direction: column;
  width: min(540px, calc(100vw - 48px));
  max-height: min(580px, calc(100vh - 80px));
  box-sizing: border-box; padding: 20px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
  color: var(--dsw-alias-label-primary);
}
.dsh-wsf-dialog:focus { outline: none; }
.dsh-wsf-title {
  margin: 0 0 6px; font-size: 15px; line-height: 21px; font-weight: 600;
}
.dsh-wsf-description {
  margin: 0 0 14px; font-size: 12.5px; line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-wsf-list {
  display: flex; flex-direction: column; gap: 2px;
  min-height: 0; overflow: auto; margin: 0 -6px; padding: 0 6px;
}
.dsh-wsf-item {
  display: flex; flex-direction: column; gap: 2px;
  width: 100%; box-sizing: border-box; margin: 0;
  padding: 9px 10px; border: 0; border-radius: 8px;
  background: transparent; color: inherit;
  font: inherit; text-align: left; cursor: pointer;
}
.dsh-wsf-item:hover:not(:disabled), .dsh-wsf-item:focus-visible:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2); outline: none;
}
.dsh-wsf-item:disabled { cursor: default; opacity: 0.65; }
.dsh-wsf-item-head {
  display: flex; align-items: baseline; gap: 8px; min-width: 0;
}
.dsh-wsf-item-title {
  font-size: 13px; line-height: 18px; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-wsf-item-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px; line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-wsf-note {
  padding: 6px 4px 10px; font-size: 12.5px; line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-wsf-error {
  margin: 0 0 12px; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
  font-size: 12.5px; line-height: 18px;
  overflow-wrap: anywhere;
}
.dsh-wsf-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  margin-top: 16px; flex: none;
}
.dsh-wsf-button {
  padding: 6px 14px; border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 18px; cursor: pointer;
}
.dsh-wsf-button:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-wsf-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
`

    /**
     * Create a minimal snapshot store shared by the menu row and the dialog.
     * @param initial - initial snapshot.
     * @returns get/subscribe/set helpers.
     */
    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set: (next) => {
          snapshot = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /** The one picker occurrence: closed when null. */
    const picker = createStore(null)

    /**
     * Subscribe a component to the picker store.
     * @returns the current snapshot.
     */
    function usePicker() {
      return React.useSyncExternalStore(picker.subscribe, picker.getSnapshot, picker.getSnapshot)
    }

    /**
     * Compare two filesystem paths without a host process.
     * @param left - one path.
     * @param right - the other path.
     * @returns whether they name the same location.
     */
    function samePath(left, right) {
      const normalize = (value) => String(value).replace(/\\+/gu, '/').replace(/\/+$/u, '')
      const a = normalize(left)
      const b = normalize(right)
      if (a === b) return true
      const windows = /^[a-zA-Z]:\//u.test(a) || /^[a-zA-Z]:\//u.test(b)
      return windows && a.toLowerCase() === b.toLowerCase()
    }

    /**
     * Read the stable failure text from a Remote failure or thrown value.
     * @param error - failure to describe.
     * @returns a printable message.
     */
    function messageOf(error) {
      if (error === null || error === undefined) return 'Unknown error'
      if (typeof error === 'string') return error
      return String(error.message ?? error)
    }

    /**
     * Ask the Host to fork one conversation and locate the created branch.
     * @param ctx - Client plugin context.
     * @param sourceId - conversation being forked.
     * @param workspace - target workspace row (`workspaceId`, `path`).
     * @returns the branch id when it can be resolved.
     */
    async function forkInto(ctx, sourceId, workspace) {
      const line = `/fork-to-workspace ${workspace.workspaceId}`
      const response = await ctx.remote.commands.execute(sourceId, line, [])
      if (!response.ok) throw new Error(response.error.message)
      if (response.value === undefined) throw new Error('The fork command is not available in this deployment.')
      const result = response.value.result
      if (result.kind === 'error') throw new Error(result.text)

      const direct = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu.exec(result.text ?? '')
      if (direct !== null) return direct[0]

      try {
        const listed = await ctx.remote.session.list({})
        if (listed.ok) {
          const rows = listed.value.items
            .filter((row) => row.parentSessionId === sourceId && row.cwd !== undefined && samePath(row.cwd, workspace.path))
            .sort((a, b) => b.updatedAt - a.updatedAt)
          if (rows[0] !== undefined) return rows[0].sessionId
        }
      } catch {
        // The branch still exists; the caller reports success without navigating.
      }
      return undefined
    }

    /** Branch glyph, drawn in `currentColor`. */
    function BranchIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('circle', { cx: 4, cy: 3, r: 1.6 }),
        h('circle', { cx: 4, cy: 13, r: 1.6 }),
        h('circle', { cx: 12, cy: 6, r: 1.6 }),
        h('path', { d: 'M4 4.6v6.8' }),
        h('path', { d: 'M4 8.6C4 6.8 5.4 6 12 6' }),
      )
    }

    /**
     * One row in a conversation's “...” menu.
     * @param props - owner share, menu state, access check, and the plugin's translate function.
     * @returns the menu row, or null when this caller may not fork the conversation.
     */
    function ForkToWorkspaceRow(props) {
      const { sessionId, displayTitle, useMenuOpenState, useSessionAccess, useWorkspaces, t } = props
      const [, setMenuOpen] = useMenuOpenState()
      const permitted = useSessionAccess(sessionId, 'session/fork')
      const workspaces = useWorkspaces((snapshot) => snapshot.items)
      if (!permitted) return null

      const open = () => {
        setMenuOpen(false)
        const items = Array.isArray(workspaces) ? workspaces : []
        const current = items.find((workspace) => Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId))
        picker.set({
          sourceId: sessionId,
          sourceTitle: displayTitle ?? '',
          workspaces: items.map((workspace) => ({
            workspaceId: workspace.workspaceId,
            title: workspace.title ?? '',
            path: workspace.path ?? '',
            sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [],
          })),
          currentWorkspaceId: current?.workspaceId,
          busy: false,
          error: undefined,
          result: undefined,
        })
      }

      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dsh-wsf-row',
        onClick: open,
      }, h(BranchIcon, null), h('span', null, t('menu.label')))
    }

    /**
     * The workspace picker dialog rendered in the frame-wide overlay slot.
     * @param props - injected translate function, fork runner, and session opener.
     * @returns the dialog while a picker occurrence is open, otherwise null.
     */
    function WorkspaceForkPicker(props) {
      const { t, runFork, openSession } = props
      const state = usePicker()
      const dialogRef = React.useRef(null)

      React.useEffect(() => {
        if (state !== null && dialogRef.current !== null) dialogRef.current.focus()
      }, [state !== null])

      React.useEffect(() => {
        if (state === null) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape' && !picker.getSnapshot()?.busy) picker.set(null)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [state === null])

      if (state === null) return null

      const close = () => {
        if (!state.busy) picker.set(null)
      }

      const choose = async (workspace) => {
        const current = picker.getSnapshot()
        if (current === null || current.busy || workspace.workspaceId === current.currentWorkspaceId) return
        picker.set({ ...current, busy: true, error: undefined, result: undefined })
        try {
          const childId = await runFork(state.sourceId, workspace)
          if (childId !== undefined) {
            picker.set(null)
            openSession(childId)
          } else {
            picker.set({ ...picker.getSnapshot(), busy: false, result: { title: workspace.title || workspace.path } })
          }
        } catch (error) {
          picker.set({ ...picker.getSnapshot(), busy: false, error: messageOf(error) })
        }
      }

      const workspaces = Array.isArray(state.workspaces) ? state.workspaces : []
      const others = workspaces.filter((workspace) => workspace.workspaceId !== state.currentWorkspaceId)

      return h('div', {
        className: 'dsh-wsf-backdrop',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) close()
        },
      }, h('div', {
        className: 'dsh-wsf-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'dsh-wsf-title',
        tabIndex: -1,
        ref: dialogRef,
      },
        h('h2', { className: 'dsh-wsf-title', id: 'dsh-wsf-title' }, t('dialog.title')),
        h('p', { className: 'dsh-wsf-description' }, t('dialog.description')),
        state.sourceTitle.trim().length > 0 ? h('div', { className: 'dsh-wsf-note' }, `“${state.sourceTitle}”`) : null,
        state.error === undefined ? null : h('div', { className: 'dsh-wsf-error', role: 'alert' }, state.error),
        state.result === undefined
          ? null
          : h('div', { className: 'dsh-wsf-note', role: 'status' }, t('dialog.success', { title: state.result.title })),
        others.length === 0
          ? h('div', { className: 'dsh-wsf-note' }, t('dialog.empty'))
          : h('div', { className: 'dsh-wsf-list' }, others.map((workspace) => {
            const title = workspace.title.length > 0 ? workspace.title : workspace.path
            return h('button', {
              key: workspace.workspaceId,
              type: 'button',
              className: 'dsh-wsf-item',
              disabled: state.busy,
              onClick: () => { void choose(workspace) },
            },
              h('span', { className: 'dsh-wsf-item-head' },
                h('span', { className: 'dsh-wsf-item-title' }, title),
              ),
              h('span', { className: 'dsh-wsf-item-path' }, workspace.path),
            )
          })),
        h('div', { className: 'dsh-wsf-footer' },
          h('span', {
            style: { alignSelf: 'center', marginRight: 'auto', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
          }, state.busy ? t('dialog.busy') : ''),
          h('button', {
            type: 'button',
            className: 'dsh-wsf-button',
            disabled: state.busy,
            onClick: close,
          }, state.result === undefined ? t('dialog.cancel') : t('dialog.close')),
        ),
      ))
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands', 'remote.session', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'workspace-fork: dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-workspace-fork', '')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'workspace-fork: styles')
        const t = ctx.locale.bind(NS)
        const runFork = (sourceId, workspace) => forkInto(ctx, sourceId, workspace)

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'fork-to-workspace',
          order: 350,
          label: () => t('menu.label'),
        }, (slotProps) => h(ForkToWorkspaceRow, { ...slotProps, t })))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'workspace-fork-picker',
          order: 200,
        }, (slotProps) => h(WorkspaceForkPicker, {
          ...slotProps,
          t,
          runFork,
          openSession: (sessionId) => ctx.uiWorkspace.openSession(sessionId),
        })))
      },
    }
  },
})
