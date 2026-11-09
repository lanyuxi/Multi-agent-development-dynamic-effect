/**
 * Swarm Rebuild — Host half (one-shot edition).
 *
 * Serves the workspace's developing HTML page from an in-memory preview route
 * that injects the cursor runtime + a tiny head "boot hide" into the HTML
 * *response*. Nothing is ever written to disk, so the AI's own file-version
 * observations are never disturbed (no FS_STALE_VERSION on its next
 * str_replace) and the source file stays clean.
 *
 * The runtime plays a ONE-SHOT drawing animation and then removes itself. It
 * re-triggers whenever the page changes: this Host half exposes /__version as a
 * fingerprint of ALL web assets (html/css/js/images/fonts/media), so a modify /
 * add / delete by the AI changes it and the in-page runtime reloads -> a fresh
 * one-shot. The boot hide keeps the page from flashing fully-built content
 * before that one-shot starts (with a failsafe timeout in case JS is blocked).
 *
 * Routes (all under the /__dsh_swarm_rebuild__ prefix):
 *   GET /__dsh_swarm_rebuild__/              -> 302 to the current developing page
 *   GET /__dsh_swarm_rebuild__/<file.html>   -> that HTML with runtime injected
 *   GET /__dsh_swarm_rebuild__/<asset>       -> raw workspace asset (css/js/img/...)
 *   GET /__dsh_swarm_rebuild__/__runtime.js  -> the cursor runtime (runtime.js)
 *   GET /__dsh_swarm_rebuild__/__version    -> { v } fingerprint for auto-reload
 *   GET /__dsh_swarm_rebuild__/__endpoint   -> { port } of the alternate-port preview
 *   GET /__dsh_swarm_rebuild__/market/index.json -> format-1 plugin-market index
 *                                                (publishes this plugin into the
 *                                                Harness Discover/plugin market)
 *
 * Because both the Harness right-sidebar browser tab and any external browser
 * open the SAME served URL, the cursors appear in both places. The sidebar tab
 * is opened automatically by the Client half; it must use the alternate-port
 * server because the built-in browser refuses the GUI's own origin AND every
 * loopback host on the GUI's port (see __endpoint below). External browsers use
 * the ordinary GUI-origin URL.
 *
 * Root discovery: the plugin is installed as a symlink from the profile's
 * node_modules into the workspace. import.meta.url resolves (realpath) to
 * <workspace>/swarm-rebuild-plugin/index.js, so its grandparent IS the real
 * workspace root — NOT process.cwd() (which is the profile dir). We also watch
 * fs/observed to pin the exact HTML file the AI is currently writing/editing.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = '/__dsh_swarm_rebuild__';
// Fallback GUI port only used when ctx.webServer.port is unavailable (e.g. some
// desktop custom-scheme builds). The real port is read from ctx.webServer.port.
const GUI_PORT = 50993;

export const inject = ['webServer'];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
};

const SKIP = new Set([
  'node_modules', '.git', '.cache', '.next', 'coverage', '.turbo',
  '.DS_Store', 'vendor', 'bower_components', 'swarm-rebuild-plugin',
]);

// Web assets whose mtime/ctime/size are folded into the version fingerprint,
// so ANY page edit (html, css, js, image, font, media) re-triggers the effect.
const WATCH_RE = /\.(html?|css|js|mjs|cjs|jsx|ts|tsx|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg)$/i;

// Lightweight check used only during root discovery: does this directory hold
// any HTML page? Bounded + SKIP-aware so we never accidentally pick a profile
// dir whose node_modules happens to contain docs .html files.
function dirHasHtml(dir) {
  let found = false, visited = 0;
  const walk = (d, depth) => {
    if (depth > 4 || visited > 800 || found) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (visited++ > 800 || found) return;
      if (SKIP.has(e.name)) continue;
      const full = path.join(d, e.name);
      let isDir = false, isFile = false;
      try { isDir = e.isDirectory(); isFile = e.isFile(); } catch (er) {}
      if (isDir) { walk(full, depth + 1); continue; }
      if (isFile && /\.(html|htm)$/i.test(e.name)) { found = true; return; }
    }
  };
  walk(dir, 0);
  return found;
}

// Layered root discovery. PRIMARY = grandparent of the symlink-resolved
// import.meta.url (the real workspace root). Fallbacks are belt-and-suspenders
// for other deployment layouts. process.cwd() is the profile dir here, so it
// is deliberately ranked LAST.
function discoverRoot(ctx) {
  const candidates = [];
  // Explicit override: the reliable escape hatch for a MARKET install, where
  // the package is a REAL COPY inside node_modules rather than a symlink into
  // the project (see the node_modules guard below). Set this to the project
  // root whose HTML pages should be previewed.
  if (process.env.SWARM_REBUILD_ROOT) candidates.push(process.env.SWARM_REBUILD_ROOT);
  try {
    const here = fs.realpathSync(fileURLToPath(import.meta.url));
    const grandparent = path.dirname(path.dirname(here)); // <workspace> for a symlink install
    // A market install resolves to profile/node_modules/<pkg>/index.js, whose
    // grandparent is node_modules itself — NEVER a project root. Skip it so
    // the chain falls through to the real working directory below.
    if (path.basename(grandparent) !== 'node_modules') candidates.push(grandparent);
    candidates.push(path.dirname(here));               // <workspace>/swarm-rebuild-plugin
  } catch (e) {}
  try {
    const wd = ctx && ctx.get && ctx.get('workingDirectory');
    if (wd && typeof wd.defaultDirectory === 'string') candidates.push(wd.defaultDirectory);
  } catch (e) {}
  try {
    const f = ctx && ctx.get && ctx.get('fs');
    if (f && f.config && typeof f.config.cwd === 'string') candidates.push(f.config.cwd);
  } catch (e) {}
  candidates.push(process.cwd());
  for (const k of ['PWD', 'INIT_CWD']) if (process.env[k]) candidates.push(process.env[k]);

  let firstDir = null;
  for (const c of candidates) {
    let real;
    try { real = fs.realpathSync(c); } catch (e) { continue; }
    let st;
    try { st = fs.statSync(real); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    if (!firstDir) firstDir = real;
    if (dirHasHtml(real)) return real; // first existing dir that actually holds pages
  }
  return firstDir || (() => { try { return fs.realpathSync(process.cwd()); } catch (e) { return process.cwd(); } })();
}

export function apply(ctx) {
  // `let`, not `const`: a MARKET install is a real copy in node_modules, so the
  // initial root is only a fallback (often the profile dir, with no pages). We
  // adopt the real project root lazily from the AI's first observed HTML write.
  let root = discoverRoot(ctx);
  let rootUsable = dirHasHtml(root);
  const runtime = loadRuntime(root);
  const pkg = loadPackageMeta(root);
  const market = marketIndex(pkg, loadIconData(root), loadLocaleText(root));

  // The AI's exact developing page. fs/observed is an EMIT-mode event whose
  // listeners must be synchronous, trivial recorders that NEVER throw (throws
  // would fail the AI's tool call). We only record HTML writes under the root.
  let pinned = null; // { rel, ts }
  // Alternate-port preview: the sidebar browser refuses the GUI's own origin
  // (and every loopback host on the GUI's port), so we also serve the very same
  // in-memory preview from a second loopback server on an OS-assigned port.
  let previewPort = 0;
  let previewServer = null;
  const onObserved = (target, observation) => {
    try {
      if (!observation || observation.kind !== 'present') return;
      const dp = target && target.displayPath;
      if (typeof dp !== 'string' || !/\.html?$/i.test(dp)) return;
      const abs = path.isAbsolute(dp) ? path.normalize(dp) : path.resolve(root, dp);
      // MARKET INSTALL PORTABILITY: the AI writes are usually OUTSIDE our
      // initial root (a copied market bundle sits in profile/node_modules, not
      // in the user's project). Adopt the project root from the first HTML
      // write: walk up to the nearest ancestor that actually holds HTML pages.
      // `fs/observed` listeners MUST stay synchronous and trivial — this is a
      // handful of stat/readdir calls, no tool-call failure risk.
      if (!rootUsable) {
        try {
          let cur = path.dirname(abs);
          for (let i = 0; i < 6 && cur && cur !== path.dirname(cur); i++) {
            if (dirHasHtml(cur)) {
              root = fs.realpathSync(cur);
              rootUsable = true;
              pinned = null;
              break;
            }
            cur = path.dirname(cur);
          }
        } catch (e) {}
      }
      // root is realpath-resolved; displayPath may carry symlink components
      // (e.g. /var -> /private/var on macOS, or a symlinked workspace). Resolve
      // both sides to the same physical spelling before the containment check,
      // otherwise a perfectly valid AI write would never be pinned.
      let phys = abs;
      try { phys = fs.realpathSync(abs); } catch (e) { phys = abs; }
      if (phys !== root && !phys.startsWith(root + path.sep)) return;
      const rel = path.relative(root, phys).split(path.sep).join('/');
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
      pinned = { rel, ts: Date.now() };
    } catch (e) {}
  };

  // Resolve a request-relative path to an absolute path, refusing traversal.
  function relToAbs(rel) {
    const cleaned = String(rel).replace(/\\/g, '/');
    const abs = path.resolve(root, cleaned);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    return abs;
  }

  // A redirect target is only honored if the file still exists and is under
  // root (a deleted page must fall through to pinned/active instead of 404).
  function validTarget(rel) {
    if (!rel || typeof rel !== 'string') return null;
    const abs = relToAbs(rel);
    if (!abs) return null;
    try { if (!fs.statSync(abs).isFile()) return null; } catch (e) { return null; }
    return rel;
  }

  // One bounded walk collecting every watched web asset + its mtime/ctime/size.
  // Used both for the "most-recent HTML" redirect and for the version hash.
  function scanAll() {
    const out = [];
    let visited = 0;
    const walk = (dir, depth) => {
      if (depth > 6 || visited > 4000) return;
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        if (visited++ > 4000) return;
        if (SKIP.has(e.name)) continue;
        const full = path.join(dir, e.name);
        let isDir = false, isFile = false;
        try { isDir = e.isDirectory(); isFile = e.isFile(); } catch (er) {}
        if (isDir) { walk(full, depth + 1); continue; }
        if (isFile && WATCH_RE.test(e.name)) {
          try {
            const st = fs.statSync(full);
            out.push({
              rel: path.relative(root, full).split(path.sep).join('/'),
              mt: st.mtimeMs, ct: st.ctimeMs, size: st.size,
            });
          } catch (er) {}
        }
      }
    };
    walk(root, 0);
    return out;
  }

  function htmlFiles(all) {
    return all.filter((f) => /\.html?$/i.test(f.rel))
      .sort((a, b) => (b.mt - a.mt) || a.rel.localeCompare(b.rel));
  }

  // Stable fingerprint of ALL watched assets (mtimeMs/ctimeMs are sub-ms
  // floats) plus the pinned developing file. Includes the file COUNT so an
  // add/delete always changes the value, and a 32-bit hash so the payload is
  // tiny. Any modify / add / delete by the AI changes it -> runtime reloads.
  function fingerprint(all) {
    const s = all.map((f) => f.rel + ':' + f.mt + ':' + f.ct + ':' + f.size).sort().join('|');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + '.' + all.length + '#' + (pinned ? pinned.rel : '-');
  }

  function send(req, res, code, type, body, extra) {
    const headers = Object.assign(
      { 'Content-Type': type, 'Cache-Control': 'no-store' },
      extra || {},
    );
    try { res.writeHead(code, headers); } catch (e) {}
    try { res.end(req.method === 'HEAD' ? undefined : body); } catch (e) {}
  }

  // Head snippet: hide the built page until the one-shot starts, so there is no
  // flash of fully-rendered content. Failsafe removes it even if JS is blocked.
  // opacity (not visibility) is used so it is NOT inherited as computed style
  // on descendants — the runtime's target scan must still see real elements.
  function bootSnippet() {
    return '<style>html.__sr_boot body{opacity:0!important}</style>' +
      '<script>(function(){try{var d=document.documentElement;d.classList.add("__sr_boot");' +
      'window.setTimeout(function(){try{d.classList.remove("__sr_boot")}catch(e){}},2600);' +
      '}catch(e){}})();<\/script>';
  }

  // Strip CSP/base only from this in-memory PREVIEW copy so the injected
  // runtime is guaranteed to execute and root-relative URLs keep our origin.
  function injectHtml(html, rel) {
    let out = String(html);
    out = out.replace(/<meta[^>]*http-equiv\s*=\s*(["']?)content-security-policy\1[^>]*>/gi, '');
    out = out.replace(/<base\b[^>]*>/gi, '');
    // Root-relative URLs (/assets/x.css) would otherwise escape our prefix and
    // land on the GUI SPA fallback. Re-point them at the preview route. Protocol
    // relative (//cdn...) and full URLs are left untouched.
    out = out.replace(/(\b(?:src|href|action|poster)\s*=\s*["'])\/(?!\/)/gi,
      '$1' + PREFIX + '/');
    const boot = bootSnippet();
    if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, '$&' + boot);
    else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, '$&' + boot);
    else out = boot + out;
    const cfg =
      '<script>window.__SWARM_SRC__=' + JSON.stringify(rel || '__waiting__') + ';<\/script>' +
      '<script src="' + PREFIX + '/__runtime.js"><\/script>';
    if (/<\/body\s*>/i.test(out)) out = out.replace(/<\/body\s*>/i, cfg + '</body>');
    else if (/<\/html\s*>/i.test(out)) out = out.replace(/<\/html\s*>/i, cfg + '</html>');
    else out = out + cfg;
    return out;
  }

  function waitingHtml() {
    return '<!doctype html><html lang="zh"><head><meta charset="utf-8">' +
      '<title>Swarm Rebuild</title><style>html,body{height:100%;margin:0}' +
      'body{display:flex;align-items:center;justify-content:center;background:#0f1420;' +
      'color:#c9d4ea;font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'text-align:center}.b{max-width:540px;padding:32px}h2{font-weight:600;letter-spacing:.02em}' +
      '.s{opacity:.55;font-size:13px;margin-top:14px}</style></head><body><div class="b">' +
      '<h2>Swarm Rebuild · 群蜂建站</h2>' +
      '<div>正在等待 AI 生成网页… / Waiting for the AI to build a webpage…</div>' +
      '<div class="s">当 AI 写入 HTML 文件后，这里会自动刷新，出现协同搭建页面的光标群；绘制完成后光标即消失。</div>' +
      '</div><script>window.__SWARM_SRC__="__waiting__";window.__SWARM_SKIP__=true;<\/script>' +
      '<script src="' + PREFIX + '/__runtime.js"><\/script></body></html>';
  }

  const handler = (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(req, res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', { Allow: 'GET, HEAD' });
      }
      const u = new URL(req.url || '/', 'http://local');
      // The alternate-port server's root IS the preview, so its requests arrive
      // WITHOUT the prefix ("/", "/index.html", "/__version", ...). Normalize
      // them to the prefixed form so ONE handler serves both servers. Requests
      // that already carry the prefix (main webserver, or the runtime's own
      // root-relative /__dsh_swarm_rebuild__/... URLs) are left untouched.
      if (u.pathname !== PREFIX && !u.pathname.startsWith(PREFIX + '/')) {
        u.pathname = PREFIX + (u.pathname === '/' ? '/' : u.pathname);
      }
      let rel;
      try { rel = decodeURIComponent(u.pathname.slice(PREFIX.length)); }
      catch (e) { rel = u.pathname.slice(PREFIX.length); }
      rel = rel.replace(/^\/+/, '');

      if (rel === '__runtime.js') {
        return send(req, res, 200, 'application/javascript; charset=utf-8', runtime);
      }
      if (rel === '__version') {
        return send(req, res, 200, 'application/json; charset=utf-8',
          JSON.stringify({ v: fingerprint(scanAll()) }));
      }
      // Which loopback port serves the sidebar-safe (different-origin) mirror
      // of this very preview. The Client half fetches this from the GUI origin
      // and builds http://<host>:<port>/__dsh_swarm_rebuild__/ for the built-in
      // browser tab. 0 means "not listening yet" -> the client retries.
      if (rel === '__endpoint') {
        return send(req, res, 200, 'application/json; charset=utf-8',
          JSON.stringify({ port: previewPort }));
      }
      // Format-1 plugin-market index. Registering this URL as a plugin-market
      // index source makes the plugin show up in the Harness Discover/market
      // panel. It is derived from package.json + icon.svg at apply() time, so
      // it always reflects the installed version without a second source of
      // truth. No auth is applied (the market fetch has no GUI session).
      if (rel === 'market/index.json') {
        return send(req, res, 200, 'application/json; charset=utf-8', market);
      }

      const all = scanAll();
      const active = htmlFiles(all)[0] || null;
      const qFile = u.searchParams.get('file');

      // Stable entry: redirect to the current developing page's real path so
      // that relative assets (./style.css) resolve naturally under that dir.
      // Priority: explicit ?file= (only if it still exists) > fs/observed
      // pinned file (the exact HTML the AI just wrote) > most-recent HTML >
      // waiting page. Deleted files fall through instead of 404-ing.
      if (rel === '') {
        const target = validTarget(qFile) ||
          validTarget(pinned && pinned.rel) ||
          (active && active.rel);
        if (!target) return send(req, res, 200, 'text/html; charset=utf-8', waitingHtml());
        const loc = PREFIX + '/' + String(target).split('/').map(encodeURIComponent).join('/');
        try { res.writeHead(302, { Location: loc, 'Cache-Control': 'no-store' }); res.end(); } catch (e) {}
        return;
      }

      // Path-encoded page request.
      if (/\.html?$/i.test(rel)) {
        const abs = relToAbs(rel);
        if (!abs) return send(req, res, 403, 'text/plain; charset=utf-8', 'Forbidden');
        let html;
        try { html = fs.readFileSync(abs, 'utf8'); }
        catch (e) { return send(req, res, 404, 'text/plain; charset=utf-8', 'Not Found: ' + rel); }
        return send(req, res, 200, 'text/html; charset=utf-8', injectHtml(html, rel));
      }

      // Asset request.
      const abs = relToAbs(rel);
      if (!abs) return send(req, res, 403, 'text/plain; charset=utf-8', 'Forbidden');
      let buf;
      try { buf = fs.readFileSync(abs); }
      catch (e) { return send(req, res, 404, 'text/plain; charset=utf-8', 'Not Found: ' + rel); }
      const ext = path.extname(abs).toLowerCase();
      return send(req, res, 200, MIME[ext] || 'application/octet-stream', buf);
    } catch (err) {
      try { res.writeHead(500); res.end(); } catch (e) {}
    }
  };

  ctx.effect(() => {
    let disposeRoute = () => {};
    let disposeObserved = () => {};
    try {
      const r = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler });
      if (typeof r === 'function') disposeRoute = r;
    } catch (e) {}
    try {
      const r = ctx.on('fs/observed', onObserved);
      if (typeof r === 'function') disposeObserved = r;
    } catch (e) {}
    // A second, plain loopback http.Server on an OS-assigned port mirrors the
    // exact same in-memory preview. The built-in sidebar browser refuses the
    // GUI's own origin (parseBrowserAddress) AND cancels every loopback host
    // on the GUI's port (Electron isApplicationHost / onBeforeRequest). A
    // DIFFERENT port makes url.port !== app.port, so both guards allow it,
    // while an external browser can still use the ordinary GUI-origin URL.
    // Bound to 127.0.0.1 only: never exposed to the network.
    // Prefer a STABLE port derived from the GUI's own port (guiPort + 1), so a
    // browser tab left over from an earlier session still points at a LIVE
    // server after a reinstall instead of a dead OS-assigned port (a frequent
    // cause of a lingering "页面加载失败" tab). Fall back through a few
    // neighbours, then an OS-assigned port, if any candidate is taken.
    let closed = false;
    try {
      let gp = 0;
      try {
        const raw = Number(ctx.webServer && ctx.webServer.port);
        if (Number.isFinite(raw) && raw > 0 && raw < 65534) gp = raw;
      } catch (e) {}
      // guiPort + 1 is the STABLE preview port across reinstalls; if it is
      // taken we walk a few neighbours, then fall back to an OS-assigned port.
      const base = (gp > 0 ? gp : GUI_PORT) + 1;
      const candidates = [];
      for (let i = 0; i < 8; i++) candidates.push(base + i);
      candidates.push(0);
      const tryListen = (i) => {
        if (closed || i >= candidates.length) return;
        let srv;
        try { srv = http.createServer((rq, rs) => { handler(rq, rs); }); }
        catch (e) { return; }
        srv.on('error', () => {
          try { srv.close(); } catch (e) {}
          if (previewServer === srv) previewServer = null;
          tryListen(i + 1);
        });
        srv.listen(candidates[i], '127.0.0.1', () => {
          try {
            const addr = srv.address();
            if (addr && typeof addr === 'object') previewPort = addr.port;
          } catch (e) {}
        });
        previewServer = srv;
      };
      tryListen(0);
    } catch (e) { previewServer = null; }
    return () => {
      closed = true;
      try { disposeRoute(); } catch (e) {}
      try { disposeObserved(); } catch (e) {}
      previewPort = 0;
      try { if (previewServer) previewServer.close(); } catch (e) {}
      previewServer = null;
    };
  }, 'swarm-rebuild: in-memory preview routes + developing-file tracking + sidebar port');
}

function loadRuntime(root) {
  const candidates = [];
  try { candidates.push(new URL('./runtime.js', import.meta.url)); } catch (e) {}
  candidates.push(path.join(root, 'swarm-rebuild-plugin', 'runtime.js'));
  for (const c of candidates) {
    try {
      const s = fs.readFileSync(c, 'utf8');
      if (s && s.length > 100) return s;
    } catch (e) {}
  }
  return '/* swarm runtime unavailable */';
}

