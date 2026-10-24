// vfs.js - mounts the data tree described by data/manifest.json (--pre-js).
//
// See vfs.cpp for the design. Before main() this creates, under /re1, every
// directory and an empty placeholder for every file of the manifest; the
// placeholders' real sizes are kept on their MEMFS nodes. vfs.cpp's fopen
// wrapper asks remoteSize() whether a path is still a placeholder and
// fetchInto() for its bytes.
//
// Module.re1DataUrl   where the tree is served (default "data/")
// Module.re1OnFetch   optional (pending) callback, for a loading indicator
// Module.re1OnFatal   optional (message) callback when the tree is missing
//
// manifest.json (tools/web/build_manifest.py):
//   {"version": 1, "files": [["USA/Data/fontus.tim", 18452, "3f9a0c1d"], ...]}
// The third field is a short version tag appended as ?v= so every URL is
// immutable and the server can let the browser cache it for good.

var re1Vfs = {
    root: '/re1',
    pending: 0,
    cache: null,

    node: function (path) {
        try {
            return FS.lookupPath(path, { follow: true }).node;
        } catch (e) {
            return null;
        }
    },

    remoteSize: function (path) {
        var n = re1Vfs.node(path);
        return (n && n.re1Remote) ? n.re1Remote.size : -1;
    },

    forget: function (path) {
        var n = re1Vfs.node(path);
        if (n) delete n.re1Remote;
    },

    openCache: function () {
        if (re1Vfs.cache === null) {
            re1Vfs.cache = (typeof caches !== 'undefined')
                ? caches.open('re1-data-v1').catch(function () { return undefined; })
                : Promise.resolve(undefined);
        }
        return re1Vfs.cache;
    },

    fetchBytes: async function (url) {
        var cache = await re1Vfs.openCache();
        var response = cache ? await cache.match(url) : undefined;
        if (!response) {
            response = await fetch(url, { credentials: 'same-origin' });
            if (!response.ok) throw new Error(url + ': HTTP ' + response.status);
            if (cache) {
                try { await cache.put(url, response.clone()); } catch (e) { /* quota: just not cached */ }
            }
        }
        return new Uint8Array(await response.arrayBuffer());
    },

    fetchInto: async function (path, dst, size) {
        var n = re1Vfs.node(path);
        if (!n || !n.re1Remote) return -1;
        re1Vfs.pending++;
        if (Module.re1OnFetch) Module.re1OnFetch(re1Vfs.pending);
        try {
            var bytes = await re1Vfs.fetchBytes(n.re1Remote.url);
            if (bytes.length !== size) {
                err('[vfs] ' + path + ': ' + bytes.length + ' bytes, manifest says ' + size +
                    ' - rebuild manifest.json');
                return -1;
            }
            HEAPU8.set(bytes, dst);   // HEAPU8 is re-read: the heap may have grown meanwhile
            return size;
        } catch (e) {
            err('[vfs] ' + path + ': ' + e);
            return -1;
        } finally {
            re1Vfs.pending--;
            if (Module.re1OnFetch) Module.re1OnFetch(re1Vfs.pending);
        }
    },

    mount: function (manifest, base) {
        var made = {};
        made[re1Vfs.root] = true;
        FS.mkdirTree(re1Vfs.root);
        var files = manifest.files || [];
        for (var i = 0; i < files.length; i++) {
            var rel = files[i][0], size = files[i][1], tag = files[i][2];
            var full = re1Vfs.root + '/' + rel;
            var dir = full.substring(0, full.lastIndexOf('/'));
            if (!made[dir]) { FS.mkdirTree(dir); made[dir] = true; }
            FS.writeFile(full, '');
            var url = base + rel.split('/').map(encodeURIComponent).join('/') + (tag ? '?v=' + tag : '');
            FS.lookupPath(full).node.re1Remote = { size: size, url: url };
        }
        return files.length;
    },
};

Module.re1Vfs = re1Vfs;
Module.preRun = Module.preRun || [];
if (typeof Module.preRun === 'function') Module.preRun = [Module.preRun];
Module.preRun.push(function () {
    var base = Module.re1DataUrl || 'data/';
    if (base.charAt(base.length - 1) !== '/') base += '/';
    addRunDependency('re1-manifest');
    fetch(base + 'manifest.json', { cache: 'no-cache', credentials: 'same-origin' })
        .then(function (r) {
            if (!r.ok) throw new Error(base + 'manifest.json: HTTP ' + r.status);
            return r.json();
        })
        .then(function (manifest) {
            var count = re1Vfs.mount(manifest, base);
            out('[vfs] ' + count + ' files in ' + base);
            removeRunDependency('re1-manifest');
        })
        .catch(function (e) {
            err('[vfs] no data tree: ' + e);
            if (Module.re1OnFatal) Module.re1OnFatal(String(e));
            else removeRunDependency('re1-manifest');
        });
});
