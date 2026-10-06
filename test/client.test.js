/**
 * Behaviour tests for the shipped browser artifact.
 *
 * The bundle under test is the real `lib/client.js`: it is evaluated once per
 * case in an isolated `node:vm` context with a fake module loader, a fake
 * `window`, and a manual clock. Nothing is duplicated from the artifact and no
 * module is mocked — the state machine is driven through the same injected faces
 * it uses in the browser.
 *
 * Two catalog notions are kept apart, as the real `SessionListState` does:
 * `list(id)` marks a conversation as listed (`byId[id]`, no retain info) while
 * `view(id)` in addition marks it as the one the main view shows
 * (`retainedBy.mainView`).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const BUNDLE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const BUNDLE_SOURCE = readFileSync(BUNDLE_PATH, 'utf8')
const START = 1_000_000

/** Split a URL into the location fields the plugin reads. */
function splitUrl(url) {
  const match = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url)
  return { pathname: match[1], search: match[2] ?? '', hash: match[3] ?? '' }
}

/**
 * Build the browser environment: one fake window, a catalog the test drives, and
 * a manual clock. Every returned `api` call notifies the plugin exactly like the
 * official services do.
 */
function environment(options = {}) {
  const location = {
    pathname: options.pathname ?? '/',
    search: options.search ?? '',
    hash: options.hash ?? '',
  }
  const listeners = new Map()
  const timers = new Map()
  const writes = []
  const warnings = []
  const opened = []
  const subscribers = new Set()
  const rows = {}
  const archivedSessionIds = []
  let phase = options.phase ?? 'ready'
  let clock = START
  let sequence = 0
  let captured

  const notify = () => {
    for (const handler of [...subscribers]) handler()
  }
  const api = {
    /** Mark conversations as listed, without changing which one is shown. */
    list(...ids) {
      for (const id of ids) if (rows[id] === undefined) rows[id] = { id }
      notify()
    },
    /** Land a selection in the catalog, exactly as the view owner would. */
    view(id) {
      for (const row of Object.values(rows)) delete row.retainedBy
      rows[id] = { ...(rows[id] ?? {}), id, retainedBy: { mainView: 1 } }
      notify()
    },
    setPhase(value) {
      phase = value
      notify()
    },
    archive(id) {
      archivedSessionIds.push(id)
    },
    /** Move the manual clock forward, firing every timer that comes due. */
    advance(ms) {
      clock += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) {
          timers.delete(id)
          timer.handler()
        }
      }
    },
    /** Fire a browser hashchange (a user edit, Back/Forward, or a pasted link). */
    navigate(url) {
      Object.assign(location, splitUrl(url))
      for (const handler of [...(listeners.get('hashchange') ?? [])]) handler()
    },
  }
  const window = {
    location,
    history: {
      replaceState(_state, _title, url) {
        writes.push(url)
        Object.assign(location, splitUrl(url))
      },
    },
    addEventListener(type, handler) {
      const set = listeners.get(type) ?? new Set()
      set.add(handler)
      listeners.set(type, set)
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler)
    },
    setTimeout(handler, delayMs) {
      const id = ++sequence
      timers.set(id, { handler, at: clock + delayMs })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    __ModuleLoader__: {
      load(spec) {
        captured = spec
      },
    },
  }

  const context = vm.createContext({
    window,
    console: { warn: message => warnings.push(String(message)) },
    Date: { now: () => clock },
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
  })
  vm.runInContext(BUNDLE_SOURCE, context, { filename: 'lib/client.js' })
  assert.ok(captured !== undefined, 'the bundle must register itself with the module loader')
  assert.equal(captured.id, 'dsh-session-url')
  const moduleExports = captured.factory()

  const sessions = {
    list: {
      getSnapshot: () => ({ phase, ids: Object.keys(rows), byId: rows }),
      subscribe(handler) {
        subscribers.add(handler)
        return () => subscribers.delete(handler)
      },
    },
  }
  const workspaces = { list: { getSnapshot: () => ({ archivedSessionIds }) } }
  const disposers = []
  const uiWorkspace = {
    openSession(id) {
      assert.equal(typeof id, 'string')
      opened.push(id)
      api.view(id)
    },
  }
  const ctx = {
    effect(fn) {
      disposers.push(fn())
    },
    ...(options.services ?? { sessions, workspaces, uiWorkspace }),
  }
  return { moduleExports, ctx, api, window, location, writes, warnings, opened, listeners, disposers }
}

/** Apply the plugin and return the environment. */
const open = env => {
  env.moduleExports.apply(env.ctx)
  return env
}

