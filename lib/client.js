/**
 * dsh-session-url · browser half.
 *
 * One conversation, one link: the main-view conversation is mirrored into the
 * URL fragment, and loading (or pasting) an `#/session/<id>` link opens the
 * conversation it names. No DOM seat, no settings card, no host behavior.
 *
 * This file is the shipped artifact, hand-written and committed as source: there
 * is no build step in this repository. It follows the Web GUI module-loader
 * contract — the loader calls the factory once and takes its exports as the
 * client module (`apply`, `inject`).
 *
 * Why the fragment (and never the path or query): the host's static fallback
 * serves `index.html` only for a path that resolves to the dist root, so a
 * path-style deep link cannot boot the GUI at all; and every request that still
 * carries the launch `?token=` is answered with a 303 to the clean `./`, which
 * drops extra query parameters. A fragment is never sent to the host, so an
 * in-app link survives every navigation the GUI itself performs.
 */
window.__ModuleLoader__.load({
	id: 'dsh-session-url',
	factory: () => {
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		// ---------------------------------------------------------------------
		// main-view session: resolve the Session the main view currently shows.
		// Reads the catalog's rows rather than a per-id retain-info source, so this
		// neither allocates observers nor opens history, and a subscription to the
		// list still fires when the selection moves.
		// ---------------------------------------------------------------------
		function mainViewSessionId(byId) {
			if (byId === undefined || byId === null) return undefined
			for (const row of Object.values(byId)) {
				if (row !== undefined && (row.retainedBy?.mainView ?? 0) > 0) return row.id
			}
			return undefined
		}

		// ---------------------------------------------------------------------
		// codec: the single mapping between a browser location and a conversation.
		//
		// Canonical form is `#/session/<encoded id>`; the decoder also accepts the
		// plural `#/sessions/<id>` and a missing leading slash, because a link a
		// human retyped should still open the conversation it names.
		// ---------------------------------------------------------------------
		/** Canonical fragment prefix this plugin owns. */
		const SESSION_HASH_PREFIX = '#/session/'
		/** Fragment shapes the decoder accepts: canonical plus the tolerant variants. */
		const SESSION_HASH_PATTERN = /^#\/?sessions?\/(.+)$/

		/**
		 * Read the conversation identity out of a location fragment.
		 * @param {string} hash - the raw `window.location.hash`, including the leading `#`.
		 * @returns {string|undefined} the decoded session id, or undefined when the fragment names none.
		 */
		function parseSessionHash(hash) {
			const match = SESSION_HASH_PATTERN.exec(hash)
			if (match === null) return undefined
			const raw = match[1].replace(/\/+$/, '')
			if (raw === '') return undefined
			let id = raw
			try {
				id = decodeURIComponent(raw)
			} catch {}
			const trimmed = id.trim()
			return trimmed === '' ? undefined : trimmed
		}

		/**
		 * Build the canonical fragment for a conversation.
		 * @param {string} id - session identity.
		 * @returns {string} the `#/session/<encoded id>` fragment.
		 */
		function sessionHash(id) {
			return `${SESSION_HASH_PREFIX}${encodeURIComponent(id)}`
		}

		/**
		 * Build the address-bar URL for one view state.
		 * @param {string} pathname - current `location.pathname` (the mount path is preserved).
		 * @param {string} search - current `location.search` (a launch token, when present).
		 * @param {string|undefined} id - conversation to name, or undefined for "no conversation shown".
		 * @returns {string} pathname + search, with the session fragment when one is named.
		 */
		function sessionUrl(pathname, search, id) {
			const base = `${pathname}${search}`
			return id === undefined ? base : `${base}${sessionHash(id)}`
		}

		// ---------------------------------------------------------------------
		// synchronisation: two directions, one owner per direction.
		//
		//   - Fragment to view: a link names a conversation, so loading (or pasting)
		//     `#/session/<id>` opens it.
		//   - View to fragment: the address bar always names the conversation the main
		//     view shows, so selecting a session in the sidebar rewrites the fragment.
		//
		// The state machine is host-injected (catalog, navigation, location, clock,
		// timer) and therefore deterministic in tests: no DOM here, no globals.
		//
		// Why a link needs an enforcement window: the view owner restores the locally
		// saved selection as soon as its catalog and workspace lists arrive. A link
		// read at bundle evaluation is usually read before that restore's first
		// openSession, so the restore sees the main view already claimed and stands
		// down. When this plugin loads late instead, the restore can still land after
		// the link opened, so the link stays authoritative for
		// LINK_ENFORCE_WINDOW_MS and re-opens itself once if the view moves away.
		// After that window the view owns the URL again: a user click during boot is
		// not fought for longer than a boot. The same window is what waits for the
		// catalog to list a linked conversation — a snapshot that omits it is not
		// evidence that it is dead — so an unlisted link is dropped only at expiry.
		// ---------------------------------------------------------------------
		/** Log prefix for every session-url diagnostic. */
		const TAG = '[session-url]'
		/**
		 * How long a linked conversation stays authoritative over the view owner's own
		 * restore: long enough to outlast one catalog round-trip plus one blank-session
		 * reuse, short enough that a click during boot is not visibly overridden.
		 */
		const LINK_ENFORCE_WINDOW_MS = 8000

		/**
		 * Start synchronising the fragment with the main-view conversation.
		 * @param {object} host - the injected faces.
		 * @returns {() => void} the disposer removing every subscription and timer.
		 */
		function startSessionUrlSync(host) {
			/** The link the address bar currently claims, with its enforcement deadline. */
			let linked
			let cancelTimer
			let disposed = false
			/** Whether this link was already passed to the view owner once. */
			let opened = false
			/** The main-view identity observed on the previous catalog notification. */
			let seen

			const dropTimer = () => {
				cancelTimer?.()
				cancelTimer = undefined
			}
			const dropLink = () => {
				linked = undefined
				opened = false
				dropTimer()
			}
			/** Write the fragment for the view state, leaving path and query untouched. */
			const reflect = current => {
				const { pathname, search, hash } = host.readLocation()
				if (hash === (current === undefined ? '' : sessionHash(current))) return
				host.replaceUrl(sessionUrl(pathname, search, current))
			}
			/**
			 * Re-read the catalog and move towards the state the address bar describes.
			 *
			 * The `opened`/`seen` pair is the re-entrancy guard: opening a conversation
			 * notifies the catalog, and the re-entrant call must not open it again when
			 * the snapshot has not caught up yet.
			 */
			const reconcile = () => {
				if (disposed) return
				const snapshot = host.catalog.getSnapshot()
				if (snapshot.phase !== 'ready') return
				const current = mainViewSessionId(snapshot.byId)
				if (linked !== undefined) {
					const { id, deadline } = linked
					const changed = seen !== current
					seen = current
					if (current === id) {
						opened = true
						return
					}
					if (host.archivedSessionIds().includes(id)) {
						host.warn(`${TAG} ${sessionHash(id)} is archived; the link was ignored`)
						dropLink()
						reflect(current)
						return
					}
					if (host.now() >= deadline) {
						host.warn(opened
							? `${TAG} ${sessionHash(id)} did not open within ${LINK_ENFORCE_WINDOW_MS} ms; the link was ignored`
							: `${TAG} ${sessionHash(id)} is not in the session catalog; the link was ignored`)
						dropLink()
						reflect(current)
						return
					}
					if ((snapshot.ids.includes(id) || snapshot.byId[id] !== undefined) && (!opened || changed)) {
						opened = true
						host.openSession(id)
					}
					return
				}
				reflect(current)
			}
			/** Adopt the conversation the address bar names, if it names one. */
			const readLink = () => {
				if (disposed) return
				const id = parseSessionHash(host.readLocation().hash)
				if (id === undefined) {
					dropLink()
					reconcile()
					return
				}
				if (linked?.id !== id) {
					linked = { id, deadline: host.now() + LINK_ENFORCE_WINDOW_MS }
					opened = false
				}
				dropTimer()
				cancelTimer = host.setTimer(() => {
					cancelTimer = undefined
					reconcile()
				}, LINK_ENFORCE_WINDOW_MS)
				reconcile()
			}

			const offCatalog = host.catalog.subscribe(reconcile)
			const offHashChange = host.onHashChange(readLink)
			readLink()
			return () => {
				disposed = true
				dropTimer()
				offCatalog()
				offHashChange()
			}
		}

		// ---------------------------------------------------------------------
		// browser wiring: probe the official faces, then drive the machine.
		// ---------------------------------------------------------------------
		/** Services this plugin needs before apply runs. */
		const inject = ['sessions', 'workspaces', 'uiWorkspace']

		/**
		 * Probe the three client faces the sync needs. A changed surface returns null
		 * so the plugin leaves the official behavior untouched.
		 * @param {object} scope - client context carrying the sessions, workspaces, and navigation faces.
		 * @returns {object|null} the probed faces, or null when any of them is unusable.
		 */
		function probeFaces(scope) {
			const list = scope.sessions?.list
			const registry = scope.workspaces?.list
			const navigation = scope.uiWorkspace
			if (typeof list !== 'object' || list === null) return null
			if (typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return null
			if (typeof registry !== 'object' || registry === null) return null
			if (typeof registry.getSnapshot !== 'function') return null
			if (typeof navigation !== 'object' || navigation === null) return null
			const openSession = navigation.openSession
			if (typeof openSession !== 'function') return null
			return {
				catalog: list,
				archivedSessionIds: () => registry.getSnapshot().archivedSessionIds,
				openSession: id => openSession.call(navigation, id),
			}
		}

		/**
		 * Build the live browser host over the probed faces.
		 * @param {object} faces - the probed service faces.
		 * @returns {object} the host the state machine drives.
		 */
		function browserHost(faces) {
			return {
				catalog: faces.catalog,
				archivedSessionIds: faces.archivedSessionIds,
				openSession: faces.openSession,
				readLocation: () => ({
					pathname: window.location.pathname,
					search: window.location.search,
					hash: window.location.hash,
				}),
				replaceUrl: url => {
					window.history.replaceState(null, '', url)
				},
				onHashChange: handler => {
					window.addEventListener('hashchange', handler)
					window.addEventListener('popstate', handler)
					return () => {
						window.removeEventListener('hashchange', handler)
						window.removeEventListener('popstate', handler)
					}
				},
				now: () => Date.now(),
				setTimer: (handler, delayMs) => {
					const timer = window.setTimeout(handler, delayMs)
					return () => window.clearTimeout(timer)
				},
				warn: message => console.warn(message),
			}
		}

		// ---------------------------------------------------------------------
		// row links: every conversation row in the sidebar becomes a real anchor.
		//
		// A real <a href="#/session/<id>" target="_blank"> is what makes the link a
		// first-class thing instead of an address-bar convention: left click and
		// middle click open the conversation in a new tab, and the browser's own
		// context menu offers "open link in new tab", "copy link", "save link as" —
		// no custom menu to maintain.
		//
		// The row's identity rides its `data-row-key="session:<id>"` attribute (the
		// official sidebar list is virtualized, so rows come and go; a
		// MutationObserver re-scans). Anything unexpected — no document, no rows, no
		// observer — degrades to doing nothing at all.
		// ---------------------------------------------------------------------
		/** Row attribute carrying the conversation identity. */
		const ROW_KEY_ATTRIBUTE = 'data-row-key'
		/** Prefix of that attribute's value for a conversation row. */
		const ROW_KEY_PREFIX = 'session:'
		/** Rows this plugin looks at. */
		const ROW_SELECTOR = `[${ROW_KEY_ATTRIBUTE}^="${ROW_KEY_PREFIX}"]`
		/** Marks the anchor this plugin owns inside a row. */
		const ANCHOR_PART = 'session-link'
		/** Id of the stylesheet this plugin injects. */
		const STYLE_ID = 'dsh-session-url-style'
		/** Marks a row whose positioning context this plugin had to establish. */
		const HOST_ATTRIBUTE = 'data-dsh-session-url-host'
		/** Tooltip naming both the click and the right-click behaviour. */
		const LINK_TITLE = '在新标签页中打开 · 右键可复制链接 / Open in a new tab · right-click to copy the link'
		/** One stylesheet for every anchor; the icon stays invisible until the row is hovered. */
		const STYLE_TEXT = [
			'.dsh-session-url-link{position:absolute;right:6px;top:50%;transform:translateY(-50%);',
			'display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;',
			'border-radius:4px;color:currentColor;opacity:0;pointer-events:none;text-decoration:none;cursor:pointer;',
			'transition:opacity .12s ease}',
			`[${ROW_KEY_ATTRIBUTE}]:hover .dsh-session-url-link,[${ROW_KEY_ATTRIBUTE}]:focus-within .dsh-session-url-link{opacity:.6;pointer-events:auto}`,
			'.dsh-session-url-link:hover{opacity:1;background:rgba(127,127,127,.2)}',
			'.dsh-session-url-link:focus-visible{opacity:1;outline:1px solid currentColor;pointer-events:auto}',
		].join('')

		/**
		 * Read the conversation identity out of one row.
		 * @param {object} row - a candidate row element.
		 * @returns {string|undefined} the session id, or undefined when the row names none.
		 */
		function sessionIdOfRow(row) {
			if (row === null || row === undefined || typeof row.getAttribute !== 'function') return undefined
			const key = row.getAttribute(ROW_KEY_ATTRIBUTE)
			if (typeof key !== 'string' || !key.startsWith(ROW_KEY_PREFIX)) return undefined
			const id = key.slice(ROW_KEY_PREFIX.length).trim()
			return id === '' ? undefined : id
		}

		/**
		 * Build the small link icon (an arrow leaving a box).
		 * @param {object} document - the document to create the node in.
		 * @returns {object} the icon node.
		 */
		function linkIcon(document) {
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
			svg.setAttribute('width', '12')
			svg.setAttribute('height', '12')
			svg.setAttribute('viewBox', '0 0 16 16')
			svg.setAttribute('fill', 'none')
			svg.setAttribute('aria-hidden', 'true')
			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
			path.setAttribute('d', 'M9.5 2.5h4v4M13.5 2.5 7.8 8.2M12 10.5v3H2.5v-9.5h3')
			path.setAttribute('stroke', 'currentColor')
			path.setAttribute('stroke-width', '1.3')
			path.setAttribute('stroke-linecap', 'round')
			path.setAttribute('stroke-linejoin', 'round')
			svg.appendChild(path)
			return svg
		}

		/**
		 * Build the anchor for one conversation.
		 *
		 * The three pointer handlers only stop propagation: the anchor keeps its
		 * native behaviour (a new tab), while the row's own click handling — which
		 * would navigate the current tab — never sees the event.
		 * @param {object} document - the document to create the node in.
		 * @param {string} id - session identity the link names.
		 * @returns {object} the anchor node.
		 */
		function rowAnchor(document, id) {
			const anchor = document.createElement('a')
			anchor.setAttribute('href', sessionHash(id))
			anchor.setAttribute('target', '_blank')
			anchor.setAttribute('rel', 'noreferrer')
			anchor.setAttribute('title', LINK_TITLE)
			anchor.setAttribute('aria-label', LINK_TITLE)
			anchor.setAttribute('data-dsh-plugin', 'dsh-session-url')
			anchor.setAttribute('data-dsh-part', ANCHOR_PART)
			anchor.className = 'dsh-session-url-link'
			const stop = event => {
				if (event !== null && typeof event.stopPropagation === 'function') event.stopPropagation()
			}
			anchor.addEventListener('click', stop)
			anchor.addEventListener('pointerdown', stop)
			anchor.addEventListener('mousedown', stop)
			anchor.appendChild(linkIcon(document))
			return anchor
		}

		/**
		 * Give one row its anchor, if it needs one.
		 * @param {object} document - the document the row lives in.
		 * @param {object} row - candidate row element.
		 * @returns {boolean} whether the row now carries an anchor.
		 */
		function enhanceRow(document, row) {
			const id = sessionIdOfRow(row)
			if (id === undefined) return false
			if (typeof row.querySelector !== 'function' || typeof row.appendChild !== 'function') return false
			if (row.querySelector(`[data-dsh-part="${ANCHOR_PART}"]`) !== null) return true
			// The anchor is absolutely positioned, so the row must be a positioning
			// context; only take that over when the row does not already establish one.
			const style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(row) : undefined
			if (style !== undefined && style !== null && style.position === 'static' && row.style !== undefined) {
				row.style.position = 'relative'
				if (typeof row.setAttribute === 'function') row.setAttribute(HOST_ATTRIBUTE, '1')
			}
			row.appendChild(rowAnchor(document, id))
			return true
		}

		/**
		 * Turn every conversation row into a link, and keep doing so as the list
		 * virtualizes.
		 * @param {object} document - the document to enhance (may be absent).
		 * @returns {() => void} the disposer removing every anchor, the stylesheet and the observer.
		 */
		function startRowLinks(document) {
			if (document === undefined || document === null) return () => {}
			if (typeof document.createElement !== 'function' || typeof document.querySelectorAll !== 'function') return () => {}
			const scan = () => {
				try {
					for (const row of document.querySelectorAll(ROW_SELECTOR)) enhanceRow(document, row)
				} catch {
					// A DOM that cannot be scanned is left untouched: the address-bar sync
					// is the plugin's contract, the row links are an addition to it.
				}
			}
			let style
			try {
				style = document.createElement('style')
				style.id = STYLE_ID
				style.textContent = STYLE_TEXT
				const parent = document.head ?? document.body
				if (parent !== undefined && parent !== null && typeof parent.appendChild === 'function') parent.appendChild(style)
			} catch {
				style = undefined
			}
			let observer
			try {
				const root = document.body ?? document.documentElement
				if (root !== undefined && root !== null && typeof window.MutationObserver === 'function') {
					observer = new window.MutationObserver(scan)
					observer.observe(root, { childList: true, subtree: true })
				}
			} catch {
				observer = undefined
			}
			scan()
			return () => {
				try {
					observer?.disconnect()
					style?.remove()
					for (const row of document.querySelectorAll(ROW_SELECTOR)) {
						row.querySelector(`[data-dsh-part="${ANCHOR_PART}"]`)?.remove()
						if (typeof row.getAttribute === 'function' && row.getAttribute(HOST_ATTRIBUTE) === '1') {
							row.removeAttribute(HOST_ATTRIBUTE)
							if (row.style !== undefined) row.style.position = ''
						}
					}
				} catch {
					// Disposal is best effort; nothing here may break the shell.
				}
			}
		}

		/**
		 * Register the fragment sync and the row links on the running GUI.
		 * @param {object} ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => {
				if (typeof window === 'undefined') return () => {}
				const faces = probeFaces(ctx)
				if (faces === null) {
					console.warn(`${TAG} disabled: the sessions/workspaces/uiWorkspace service shape changed`)
					return () => {}
				}
				const stopSync = startSessionUrlSync(browserHost(faces))
				const stopRowLinks = startRowLinks(window.document)
				return () => {
					stopSync()
					stopRowLinks()
				}
			}, 'session-url: fragment sync and row links')
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
