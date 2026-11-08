/* Arcade Shell — the offline launcher.
 * Reads window.AOMG_CATALOG (generated from catalog/games.json).
 * No network at runtime: everything it needs ships in the folder. */
(function () {
  'use strict';

  var C = window.AOMG_CATALOG;
  var store = GK.store('shell');
  var el = function (id) { return document.getElementById(id); };
  var state = { filter: 'all', open: null };

  var COLORS = ['#f0b429', '#4de2c0', '#ff7a45', '#7cc7ff', '#c084fc', '#ff6b8a', '#7cf59a', '#ffd166', '#f472b6', '#6ee7ff'];
  function colorFor(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
    return COLORS[h % COLORS.length];
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- render ---------- */
  function render() {
    var grid = el('grid');
    var games = C.games.filter(function (g) { return state.filter === 'all' || g.lane === state.filter; });
    games.sort(function (a, b) { return a.rank - b.rank; });
    var html = '';
    for (var i = 0; i < games.length; i++) {
      var g = games[i];
      var c = colorFor(g.id);
      html +=
        '<article class="card" data-id="' + esc(g.id) + '" style="--c:' + c + '">' +
          '<div class="card-top">' +
            '<span class="rank">' + (g.rank < 10 ? '0' : '') + g.rank + '</span>' +
            '<span class="lane ' + g.lane + '">' + (g.lane === 'forge' ? 'ORIGINAL' : 'HYBRID') + '</span>' +
            '<span class="score">' + g.score.toFixed(1) + '</span>' +
          '</div>' +
          '<h2>' + esc(g.title) + '</h2>' +
          '<p class="tag">' + esc(g.tagline) + '</p>' +
          '<div class="chips">' + g.genre.slice(0, 3).map(function (x) { return '<span>' + esc(x) + '</span>'; }).join('') + '</div>' +
          '<div class="card-foot">' +
            '<span class="size">' + (g.size_mb != null ? g.size_mb + ' MB' : 'source build') + '</span>' +
            '<button class="go" data-open="' + esc(g.id) + '">PLAY →</button>' +
          '</div>' +
        '</article>';
    }
    grid.innerHTML = html;
    grid.querySelectorAll('[data-open]').forEach(function (b) {
      b.addEventListener('click', function () { openSheet(b.getAttribute('data-open')); });
    });
  }

  function byId(id) {
    for (var i = 0; i < C.games.length; i++) if (C.games[i].id === id) return C.games[i];
    return null;
  }

  /* ---------- detail sheet ---------- */
  function openSheet(id) {
    var g = byId(id);
    if (!g) return;
    state.open = g;
    var c = colorFor(g.id);
    var sheet = el('sheet');
    var body = '';
    body += '<div class="sheet-head" style="--c:' + c + '">';
    body += '<span class="lane ' + g.lane + '">' + (g.lane === 'forge' ? 'ORIGINAL · BUILT FOR THIS REPO'
      : 'CROSS-HYBRID · TWO CLONES CROSSED, RENAMED') + '</span>';
    body += '<h2>' + esc(g.title) + '</h2>';
    body += '<p class="tag">' + esc(g.tagline) + '</p>';
    body += '</div>';

    body += '<dl class="facts">';
    body += '<dt>Score</dt><dd>' + g.score.toFixed(1) + ' / 10</dd>';
    body += '<dt>Genre</dt><dd>' + g.genre.map(esc).join(' · ') + '</dd>';
    body += '<dt>Controls</dt><dd>' + esc(g.controls) + '</dd>';
    body += '<dt>Offline</dt><dd>' + esc(g.offline) + '</dd>';
    body += '<dt>Size</dt><dd>' + (g.size_mb != null ? g.size_mb + ' MB' : 'built from source') + '</dd>';
    body += '<dt>License</dt><dd>' + esc(g.license) + '</dd>';
    body += '</dl>';

    body += '<h3>Hybrid lineage</h3><p>' + esc(g.hybrid_note) + '</p>';
    body += '<h3>What was kept honest</h3><p>' + esc(g.verified) + '</p>';

    body += '<a class="primary cta" href="../games/' + esc(g.id) + '/index.html">PLAY NOW</a>';
    body += '<p class="fine">Runs from this folder with the network off. Progress saves to this device.</p>';
    sheet.querySelector('.sheet-body').innerHTML = body;
    sheet.classList.add('on');
  }
  function closeSheet() { el('sheet').classList.remove('on'); state.open = null; }

  /* ---------- saves ---------- */
  function openSaves() {
    var keys = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('aomg.') === 0) keys.push(k);
      }
    } catch (e) { }
    var rows = keys.map(function (k) {
      var bytes = (localStorage.getItem(k) || '').length;
      return '<li><span>' + esc(k.replace('aomg.', '')) + '</span><em>' + (bytes / 1024).toFixed(1) + ' KB</em>' +
        '<button class="tiny" data-wipe="' + esc(k) + '">clear</button></li>';
    }).join('');
    el('savesList').innerHTML = rows || '<li class="empty">No saves yet — play something.</li>';
    el('savesList').querySelectorAll('[data-wipe]').forEach(function (b) {
      b.addEventListener('click', function () {
        localStorage.removeItem(b.getAttribute('data-wipe'));
        openSaves();
      });
    });
    el('saves').classList.add('on');
  }

  function exportAll() {
    var out = { aomg: 1, at: new Date().toISOString(), data: {} };
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf('aomg.') === 0) out.data[k] = localStorage.getItem(k);
    }
    var blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'aomg-saves-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  function importSaves(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var o = JSON.parse(fr.result);
        if (!o || !o.data) throw new Error('bad file');
        var n = 0;
        Object.keys(o.data).forEach(function (k) {
          if (k.indexOf('aomg.') === 0) { localStorage.setItem(k, o.data[k]); n++; }
        });
        toast('Imported ' + n + ' save slot' + (n === 1 ? '' : 's') + '.');
        openSaves();
      } catch (e) { toast('That file is not a save bundle.'); }
    };
    fr.readAsText(file);
  }

  var toastT = 0;
  function toast(msg) {
    var t = el('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.remove('on'); }, 2600);
  }

  /* ---------- boot ---------- */
  function boot() {
    if (!C) { document.body.innerHTML = '<p style="padding:24px;color:#f66">catalog.data.js missing — run node tools/sync-catalog.mjs</p>'; return; }

    el('count').textContent = C.games.length;
    el('forgeCount').textContent = C.games.filter(function (g) { return g.lane === 'forge'; }).length;
    if (el('hybridCount')) el('hybridCount').textContent = C.games.filter(function (g) { return g.lane === 'hybrid'; }).length;

    document.querySelectorAll('[data-filter]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.filter = b.getAttribute('data-filter');
        document.querySelectorAll('[data-filter]').forEach(function (x) { x.classList.toggle('on', x === b); });
        render();
      });
    });

    el('savesBtn').addEventListener('click', openSaves);
    el('sheetClose').addEventListener('click', closeSheet);
    el('sheet').addEventListener('click', function (e) { if (e.target === el('sheet')) closeSheet(); });
    el('savesClose').addEventListener('click', function () { el('saves').classList.remove('on'); });
    el('exportBtn').addEventListener('click', exportAll);
    el('importFile').addEventListener('change', function (e) { if (e.target.files[0]) importSaves(e.target.files[0]); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeSheet(); el('saves').classList.remove('on'); } });

    var net = el('net');
    function paintNet() {
      net.textContent = navigator.onLine ? 'NETWORK PRESENT · NOT USED' : 'AIRPLANE MODE · ALL GOOD';
      net.className = 'net' + (navigator.onLine ? '' : ' off');
    }
    window.addEventListener('online', paintNet);
    window.addEventListener('offline', paintNet);
    paintNet();

    render();

    /* The worker precaches every game's code, but art is cached the first time it is drawn —
       which leaves a game you have never opened half-broken in airplane mode. This walks the
       whole payload once, at the player's request, so the entire collection is genuinely there
       with the radio off. Progress is honest: files completed out of files known. */
    /* AOMG-OFFLINE-CACHE-ONLY: the fetches below exist to pull this same origin's own files into
       the service-worker cache. Nothing here leaves the device, and none of it runs at play time. */
    function saveAllForOffline() {
      var btn = el('saveAll');
      if (!btn || btn.disabled) return;
      if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
        toast('open this from the web address once — a file:// copy is already offline');
        return;
      }
      /* Ask each game's own index.html which scripts it loads instead of assuming js/main.js —
         Stormforge needs six, and a missing one is a game that boots to a blank canvas. */
      /* Every path here is relative to the launcher, which lives in shell/ — so they all climb
         one level. Getting this wrong silently saved nothing while the button said READY. */
      var pages = (C.games || []).map(function (g) { return '../games/' + g.id + '/index.html'; });
      var files = [];
      var art = (window.AOMG_VENDOR && window.AOMG_VENDOR.assets) || [];
      art.forEach(function (a) { files.push('../vendor/' + a.replace(/^\.?\/+/, '')); });
      files.push('../vendor/vendor.js', '../vendor/three/three.min.js', '../catalog/games.json');

      btn.disabled = true;
      var done = 0, failed = 0;
      btn.textContent = 'READING SHELF…';

      Promise.all(pages.map(function (u) {
        return fetch(u, { cache: 'reload' }).then(function (r) { return r.ok ? r.text() : ''; })
          .then(function (html) {
            files.push(u);
            var m = html.match(/<script[^>]+src=["']([^"']+)["']/g) || [];
            m.forEach(function (tag) {
              var src = tag.replace(/^.*src=["']/, '').replace(/["'].*$/, '');
              if (!/^https?:|^\/\//.test(src)) files.push('../games/' + u.split('/')[2] + '/' + src.replace(/^\.\//, ''));
            });
          }).catch(function () { failed++; files.push(u); });
      })).then(function () {
        start();
      });

      function start() {

      function one(u) {
        return fetch(u, { cache: 'reload' }).then(function (r) {
          if (!r.ok) failed++;
        }).catch(function () { failed++; }).then(function () {
          done++;
          if (done % 25 === 0 || done === files.length) btn.textContent = 'SAVING ' + done + ' / ' + files.length;
        });
      }

      btn.textContent = 'SAVING 0 / ' + files.length;
      var i = 0;
      function worker() {
        if (i >= files.length) return Promise.resolve();
        return one(files[i++]).then(worker);
      }
      Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]).then(function () {
        btn.disabled = false;
        // READY only when nothing failed — a green badge over a half-empty cache is a lie.
        btn.textContent = failed ? 'SAVED ' + (files.length - failed) + ' · ' + failed + ' FAILED'
                                 : 'OFFLINE COPY READY';
        btn.classList.add('done');
        toast(failed ? (files.length - failed) + ' of ' + files.length + ' files saved — ' + failed + ' failed'
                     : 'all ' + files.length + ' files saved — airplane mode is safe');
      });
      }
    }
    if (el('saveAll')) el('saveAll').addEventListener('click', saveAllForOffline);

    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('../sw.js').then(function () {
        el('swState').textContent = 'precached for offline';
      }).catch(function () { el('swState').textContent = 'running from disk'; });
    } else {
      el('swState').textContent = 'running from disk (file://)';
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