test('the browser module advertises the three faces its sync needs', () => {
  // Given the shipped bundle
  const env = environment()
  // When its exports are inspected
  // Then apply and the injected service names are the documented ones
  assert.equal(typeof env.moduleExports.apply, 'function')
  // The array comes from the vm realm, so compare its values rather than its prototype.
  assert.equal([...env.moduleExports.inject].join(','), 'sessions,workspaces,uiWorkspace')
})

test('a canonical link opens the listed conversation it names', () => {
  // Given a page load carrying `#/session/<id>` for a listed conversation
  const env = environment({ hash: '#/session/session-abc' })
  env.api.list('session-abc')
  // When the plugin applies
  open(env)
  // Then that conversation is opened once and the fragment stays canonical
  assert.deepEqual(env.opened, ['session-abc'])
  assert.equal(env.location.hash, '#/session/session-abc')
})

test('a retyped link still opens: plural segment and encoded id are accepted', () => {
  // Given a link a human may have retyped: plural, encoded, trailing slash
  const env = environment({ hash: '#/sessions/session%2Fabc/' })
  env.api.list('session/abc')
  // When the plugin applies
  open(env)
  // Then the decoded conversation opens
  assert.deepEqual(env.opened, ['session/abc'])
})

test('without a link the address bar follows the view, path and query preserved', () => {
  // Given a load under a mount path with a launch token, no fragment, one session shown
  const env = environment({ pathname: '/gui/', search: '?token=xyz' })
  env.api.list('session-view')
  env.api.view('session-view')
  // When the plugin applies
  open(env)
  // Then the fragment names the shown conversation and nothing else changed
  assert.deepEqual(env.writes, ['/gui/?token=xyz#/session/session-view'])
  assert.equal(env.location.pathname, '/gui/')
  assert.equal(env.location.search, '?token=xyz')
})

test('with no link, selecting another conversation rewrites the fragment', () => {
  // Given a running plugin with one conversation shown and no link in the address bar
  const env = environment()
  env.api.list('first', 'second')
  env.api.view('first')
  open(env)
  assert.equal(env.location.hash, '#/session/first')
  // When the selection moves
  env.api.view('second')
  // Then the address bar follows it and nothing was opened
  assert.equal(env.location.hash, '#/session/second')
  assert.deepEqual(env.opened, [])
})

test('an archived link is refused at once and the bar returns to the view', () => {
  // Given a page load linking an archived conversation while another is shown
  const env = environment({ hash: '#/session/gone' })
  env.api.list('gone', 'current')
  env.api.view('current')
  env.api.archive('gone')
  // When the plugin applies
  open(env)
  // Then nothing is opened, exactly one diagnostic is emitted, and the bar reflects the view
  assert.deepEqual(env.opened, [])
  assert.equal(env.warnings.length, 1)
  assert.match(env.warnings[0], /archived/)
  assert.equal(env.location.hash, '#/session/current')
})

test('a listed link arrives late and still opens within the window', () => {
  // Given a load linking a conversation the catalog has not listed yet
  const env = environment({ hash: '#/session/late' })
  env.api.list('current')
  env.api.view('current')
  // When the plugin applies before that conversation is listed
  open(env)
  assert.deepEqual(env.opened, [])
  assert.equal(env.location.hash, '#/session/late')
  // And the catalog lists it within the window
  env.api.list('late')
  // Then the link is honoured
  assert.deepEqual(env.opened, ['late'])
  assert.equal(env.location.hash, '#/session/late')
})

test('an unlisted link is dropped only when the window expires', () => {
  // Given a load linking a conversation the catalog never lists
  const env = environment({ hash: '#/session/ghost' })
  env.api.list('current')
  env.api.view('current')
  // When the plugin applies
  open(env)
  // Then the link is still claimed: no diagnostic, the fragment is untouched
  assert.deepEqual(env.warnings, [])
  assert.equal(env.location.hash, '#/session/ghost')
  // When the window expires
  env.api.advance(7999)
  assert.deepEqual(env.warnings, [], 'the window must not expire early')
  env.api.advance(1)
  // Then it is dropped with exactly one diagnostic and the bar reflects the view
  assert.equal(env.warnings.length, 1)
  assert.match(env.warnings[0], /not in the session catalog/)
  assert.equal(env.location.hash, '#/session/current')
})

test('a link stays authoritative while the view owner restores its own selection', () => {
  // Given a load linking one conversation while another one is shown
  const env = environment({ hash: '#/session/linked' })
  env.api.list('linked', 'restored')
  env.api.view('restored')
  // When the plugin applies
  open(env)
  // Then the link wins over the restore
  assert.deepEqual(env.opened, ['linked'])
  // And when the restore lands after the open, the window re-opens the link once
  env.api.view('restored')
  assert.deepEqual(env.opened, ['linked', 'linked'])
  assert.deepEqual(env.warnings, [])
})