// Read our own package.json so the market index always advertises exactly the
// name + version that PluginMarket.installationOf() compares against the
// installed bundle. (If they differ, the market would show "not installed".)
function loadPackageMeta(root) {
  const candidates = [];
  try { candidates.push(new URL('./package.json', import.meta.url)); } catch (e) {}
  candidates.push(path.join(root, 'swarm-rebuild-plugin', 'package.json'));
  for (const c of candidates) {
    try {
      const meta = JSON.parse(fs.readFileSync(c, 'utf8'));
      if (meta && typeof meta.name === 'string' && typeof meta.version === 'string') return meta;
    } catch (e) {}
  }
  return { name: 'dsh-swarm-rebuild', version: '3.0.0' };
}

// Inline the icon as a base64 data: URL. The format-1 validator accepts
// data:image/svg+xml;base64,... up to 32 KiB decoded — our 2.6 KiB SVG is well
// under that, and an inline icon needs no second fetch or https origin.
function loadIconData(root) {
  const candidates = [];
  try { candidates.push(new URL('./icon.svg', import.meta.url)); } catch (e) {}
  candidates.push(path.join(root, 'swarm-rebuild-plugin', 'icon.svg'));
  for (const c of candidates) {
    try {
      const buf = fs.readFileSync(c);
      if (buf && buf.length > 0 && buf.length < 30000) {
        return 'data:image/svg+xml;base64,' + buf.toString('base64');
      }
    } catch (e) {}
  }
  return '';
}

