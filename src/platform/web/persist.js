// persist.js - the player's files outlive the page (--pre-js).
//
// What is kept: /re1/config.ini and everything under /re1/SAVE/ (savedat*.dat,
// bonus.dat, batrank.dat, ...) - the files the game writes and nothing of the
// data tree. Where: a WebDAV folder on the server (Module.re1SaveUrl, default
// "saves/"; the Caddyfile in docs/WEB_PORT.md maps it per user), mirrored in
// IndexedDB so a save made while the server is unreachable is not lost.
//
// Before main() (a run dependency): every kept file is read back into MEMFS.
// The server's copy wins, except over a local copy that never reached it -
// that one is uploaded instead. Without WebDAV (a 404/405, or a plain static
// server) IndexedDB alone is used and the page says so.
//
// After main() starts: vfs.cpp calls saved(path) when a write-mode stream is
// closed; the file goes to IndexedDB at once and to the server in the
// background. flush() resolves when nothing is pending - the restart waits on
// it before reloading the page.
//
// If no config.ini exists anywhere, data/config.ini (beside manifest.json) is
// used as the starting one, so the server can preset Mode=DC and the like.
//
// Module.re1SaveUrl       WebDAV folder (default "saves/")
// Module.re1OnPersist     optional (state) callback: 'server' | 'local' | 'error'