test('after the window the view owns the address bar again', () => {
  // Given a running plugin whose link never opened
  const env = environment({ hash: '#/session/ghost' })
  env.api.list('current')
  env.api.view('current')
  open(env)
  // When the window expires
  env.api.advance(8000)
  // Then a later selection is not fought over
  env.api.view('current')
  assert.equal(env.location.hash, '#/session/current')
  assert.equal(env.warnings.length, 1)
})

test('a conversation already shown is not re-opened by its own notification', () => {
  // Given a load whose link is already the shown conversation
  const env = environment({ hash: '#/session/only' })
  env.api.list('only')
  env.api.view('only')
  // When the plugin applies
  open(env)
  // Then the re-entrant catalog notification opens nothing
  assert.deepEqual(env.opened, [])
  assert.equal(env.location.hash, '#/session/only')
})

test('the catalog is not consulted before it is ready', () => {
  // Given a catalog that has not loaded yet
  const env = environment({ hash: '#/session/late', phase: 'loading' })
  // When the plugin applies
  open(env)
  // Then it neither opens nor writes
  assert.deepEqual(env.opened, [])
  assert.deepEqual(env.writes, [])
  // And once the catalog is ready the link opens
  env.api.list('late')
  env.api.setPhase('ready')
  assert.deepEqual(env.opened, ['late'])
})

test('a changed service shape disables the plugin with one diagnostic', () => {
  // Given a client whose navigation face lost its opener
  const env = environment({
    services: {
      sessions: {
        list: {
          getSnapshot: () => ({ phase: 'ready', ids: [], byId: {} }),
          subscribe: () => () => {},
        },
      },
      workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: [] }) } },
      uiWorkspace: {},
    },
  })
  // When the plugin applies
  open(env)
  // Then it reports once, registers nothing, and leaves the shell intact
  assert.equal(env.warnings.length, 1)
  assert.match(env.warnings[0], /service shape changed/)
  assert.equal(env.listeners.size, 0)
  assert.deepEqual(env.writes, [])
})

test('disposal removes every listener and timer', () => {
  // Given a running plugin with a link in flight
  const env = environment({ hash: '#/session/linked' })
  env.api.list('current')
  env.api.view('current')
  open(env)
  assert.equal(env.listeners.get('hashchange')?.size, 1)
  // When the effect is disposed
  for (const dispose of env.disposers) dispose()
  // Then no listener remains and the expired timer cannot act any more
  assert.equal(env.listeners.get('hashchange')?.size ?? 0, 0)
  env.api.navigate('#/session/other')
  env.api.advance(9000)
  assert.deepEqual(env.opened, [])
  assert.deepEqual(env.writes, [])
})

// ---------------------------------------------------------------------------
// row links: sidebar conversation rows become real anchors
// ---------------------------------------------------------------------------

/** Minimal DOM: attributes, children, listeners and the two selectors the plugin uses. */
function fakeDom(initialKeys) {
  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase()
      this.attributes = new Map()
      this.children = []
      this.parentElement = null
      this.style = {}
      this.listeners = new Map()
      this.className = ''
      this.id = ''
      this.textContent = ''
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)) }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
    removeAttribute(name) { this.attributes.delete(name) }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child }
    remove() {
      if (this.parentElement !== null) {
        this.parentElement.children = this.parentElement.children.filter(c => c !== this)
        this.parentElement = null
      }
    }
    addEventListener(type, handler) {
      const set = this.listeners.get(type) ?? new Set()
      set.add(handler)
      this.listeners.set(type, set)
    }
    fire(type, event) { for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event) }
    matches(selector) {
      const rowKey = /^\[data-row-key\^="([^"]+)"\]$/.exec(selector)
      if (rowKey !== null) {
        const value = this.getAttribute('data-row-key')
        return value !== null && value.startsWith(rowKey[1])
      }
      const part = /^\[data-dsh-part="([^"]+)"\]$/.exec(selector)
      if (part !== null) return this.getAttribute('data-dsh-part') === part[1]
      return false
    }
    descendants() {
      const out = []
      for (const child of this.children) out.push(child, ...child.descendants())
      return out
    }
    querySelector(selector) { return this.descendants().find(node => node.matches(selector)) ?? null }
  }
  const body = new Node('body')
  const head = new Node('head')
  const rows = initialKeys.map(key => {
    const row = new Node('div')
    row.setAttribute('data-row-key', key)
    body.appendChild(row)
    return row
  })
  const document = {
    body,
    head,
    documentElement: body,
    createElement: tag => new Node(tag),
    createElementNS: (_namespace, tag) => new Node(tag),
    querySelectorAll: selector => body.descendants().filter(node => node.matches(selector)),
  }
  const observers = []
  class FakeObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this) }
    observe() {}
    disconnect() { this.disconnected = true }
    trigger() { if (!this.disconnected) this.callback([]) }
  }
  return { document, body, head, rows, observers, FakeObserver }
}

