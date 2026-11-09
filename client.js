/**
 * Swarm Rebuild — Client half (default-on, BUILT-IN sidebar browser tab edition).
 *
 * GOAL: every AI development session automatically shows the developing page
 * (with the Swarm Rebuild cursor animation) in the Harness's OWN right-sidebar
 * "Browser" tab. Default-on: no user action, no reliance on an agent "started"
 * event. NO floating/self-rendered overlay — the display is a real, docked tab.
 *
 * WHY THE TAB FAILED BEFORE (and how this fixes it). The built-in browser tab
 * guards what it will load:
 *   - parseBrowserAddress refuses url.origin === applicationOrigin (the GUI's
 *     own origin), so a GUI-origin preview URL is rejected in the web GUI;
 *   - on the desktop the tab is a <webview> whose dedicated session installs
 *     webRequest.onBeforeRequest / will-frame-navigate / will-redirect guards
 *     that CANCEL every loopback host on the GUI's own PORT (isApplicationHost);
 *   - the desktop app runs under a dsh-app:// custom scheme, so
 *     window.location.origin === "null" and ANY origin-built absolute URL is
 *     wrong — the old endpoint fetch never even resolved, so the tab fell back
 *     to a GUI-origin URL that the webview promptly blocked.
 * The Host therefore serves the SAME in-memory preview from a SECOND loopback
 * server on a DIFFERENT port (see /__endpoint in index.js). A different port
 * makes url.port !== app.port, so BOTH guards allow it, in BOTH environments.
 *
 * THE FIX (all environment-independent):
 *   1. Fetch /__dsh_swarm_rebuild__/__endpoint with a ROOT-RELATIVE URL. Web
 *      GUI: same-origin fetch. Desktop: dsh-app://app/... -> protocol.handle
 *      forwardWebRequest() -> real Host WITH auth. No window.location.origin
 *      dependency, so it works under the custom scheme too. It returns {port}.
 *   2. Build http://127.0.0.1:<port>/__dsh_swarm_rebuild__/ and hand THAT to
 *      the built-in tab via sr.openTab('browser', { params: { url } }).
 *   3. Open exactly ONCE (success latch) — the `browser` tab kind is
 *      multiple:true, so every openTab mints a NEW random-UUID tab. Before the
 *      first open, best-effort CLOSE accumulated stale tabs (from earlier
 *      reinstalls / dead ports) so the tab bar is clean, not a pile of
 *      "页面加载失败" tabs. keepMounted tabs otherwise persist on desktop.
 *   4. Web-GUI-only last resort: if the endpoint never resolves, a different
 *      HOSTNAME alias on the GUI port (http://localhost:<port>/...) still
 *      changes the origin string enough to pass parseBrowserAddress while
 *      reaching the same listener. Never used under the desktop scheme.
 *
 * This half additionally registers the locally served format-1 plugin-market
 * index URL with the running PluginMarket service (best-effort, idempotent,
 * additive) so the plugin appears in Discover immediately.
 */
