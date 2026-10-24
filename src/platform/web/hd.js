// hd.js - decodes the HD texture replacements off the game thread (--pre-js).
//
// system/HdTextures.cpp queues a room's pictures as soon as the room loads
// (HdTextures_Prefetch). Natively worker threads decode them; the page has no
// threads, so two Web Workers running re1_hd_worker.js (hd_worker.cpp, the
// same WebP decoder compiled on its own) do it here. HdTextures.cpp hands a
// job over with decode(), and on its next poll takes the finished pixels with
// state() + copy(). A cancelled room (cancel()) bumps the generation, so the
// answers still on their way for it are dropped.
//
// If the worker script cannot be loaded, state() answers "redo" and the job
// goes back to the game thread's own decoder (HdTextures.cpp RunQueued).
//
// Module.re1HdWorkerUrl   the worker script (default "re1_hd_worker.js")

var re1Hd = {
    workers: null,
    broken: false,
    gen: 0,
    nextId: 1,
    jobs: {},       // id -> { name, gen }
    done: {},       // name -> { w, h, rgba } | { failed } | { redo }

    start: function () {
        if (re1Hd.workers !== null) return !re1Hd.broken;
        re1Hd.workers = [];
        if (typeof Worker === 'undefined') { re1Hd.broken = true; return false; }
        var url = Module.re1HdWorkerUrl || 're1_hd_worker.js';
        for (var i = 0; i < 2; i++) {
            var w;
            try { w = new Worker(url); } catch (e) { re1Hd.fail('cannot start ' + url + ': ' + e); return false; }
            w.load = 0;
            w.onmessage = re1Hd.answer.bind(null, w);
            w.onerror = function (e) { re1Hd.fail(url + ': ' + (e.message || 'failed to load')); };
            re1Hd.workers.push(w);
        }
        return true;
    },

    // The workers are unusable: every job still out goes back to the game thread.
    fail: function (why) {
        if (re1Hd.broken) return;
        re1Hd.broken = true;
        err('[hd] decoder worker unavailable (' + why + ') - decoding on the game thread');
        for (var id in re1Hd.jobs) {
            var job = re1Hd.jobs[id];
            if (job.gen === re1Hd.gen) re1Hd.done[job.name] = { redo: true };
        }
        re1Hd.jobs = {};
        (re1Hd.workers || []).forEach(function (w) { w.terminate(); });
    },

    answer: function (worker, e) {
        var m = e.data;
        worker.load--;
        var job = re1Hd.jobs[m.id];
        delete re1Hd.jobs[m.id];
        if (!job || job.gen !== re1Hd.gen) return;
        re1Hd.done[job.name] = m.rgba ? { w: m.w, h: m.h, rgba: new Uint8Array(m.rgba) } : { failed: true };
    },

    bytes: async function (path) {
        var n = Module.re1Vfs ? Module.re1Vfs.node(path) : null;
        if (n && n.re1Remote) return await Module.re1Vfs.fetchBytes(n.re1Remote.url);
        return FS.readFile(path);
    },

    // Hand `name` (the file at `path`) to a worker. False when the workers are
    // unusable and the caller must decode it itself.
    decode: function (name, path) {
        if (!re1Hd.start()) return false;
        var gen = re1Hd.gen;
        var id = re1Hd.nextId++;
        re1Hd.jobs[id] = { name: name, gen: gen };
        re1Hd.bytes(path).then(function (bytes) {
            if (re1Hd.broken || !re1Hd.jobs[id]) return;
            var w = re1Hd.workers[0];
            re1Hd.workers.forEach(function (x) { if (x.load < w.load) w = x; });
            w.load++;
            // A copy the worker can own: the bytes may be a view into a larger buffer.
            var buf = bytes.slice().buffer;
            w.postMessage({ id: id, bytes: buf }, [buf]);
        }, function (e) {
            err('[hd] ' + path + ': ' + e);
            delete re1Hd.jobs[id];
            if (gen === re1Hd.gen) re1Hd.done[name] = { failed: true };
        });
        return true;
    },

    // 1 = pixels ready (w, h set), -1 = failed, -2 = decode it yourself, 0 = not yet.
    state: function (name) {
        var d = re1Hd.done[name];
        if (!d) return [0];
        if (d.redo) { delete re1Hd.done[name]; return [-2]; }
        if (d.failed) { delete re1Hd.done[name]; return [-1]; }
        return [1, d.w, d.h];
    },

    copy: function (name, dst) {
        var d = re1Hd.done[name];
        delete re1Hd.done[name];
        if (d && d.rgba) HEAPU8.set(d.rgba, dst);
    },

    // Names with an answer waiting, for HdTextures.cpp to collect.
    ready: function () {
        return Object.keys(re1Hd.done);
    },

    cancel: function () {
        re1Hd.gen++;
        re1Hd.done = {};
    },
};

Module.re1Hd = re1Hd;