/** Apply the plugin against a page that has a sidebar list. */
function openWithDom(keys, options = {}) {
  const dom = fakeDom(keys)
  const env = environment(options)
  env.window.document = dom.document
  env.window.getComputedStyle = () => ({ position: 'static' })
  env.window.MutationObserver = dom.FakeObserver
  open(env)
  return { env, dom }
}

test('a conversation row becomes a real link, and only conversation rows do', () => {
  // Given a sidebar listing two conversations and one workspace row
  const { dom } = openWithDom(['session:session-abc', 'session:session-def', 'workspace:Default Project'])
  const [first, second, other] = dom.rows
  // When the plugin applies
  const anchor = first.querySelector('[data-dsh-part="session-link"]')
  // Then each conversation row carries a real anchor that opens a new tab
  assert.ok(anchor !== null, 'a conversation row must carry the plugin anchor')
  assert.equal(anchor.getAttribute('href'), '#/session/session-abc')
  assert.equal(anchor.getAttribute('target'), '_blank')
  assert.equal(anchor.getAttribute('rel'), 'noreferrer')
  assert.equal(anchor.getAttribute('data-dsh-plugin'), 'dsh-session-url')
  assert.match(anchor.getAttribute('title') ?? '', /复制链接|copy the link/)
  assert.equal(second.querySelector('[data-dsh-part="session-link"]').getAttribute('href'), '#/session/session-def')
  // And the workspace row is untouched, while the row gained a positioning context
  assert.equal(other.querySelector('[data-dsh-part="session-link"]'), null)
  assert.equal(first.getAttribute('data-dsh-session-url-host'), '1')
  assert.equal(first.style.position, 'relative')
  // And exactly one stylesheet was injected
  assert.equal(dom.head.children.filter(node => node.id === 'dsh-session-url-style').length, 1)
})

test('the link never lets the row see the pointer', () => {
  // Given a linked row
  const { dom } = openWithDom(['session:session-abc'])
  const anchor = dom.rows[0].querySelector('[data-dsh-part="session-link"]')
  // When the pointer events a row reacts to are fired at the anchor
  let stopped = 0
  const event = { stopPropagation: () => { stopped += 1 } }
  anchor.fire('click', event)
  anchor.fire('pointerdown', event)
  anchor.fire('mousedown', event)
  // Then every one of them was stopped, so the row cannot also navigate the current tab
  assert.equal(stopped, 3)
})

test('a row that appears later, as the virtualized list grows, is linked too', () => {
  // Given a linked list
  const { dom } = openWithDom(['session:session-abc'])
  assert.equal(dom.observers.length, 1)
  // When the list later renders another conversation row
  const late = dom.document.createElement('div')
  late.setAttribute('data-row-key', 'session:session-late')
  dom.body.appendChild(late)
  dom.observers[0].trigger()
  // Then that row is linked as well
  assert.equal(late.querySelector('[data-dsh-part="session-link"]').getAttribute('href'), '#/session/session-late')
})

test('disposal removes the anchors, the stylesheet and the row tweak', () => {
  // Given a linked list
  const { env, dom } = openWithDom(['session:session-abc'])
  // When the plugin is disposed
  for (const dispose of env.disposers) dispose()
  // Then nothing of the plugin is left in the page
  assert.equal(dom.rows[0].querySelector('[data-dsh-part="session-link"]'), null)
  assert.equal(dom.rows[0].getAttribute('data-dsh-session-url-host'), null)
  assert.equal(dom.rows[0].style.position, '')
  assert.equal(dom.head.children.some(node => node.id === 'dsh-session-url-style'), false)
  assert.equal(dom.observers[0].disconnected, true)
})

test('a shell without a sidebar DOM keeps the fragment sync working', () => {
  // Given the usual environment, which has no document at all
  const env = environment({ hash: '#/session/session-abc' })
  env.api.list('session-abc')
  // When the plugin applies
  // Then it neither throws nor stops syncing the address bar
  assert.doesNotThrow(() => open(env))
  assert.deepEqual(env.opened, ['session-abc'])
})
