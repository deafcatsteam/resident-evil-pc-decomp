// video.js - the movie player behind web/video.cpp (--pre-js).
//
// One hidden <video> element streams the movie straight from the server (the
// data tree's URL, so the server's Range support does the seeking) and plays
// its sound itself. video.cpp copies the current picture into a GL texture
// every game frame and draws it the way the Linux backend draws ffmpeg's
// frames, so the PS1 subtitles and the DC credits still go on top.
//
// A file the game wrote itself (no URL) is played from a blob of its bytes.

var re1Video = {
    el: null,
    blobUrl: null,
    ended: false,
    playToMs: 0,

    urlFor: function (path) {
        var n = Module.re1Vfs ? Module.re1Vfs.node(path) : null;
        if (n && n.re1Remote) return n.re1Remote.url;
        try {
            var bytes = FS.readFile(path);
            return URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
        } catch (e) {
            return null;
        }
    },

    // Wait for one of `ok` (resolves true) or 'error' (false) on `el`, or the timeout.
    wait: function (el, ok, ms) {
        return new Promise(function (resolve) {
            var timer = 0;
            function done(v) {
                clearTimeout(timer);
                el.removeEventListener(ok, onOk);
                el.removeEventListener('error', onErr);
                resolve(v);
            }
            function onOk() { done(true); }
            function onErr() { done(false); }
            el.addEventListener(ok, onOk);
            el.addEventListener('error', onErr);
            timer = setTimeout(function () { done(false); }, ms);
        });
    },

    release: function () {
        var el = re1Video.el;
        if (el) {
            el.pause();
            el.removeAttribute('src');
            el.load();
        }
        if (re1Video.blobUrl) URL.revokeObjectURL(re1Video.blobUrl);
        re1Video.blobUrl = null;
        re1Video.ended = false;
    },

    open: async function (path, playToMs) {
        re1Video.release();
        var url = re1Video.urlFor(path);
        if (!url) return false;
        if (url.indexOf('blob:') === 0) re1Video.blobUrl = url;
        if (!re1Video.el) {
            var el = document.createElement('video');
            el.playsInline = true;
            el.preload = 'auto';
            el.addEventListener('ended', function () { re1Video.ended = true; });
            re1Video.el = el;
        }
        var v = re1Video.el;
        v.src = url;
        if (!await re1Video.wait(v, 'loadeddata', 30000)) {
            err('[video] cannot play ' + path + ' (' + url + ')' +
                (v.error ? ': code ' + v.error.code : ''));
            re1Video.release();
            return false;
        }
        re1Video.playToMs = playToMs;
        re1Video.start();
        return true;
    },

    start: function () {
        re1Video.ended = false;
        re1Video.el.play().catch(function (e) { err('[video] play: ' + e); });
    },

    // Length in ms read from the metadata alone, 0 when unknown.
    probe: async function (path) {
        var url = re1Video.urlFor(path);
        if (!url) return 0;
        var el = document.createElement('video');
        el.preload = 'metadata';
        el.src = url;
        var ok = await re1Video.wait(el, 'loadedmetadata', 15000);
        var ms = (ok && isFinite(el.duration)) ? Math.round(el.duration * 1000) : 0;
        el.removeAttribute('src');
        el.load();
        if (url.indexOf('blob:') === 0) URL.revokeObjectURL(url);
        return ms;
    },

    seek: async function (ms) {
        var v = re1Video.el;
        if (!v) return;
        v.currentTime = ms / 1000;
        await re1Video.wait(v, 'seeked', 10000);
    },
};

Module.re1Video = re1Video;