var re1Persist = {
    root: '/re1',
    mode: 'local',      // 'server' once WebDAV answered
    db: null,
    pending: [],

    // Path relative to /re1 when the file is one of the kept ones, else null.
    keyFor: function (path) {
        var abs;
        try {
            abs = FS.lookupPath(path, { follow: true }).path;
        } catch (e) {
            return null;
        }
        var prefix = re1Persist.root + '/';
        if (abs.indexOf(prefix) !== 0) return null;
        var rel = abs.substring(prefix.length);
        var lower = rel.toLowerCase();
        if (lower === 'config.ini') return rel;
        if (lower.indexOf('save/') === 0 && rel.indexOf('/', 5) < 0 && rel.length > 5) {
            return 'SAVE/' + rel.substring(5);   // one spelling on the server
        }
        return null;
    },

    // ---- IndexedDB: { key: "SAVE/savedat1.dat", data: Uint8Array, synced: bool }
    openDb: function () {
        return new Promise(function (resolve) {
            if (typeof indexedDB === 'undefined') { resolve(null); return; }
            var req;
            try { req = indexedDB.open('re1-persist', 1); } catch (e) { resolve(null); return; }
            req.onupgradeneeded = function () { req.result.createObjectStore('files', { keyPath: 'key' }); };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { resolve(null); };
        });
    },

    dbOp: function (mode, fn) {
        var db = re1Persist.db;
        if (!db) return Promise.resolve(null);
        return new Promise(function (resolve) {
            var tx = db.transaction('files', mode);
            var req = fn(tx.objectStore('files'));
            tx.oncomplete = function () { resolve(req ? req.result : null); };
            tx.onerror = tx.onabort = function () { resolve(null); };
        });
    },

    dbAll: function () { return re1Persist.dbOp('readonly', function (s) { return s.getAll(); }); },
    dbPut: function (rec) { return re1Persist.dbOp('readwrite', function (s) { return s.put(rec); }); },

    // ---- WebDAV
    base: function () {
        var b = Module.re1SaveUrl || 'saves/';
        return b.charAt(b.length - 1) === '/' ? b : b + '/';
    },

    url: function (key) {
        return re1Persist.base() + key.split('/').map(encodeURIComponent).join('/');
    },

    // Names (files only) in WebDAV folder `sub` ('' or 'SAVE/'); null when
    // there is no WebDAV, [] when the folder does not exist yet.
    list: async function (sub) {
        var r = await fetch(re1Persist.base() + sub, {
            method: 'PROPFIND', credentials: 'same-origin', cache: 'no-store',
            headers: { Depth: '1', 'Content-Type': 'application/xml' },
            body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>',
        });
        if (r.status === 404 && sub !== '') return [];
        if (r.status !== 207) return null;
        var doc = new DOMParser().parseFromString(await r.text(), 'application/xml');
        var names = [];
        var responses = doc.getElementsByTagNameNS('DAV:', 'response');
        for (var i = 0; i < responses.length; i++) {
            var resp = responses[i];
            if (resp.getElementsByTagNameNS('DAV:', 'collection').length) continue;
            var href = resp.getElementsByTagNameNS('DAV:', 'href')[0];
            if (!href) continue;
            var path = decodeURIComponent(new URL(href.textContent, location.href).pathname);
            var name = path.substring(path.lastIndexOf('/') + 1);
            if (name) names.push(name);
        }
        return names;
    },

    upload: async function (key, data) {
        var opts = { method: 'PUT', credentials: 'same-origin', body: data, keepalive: data.length < 60000 };
        var r = await fetch(re1Persist.url(key), opts);
        if (r.status === 409 && key.indexOf('/') > 0) {
            // The folder is missing: create it, then try again.
            await fetch(re1Persist.base() + key.substring(0, key.indexOf('/') + 1),
                        { method: 'MKCOL', credentials: 'same-origin' });
            r = await fetch(re1Persist.url(key), opts);
        }
        if (!r.ok) throw new Error('PUT ' + key + ': HTTP ' + r.status);
    },

    download: async function (key) {
        var r = await fetch(re1Persist.url(key), { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) throw new Error('GET ' + key + ': HTTP ' + r.status);
        return new Uint8Array(await r.arrayBuffer());
    },

    // ---- MEMFS
    write: function (key, data) {
        var full = re1Persist.root + '/' + key;
        FS.mkdirTree(full.substring(0, full.lastIndexOf('/')));
        FS.writeFile(full, data);
        if (Module.re1Vfs) Module.re1Vfs.forget(full);
    },

    notify: function (state) {
        if (Module.re1OnPersist) Module.re1OnPersist(state);
    },

    // ---- startup
    restore: async function () {
        re1Persist.db = await re1Persist.openDb();
        var local = {};
        (await re1Persist.dbAll() || []).forEach(function (rec) { local[rec.key] = rec; });

        var remote = null;
        try {
            var top = await re1Persist.list('');
            if (top !== null) {
                var saves = await re1Persist.list('SAVE/');
                if (saves !== null) {
                    remote = top.filter(function (n) { return n.toLowerCase() === 'config.ini'; })
                        .concat(saves.map(function (n) { return 'SAVE/' + n; }));
                }
            }
        } catch (e) {
            err('[persist] WebDAV unreachable: ' + e);
        }

        var have = {};
        if (remote !== null) {
            re1Persist.mode = 'server';
            for (var i = 0; i < remote.length; i++) {
                var key = remote[i];
                var rec = local[key];
                if (rec && !rec.synced) continue;   // newer here: uploaded below
                try {
                    var data = await re1Persist.download(key);
                    re1Persist.write(key, data);
                    have[key] = true;
                    await re1Persist.dbPut({ key: key, data: data, synced: true });
                } catch (e) {
                    err('[persist] ' + e);
                    if (rec) { re1Persist.write(key, rec.data); have[key] = true; }
                }
            }
        }
        for (var k in local) {
            if (have[k]) continue;
            // Only here (never uploaded, or gone from the server): nothing is
            // ever deleted on the strength of a listing - it goes back up.
            var r2 = local[k];
            re1Persist.write(k, r2.data);
            have[k] = true;
            if (remote !== null) re1Persist.queue(k, r2.data);
        }

        if (!Object.keys(have).some(function (n) { return n.toLowerCase() === 'config.ini'; })) {
            try {
                var dataBase = Module.re1DataUrl || 'data/';
                if (dataBase.charAt(dataBase.length - 1) !== '/') dataBase += '/';
                var r3 = await fetch(dataBase + 'config.ini', { credentials: 'same-origin', cache: 'no-store' });
                if (r3.ok) {
                    re1Persist.write('config.ini', new Uint8Array(await r3.arrayBuffer()));
                    out('[persist] starting from ' + dataBase + 'config.ini');
                }
            } catch (e) { /* no preset: the game writes its defaults */ }
        }
        out('[persist] ' + Object.keys(have).length + ' file(s), ' +
            (re1Persist.mode === 'server' ? 'server (' + re1Persist.base() + ')' : 'this browser only'));
        re1Persist.notify(re1Persist.mode);
    },

    // ---- writes
    queue: function (key, data) {
        var job = re1Persist.upload(key, data).then(function () {
            return re1Persist.dbPut({ key: key, data: data, synced: true });
        }).then(function () {
            re1Persist.notify('server');
        }, function (e) {
            err('[persist] ' + e + ' - kept in this browser, sent again at the next start');
            re1Persist.notify('error');
        });
        re1Persist.track(job);
    },

    track: function (job) {
        re1Persist.pending.push(job);
        job.then(function () {
            var i = re1Persist.pending.indexOf(job);
            if (i >= 0) re1Persist.pending.splice(i, 1);
        });
    },

    saved: function (path) {
        var key = re1Persist.keyFor(path);
        if (key === null) return;
        var data;
        try { data = FS.readFile(re1Persist.root + '/' + key); } catch (e) { return; }
        re1Persist.track(re1Persist.dbPut({ key: key, data: data, synced: false }));
        if (re1Persist.mode === 'server') re1Persist.queue(key, data);
    },

    flush: function () {
        return Promise.all(re1Persist.pending.slice()).then(function () {
            if (re1Persist.pending.length) return re1Persist.flush();
        });
    },
};

Module.re1Persist = re1Persist;
Module.preRun = Module.preRun || [];
if (typeof Module.preRun === 'function') Module.preRun = [Module.preRun];
Module.preRun.push(function () {
    addRunDependency('re1-persist');
    re1Persist.restore().catch(function (e) {
        err('[persist] ' + e);
        re1Persist.notify('error');
    }).then(function () {
        removeRunDependency('re1-persist');
    });
});