// Read the locale files so the market entry describes what the plugin ACTUALLY
// does. (A hardcoded description drifts the moment the effect changes, and an
// out-of-date description is a catalog rejection reason.) Missing/unparsable
// locales fall back to neutral text rather than failing the whole index.
function loadLocaleText(root) {
  const out = { en: '', zh: '' };
  const read = (lang) => {
    const candidates = [];
    try { candidates.push(new URL('./locale/' + lang + '.json', import.meta.url)); } catch (e) {}
    candidates.push(path.join(root, 'swarm-rebuild-plugin', 'locale', lang + '.json'));
    for (const c of candidates) {
      try {
        const j = JSON.parse(fs.readFileSync(c, 'utf8'));
        const d = j && j.meta && j.meta.description;
        if (typeof d === 'string' && d.trim()) return d.trim();
      } catch (e) {}
    }
    return '';
  };
  out.en = read('en');
  out.zh = read('zh');
  return out;
}

// Build a format-1 plugin-market index (as validated by
// @deepseek-ai/dsh-plugin-market-index parseMarketIndex). Keeping it derived
// from package.json + icon.svg + locale means there is no second source of
// truth to drift. source.type = "npm" yields install spec "<name>@<version>";
// since the bundle is already installed at that exact name+version, the market
// lists it as installed. Omit metadata/engines entirely for guaranteed validity.
function marketIndex(pkg, iconData, localeText) {
  const name = String(pkg.name || 'dsh-swarm-rebuild');
  const version = String(pkg.version || '3.0.0');
  // publishTimestamp: integer Unix seconds in [0, 1e11). Derive it from the
  // package.json mtime so it tracks the real publish; fall back to a fixed,
  // safely-in-range epoch if stat is unavailable.
  let ts = 1700000000;
  try {
    const st = fs.statSync(new URL('./package.json', import.meta.url));
    const s = Math.floor(st.mtimeMs / 1000);
    if (Number.isInteger(s) && s >= 0 && s < 1e11) ts = s;
  } catch (e) {}

  const lt = localeText || { en: '', zh: '' };
  const enText = lt.en || 'Rebuilds the developing page with a swarm of AI cursors that draw every block out of a blank blueprint.';
  const zhText = lt.zh || '用一群 AI 光标在空白蓝图上逐个把网页搭建出来。';
  const entry = {
    name,
    title: { en: 'Swarm Rebuild', zh: '群蜂建站' },
    description: { en: enText, zh: zhText },
    versions: [{
      version,
      publishTimestamp: ts,
      source: { type: 'npm' },
    }],
  };
  if (iconData) entry.icon = iconData;

  const index = {
    format: 1,
    title: { en: 'Swarm Rebuild · Local Plugins', zh: '群蜂建站 · 本地插件市场' },
    description: {
      en: 'Locally published Harness plugins, served in-memory by the plugin itself.',
      zh: '本地发布的 Harness 插件，由插件自身在内存中提供。',
    },
    plugins: [entry],
  };
  return JSON.stringify(index);
}
