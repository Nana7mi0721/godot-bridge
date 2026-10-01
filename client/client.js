/**
 * godot-bridge — browser half (DSH web client).
 *
 * The host half of this plugin declares `godotPath` as a `.volatile()` config
 * field of its `tool-godot-bridge` row, so DSH 0.2 projects it into the
 * settings document, but a row gets a configuration form only when a browser
 * half registers the keyed slot `plugins.row.config` under
 * `<package name>#<row id>` (dsh-client-ui-plugin-manager's `rowConfigKey`).
 * This file is that registration: the row on the bundle's page then gains a
 * Configure control that opens the row's page, where the engine path can be
 * typed and saved.
 *
 * Saving goes through the `form` owner prop the page passes to the entry
 * (`{ state, mutate }`), which writes through the settings service and ends in
 * `ctx.configEditor.edit(...)` — the same profile `cordis.patch.yml` layer the
 * `godot_set_engine_path` tool writes, so both entry points agree and the new
 * path applies without a restart.
 *
 * Version boundary: DSH 0.1.6–0.1.x already declares the same slot but has no
 * settings-form service and passes no `form` prop, so the whole registration
 * sits behind `ctx.inject(['configForms'], ...)`: on those runtimes the row
 * keeps exactly the behaviour it has today (no Configure control) instead of
 * opening a page that could not save anything.
 *
 * Conventions this file must keep (dsh-client-modules):
 *   - loaded as a classic script through window.__ModuleLoader__.load();
 *   - `id` equals the package name, and the module table seeds React;
 *   - only platform-seed specifiers are required (react, react-dom, ...);
 *     anything else would have to be declared in `dsh.client.external`, and
 *     DSH's own authoring rules ask plugins not to load Harness client
 *     packages at all — the controls below are ours, styled with the host's
 *     `--dsw-alias-*` tokens copied from the host's own settings form.
 */
