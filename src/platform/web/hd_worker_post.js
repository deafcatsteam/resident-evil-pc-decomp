// hd_worker_post.js - message loop of the HD decoder worker (--post-js of
// re1_hd_worker; see hd_worker.cpp and hd.js).
//
// in:  { id, bytes: ArrayBuffer }            the .webp file
// out: { id, w, h, rgba: ArrayBuffer }       RGBA8, or rgba = null on failure
var re1HdQueue = [];
var re1HdReady = false;

function re1HdRun(msg) {
    var src = new Uint8Array(msg.bytes);
    var inPtr = _malloc(src.length || 1);
    var outPtr = _malloc(8);
    var result = { id: msg.id, w: 0, h: 0, rgba: null };
    if (inPtr && outPtr) {
        HEAPU8.set(src, inPtr);
        var px = _re1_hd_decode(inPtr, src.length, outPtr);
        if (px) {
            result.w = HEAP32[outPtr >> 2];
            result.h = HEAP32[(outPtr >> 2) + 1];
            result.rgba = HEAPU8.slice(px, px + result.w * result.h * 4).buffer;
            _free(px);
        }
    }
    _free(inPtr);
    _free(outPtr);
    postMessage(result, result.rgba ? [result.rgba] : []);
}

self.onmessage = function (e) {
    if (re1HdReady) re1HdRun(e.data);
    else re1HdQueue.push(e.data);
};

Module.onRuntimeInitialized = function () {
    re1HdReady = true;
    while (re1HdQueue.length) re1HdRun(re1HdQueue.shift());
};