window.__ModuleLoader__.load({
  id: 'dsh-swarm-rebuild',
  factory() {
    const PREFIX = '/__dsh_swarm_rebuild__';

    return {
      // No declared inject: the tab must open as soon as the sidebar service is
      // reachable, and must NOT wait on any single service. All service access
      // below is lazy + defensive, with bounded retries.
      inject: [],
      apply(ctx) {
        // Only the market URL needs an absolute origin. Everything else is
        // root-relative / loopback (see header).
        let origin = '';
        try { origin = window.location.origin; } catch (e) {}
        const httpOrigin = origin && origin.indexOf('http') === 0 ? origin : '';
        // The market index is fetched by the HOST process (Node `fetch`), so it
        // needs an absolute loopback URL. Under the desktop shell the GUI origin
        // is `dsh-app://...`, not http, so we cannot derive it from the origin --
        // and a hardcoded fallback goes stale the moment the web server picks a
        // different port. Resolve it from /__endpoint instead (the same listener
        // serves the index), and re-register once that resolves.
        let marketUrl = httpOrigin ? httpOrigin + PREFIX + '/market/index.json' : '';

        let disposed = false;
        let endpointReady = false;
        let endpointAttempts = 0;
        let endpointTimer = 0;
        let tabUrl = '';
        let opened = false;
        let cleaned = false;
        let revealTimer = 0;
        let revealAttempts = 0;
        let subscribeTimer = 0, marketTimer = 0;
        let subscribeAttempts = 0, marketAttempts = 0, marketDone = false;
        let marketRemote = null;

        // ---- resolve the sidebar-safe (alternate-port) preview URL ----------
        function fetchEndpoint() {
          if (disposed || endpointReady) return;
          try {
            window.fetch(PREFIX + '/__endpoint', { cache: 'no-store' })
              .then((r) => (r && typeof r.json === 'function' ? r.json() : null))
              .then((j) => {
                if (disposed || endpointReady) return;
                const p = j && Number(j.port);
                if (p && p > 0 && p < 65536) {
                  endpointReady = true;
                  tabUrl = 'http://127.0.0.1:' + p + PREFIX + '/';
                  marketUrl = 'http://127.0.0.1:' + p + PREFIX + '/market/index.json';
                  kick();
                  if (marketRemote) registerMarket(marketRemote);
                } else retryEndpoint();
              })
              .catch(() => { retryEndpoint(); });
          } catch (e) { retryEndpoint(); }
        }
        function retryEndpoint() {
          if (disposed || endpointReady) return;
          if (endpointAttempts++ < 60) {
            try { endpointTimer = window.setTimeout(fetchEndpoint, 250); } catch (e) {}
            return;
          }
          // Web-GUI-only last resort: a loopback hostname ALIAS changes the
          // origin string so parseBrowserAddress allows it (the desktop
          // scheme's isApplicationHost would still cancel it, so we require a
          // real http origin here). The endpoint is served by the same listener
          // as the GUI, so this is almost never needed.
          if (httpOrigin) {
            let u;
            try { u = new URL(httpOrigin); } catch (e) {}
            if (u) {
              endpointReady = true;
              tabUrl = 'http://localhost:' + (u.port || '80') + PREFIX + '/';
              kick();
            }
          }
        }
        fetchEndpoint();

        // ---- stale-tab cleanup (best-effort) --------------------------------
        // `browser` is multiple:true + (desktop) keepMounted:true, so tabs from
        // earlier reinstalls / now-dead alternate ports pile up and keep showing
        // "页面加载失败". A browser tab with a random-UUID contentId is one our
        // plugin minted (users normally navigate in place). If >=2 exist they
        // are ours: close them all, then open ONE clean, working tab. Never
        // touch a tab whose contentId is the plain `sidebar://browser` address.
        function cleanupStaleTabs(sr) {
          if (cleaned) return;
          cleaned = true;
          try {
            const inv = (sr.openTabs && typeof sr.openTabs.getSnapshot === 'function')
              ? sr.openTabs.getSnapshot() : null;
            if (!Array.isArray(inv) || typeof sr.closeIn !== 'function') return;
            const mine = inv.filter((t) => t && t.kind === 'browser' &&
              typeof t.contentId === 'string' && t.contentId.indexOf('sidebar://browser/') === 0);
            if (mine.length < 2) return; // 0-1: don't touch a possibly-user tab
            for (const t of mine) {
              try { sr.closeIn(t.sessionId, t.tabId); } catch (e) {}
            }
          } catch (e) {}
        }

        // ---- open the BUILT-IN right-sidebar browser tab --------------------
        function reveal() {
          if (disposed || opened || !endpointReady || !tabUrl) return;
          let sr = null, tabs = null, browserReady = true;
          try { sr = ctx.get('sidebarRight') || ctx.sidebarRight; } catch (e) {}
          try { tabs = ctx.get('sidebarRightTabs') || ctx.sidebarRightTabs; } catch (e) {}
          try {
            browserReady = !tabs || typeof tabs.get !== 'function' ||
              tabs.get('browser') !== undefined;
          } catch (e) { browserReady = true; }
          if (!sr || typeof sr.openTab !== 'function' || !browserReady) {
            if (revealAttempts++ < 60) {
              try { revealTimer = window.setTimeout(reveal, 250); } catch (e) {}
            }
            return;
          }
          try { cleanupStaleTabs(sr); } catch (e) {}
          try {
            // planOpenIn() expands/opens the right sidebar automatically. The
            // title lets us recognize our own tab for stale cleanup (see below).
            sr.openTab('browser', { params: { url: tabUrl }, revealIfOpened: false });
            opened = true;
          } catch (e) {
            // The browser tab type may not be registered yet — retry.
            if (revealAttempts++ < 60) {
              try { revealTimer = window.setTimeout(reveal, 250); } catch (e2) {}
            }
          }
        }
        function kick() {
          if (disposed || opened || !endpointReady) return;
          try { if (revealTimer) window.clearTimeout(revealTimer); } catch (e) {}
          revealAttempts = 0;
          reveal();
        }

        // ---- market index registration -------------------------------------
        function subscribe() {
          if (disposed) return;
          let remote = null;
          try { remote = ctx.get('remote') || ctx.remote; } catch (e) {}
          if (!remote || !remote.pluginMarket) {
            if (subscribeAttempts++ < 60) {
              try { subscribeTimer = window.setTimeout(subscribe, 400); } catch (e) {}
            }
            return;
          }
          registerMarket(remote);
        }

        // `setIndexes` persists via Settings and emits plugin-market/changed, so
        // Discover picks it up without a profile reload. Additive (existing
        // list + our URL) and idempotent (skip if already present). Unknown
        // remote shapes => skip, never risk overwriting configured indexes.
        async function registerMarket(remote) {
          if (disposed || marketDone) return;
          marketRemote = remote;
          // The URL comes from /__endpoint; without it we would have to hardcode
          // a port that goes stale on the next restart. Wait for the resolution
          // (fetchEndpoint() calls back here once it succeeds).
          if (!marketUrl) return;
          const pm = remote.pluginMarket;
          if (!pm || typeof pm.listIndexes !== 'function' ||
              typeof pm.setIndexes !== 'function') { retryMarket(remote); return; }
          try {
            const r = await pm.listIndexes();
            const list = Array.isArray(r) ? r
              : (r && Array.isArray(r.indexes) ? r.indexes : null);
            if (!list) return; // unknown shape -> leave config alone
            const urls = list.map((x) => (x && typeof x.url === 'string' ? x.url : ''))
              .filter(Boolean);
            if (!urls.length) return; // empty/uncertain -> leave config alone
            marketDone = true;
            // Drop stale swarm-rebuild market URLs from earlier sessions /
            // earlier web-server ports, then ensure the CURRENT one is present.
            const LOCAL = PREFIX + '/market/index.json';
            const cleanedUrls = urls.filter((u) => u.indexOf(LOCAL) === -1);
            const present = urls.some((u) => u === marketUrl ||
              u.replace(/\/$/, '') === marketUrl.replace(/\/$/, ''));
            if (!present || cleanedUrls.length !== urls.length) {
              await pm.setIndexes(cleanedUrls.concat(marketUrl));
            }
          } catch (e) {
            marketDone = false;
            retryMarket(remote);
          }
        }
        function retryMarket(remote) {
          if (disposed || marketDone) return;
          if (marketAttempts++ < 20) {
            try { marketTimer = window.setTimeout(() => registerMarket(remote), 800); } catch (e) {}
          }
        }
        subscribe();

        // ---- cleanup --------------------------------------------------------
        try {
          ctx.effect(() => () => {
            disposed = true;
            for (const t of [endpointTimer, revealTimer, subscribeTimer, marketTimer]) {
              try { if (t) window.clearTimeout(t); } catch (e) {}
            }
          }, 'swarm-rebuild: default-on built-in preview tab + market registration');
        } catch (e) {}
      },
    };
  },
});