window.__ModuleLoader__.load({
	id: 'godot-bridge',
	factory(require) {
		const React = require('react')
		const h = React.createElement

		/** Locale namespace this browser half owns. */
		const LOCALE_NS = 'godotBridge'
		/** The config field the form edits, as the host Config declares it. */
		const FIELD = 'godotPath'

		/** English copy. */
		const en = {
			summary:
				'Sets the Godot executable the godot_* tools launch when no godot_path argument is given.',
			label: 'Godot engine path',
			hint:
				'Full path to the real Godot executable (never a version-manager shim). Saving writes it to the tool-godot-bridge row of this profile’s cordis.patch.yml and it applies immediately; the path is used as typed, so make sure it exists.',
			save: 'Save',
			saving: 'Saving…',
			saved: 'Saved. New godot_* calls use this path.',
			failed: 'The deployment did not accept this value; the stored path is unchanged.',
			reset: 'Reset to default',
			overridden: 'Set in this profile',
			readOnly: 'This deployment stores settings read-only.',
			unavailable:
				'This plugin is not loaded, so its configuration cannot be edited right now.',
		}

		/** Simplified Chinese copy. */
		const zh = {
			summary: '设置 godot_* 工具在没有 godot_path 参数时启动的 Godot 可执行文件。',
			label: 'Godot 可执行文件路径',
			hint:
				'指向真实 Godot exe 的完整路径（不要用版本管理器 shim）。保存会写入本 profile 的 cordis.patch.yml 中 tool-godot-bridge 那一行并立即生效；该值按原样使用，请确认文件存在。',
			save: '保存',
			saving: '保存中…',
			saved: '已保存。新的 godot_* 调用将使用该路径。',
			failed: '本部署没有接受该值；已保存的路径未改变。',
			reset: '恢复默认',
			overridden: '本 profile 已设置',
			readOnly: '本部署的设置为只读。',
			unavailable: '该插件当前未加载，暂时无法编辑它的配置。',
		}

		/**
		 * Controls copied from the host settings form (dsh-client-ui-primitives
		 * `settings-form/*.module.css`, `Input.module.css`, `Button.module.css`)
		 * under this plugin's own prefix, keeping only `--dsw-alias-*` token
		 * references so a theme change degrades appearance, never rendering.
		 */
		const CSS = [
			'.godot-bridge-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
			'.godot-bridge-head{display:flex;align-items:center;gap:8px}',
			'.godot-bridge-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
			'.godot-bridge-badge{font-size:11px;line-height:1.5;padding:1px 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-secondary)}',
			'.godot-bridge-input{height:34px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}',
			'.godot-bridge-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
			'.godot-bridge-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
			'.godot-bridge-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
			'.godot-bridge-footer{display:flex;align-items:center;gap:8px;padding-top:16px}',
			'.godot-bridge-save{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
			'.godot-bridge-save:disabled{opacity:.4;cursor:default}',
			'.godot-bridge-save:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
			'.godot-bridge-reset{border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}',
			'.godot-bridge-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
			'.godot-bridge-reset:disabled{cursor:default;opacity:.4}',
			'.godot-bridge-message{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
			'.godot-bridge-message[data-failed="true"]{color:var(--dsw-alias-label-error)}',
			'.godot-bridge-notice{margin:0 0 12px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
		].join('')

		/** The one field's current text, tolerating any shape the host may project. */
		function textOf(value) {
			return typeof value === 'string' ? value : ''
		}

		/**
		 * The row's configuration page: a one-liner for the summary view, the
		 * engine-path form for the page view.
		 *
		 * The draft lives in the DOM (an uncontrolled input remounted whenever the
		 * host revision moves), because only a save writes and leaving the page
		 * drops staged edits — the same contract the host's own settings form
		 * follows.
		 *
		 * @param props - `view` from the page, `form` for the entry, and the
		 *   locale reader the registration's `locale` option binds.
		 * @returns the summary line, the form, or the reason it is not editable.
		 */
		function GodotEnginePathForm(props) {
			const { t, form } = props
			const [busy, setBusy] = React.useState(false)
			const [dirty, setDirty] = React.useState(false)
			const [outcome, setOutcome] = React.useState(null)
			const [seenRevision, setSeenRevision] = React.useState(undefined)
			const input = React.useRef(null)
			// A save's own answer must survive the revision bump it causes: the host
			// folds the new value in (moving `revision`) before this component reads
			// the accepted flag back.
			const keepOutcome = React.useRef(false)

			const state = form === undefined || form === null ? undefined : form.state
			const revision = state === undefined || state === null ? undefined : state.revision
			// A host revision means the document moved under us: the staged draft is
			// stale, so the next render starts from the stored value again.
			if (seenRevision !== revision) {
				setSeenRevision(revision)
				setDirty(false)
				if (keepOutcome.current) keepOutcome.current = false
				else setOutcome(null)
			}

			if (props.view === 'summary') return t('summary')
			if (state === undefined || state === null || state.status === 'unavailable') {
				return h('p', { className: 'godot-bridge-notice', role: 'status' }, t('unavailable'))
			}
			// The settings document has not arrived yet; showing "unavailable" here
			// would be a lie, and the page fills in on its own.
			if (state.status !== 'ready') return null

			const projected = state.value === undefined || state.value === null ? undefined : state.value[FIELD]
			const value = textOf(projected)
			const overridden =
				state.user !== undefined && state.user !== null && Object.hasOwn(state.user, FIELD)
			const writable = state.writable === true
			const fieldId = 'godot-bridge-engine-path'

			/**
			 * Queue one namespace mutation and report whether the host accepted it.
			 * @param ops - ordered `set`/`unset` operations for this field.
			 */
			async function commit(ops) {
				setBusy(true)
				setOutcome(null)
				let accepted = false
				try {
					accepted = (await form.mutate(ops, state.revision)) === true
				} catch (_rejected) {
					accepted = false
				}
				if (accepted) keepOutcome.current = true
				setBusy(false)
				setOutcome(accepted ? 'saved' : 'failed')
			}

			/** Store what the input holds; an empty draft clears the profile override. */
			function save() {
				const node = input.current
				const next = node === null || node === undefined ? '' : node.value
				if (next === '') return commit([{ op: 'unset', path: [FIELD] }])
				return commit([{ op: 'set', path: [FIELD], value: next }])
			}

			return h(
				'div',
				null,
				writable ? null : h('p', { className: 'godot-bridge-notice', role: 'status' }, t('readOnly')),
				h(
					'div',
					{ className: 'godot-bridge-field' },
					h(
						'div',
						{ className: 'godot-bridge-head' },
						h('label', { className: 'godot-bridge-label', htmlFor: fieldId }, t('label')),
						overridden
							? h('span', { className: 'godot-bridge-badge' }, t('overridden'))
							: null,
					),
					h('input', {
						id: fieldId,
						className: 'godot-bridge-input',
						key: 'revision-' + String(state.revision),
						ref: input,
						type: 'text',
						defaultValue: value,
						disabled: !writable || busy,
						spellCheck: false,
						autoComplete: 'off',
						onInput: () => {
							setDirty(true)
							setOutcome(null)
						},
					}),
					h('p', { className: 'godot-bridge-hint' }, t('hint')),
				),
				h(
					'div',
					{ className: 'godot-bridge-footer' },
					h(
						'button',
						{
							type: 'button',
							className: 'godot-bridge-save',
							disabled: !writable || busy || !dirty,
							onClick: save,
						},
						busy ? t('saving') : t('save'),
					),
					overridden
						? h(
								'button',
								{
									type: 'button',
									className: 'godot-bridge-reset',
									disabled: !writable || busy,
									onClick: () => commit([{ op: 'unset', path: [FIELD] }]),
								},
								t('reset'),
							)
						: null,
					outcome === null
						? null
						: h(
								'p',
								{
									className: 'godot-bridge-message',
									'data-failed': outcome === 'failed' ? 'true' : 'false',
									role: 'status',
								},
								outcome === 'saved' ? t('saved') : t('failed'),
							),
				),
			)
		}

		return {
			/** Cordis services this browser half needs; `slots` is mandatory here. */
			inject: ['slots', 'locale'],
			/**
			 * Register the row's configuration page while the runtime serves the
			 * 0.2 settings-form service, and keep the plugin's copy in the locale
			 * service for as long as the browser half is loaded.
			 * @param ctx - the browser plugin's context.
			 */
			apply(ctx) {
				ctx.effect(
					() => ctx.locale.register(LOCALE_NS, { zh, en }),
					'godot-bridge: dictionaries',
				)
				ctx.effect(() => {
					const style = document.createElement('style')
					style.setAttribute('data-plugin', 'godot-bridge')
					style.textContent = CSS
					document.head.appendChild(style)
					return () => {
						style.remove()
					}
				}, 'godot-bridge: form styles')
				// `configForms` exists only where the Plugins page can hand an entry its
				// form (DSH 0.2+); without it this half stays inert instead of opening a
				// page that could not save. `slots.inject` itself is a fiber-owned
				// effect, so unloading the row withdraws the Configure control.
				ctx.inject(['configForms'], () => {
					ctx.slots.inject('plugins.row.config', () =>
						ctx.slots.register(
							// `<package name>#<row id>`, exactly as rowConfigKey() builds it.
							// Kept as a literal so scripts/check-plugin-contract.mjs can prove
							// it names a row this bundle's patch declares.
							{ name: 'plugins.row.config', key: 'godot-bridge#tool-godot-bridge', locale: LOCALE_NS },
							GodotEnginePathForm,
						),
					)
				})
			},
		}
	},
})
