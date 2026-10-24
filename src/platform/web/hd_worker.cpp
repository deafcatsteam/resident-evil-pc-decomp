// hd_worker.cpp - the HD texture decoder that runs in a Web Worker.
//
// Built as its own small module (re1_hd_worker.js/.wasm, CMakeLists.txt): the
// game's page has no threads, so a room's HD pictures - a dozen 1280x960 WebP
// on entering it - were decoded on the game thread and stalled the frame. Two
// of these workers (web/hd.js) decode them instead, with the very decoder the
// native build uses (system/WebpImage.cpp), so the pixels are identical.
// hd_worker_post.js is the message loop.
#include "../../system/WebpImage.h"

#include <emscripten.h>
#include <stdlib.h>
#include <string.h>

extern "C" {

// Decode size bytes at `data`. Returns a malloc'd RGBA8 buffer (freed with
// free()) and fills out[0..1] with the size, or NULL.
EMSCRIPTEN_KEEPALIVE unsigned char* re1_hd_decode(const unsigned char* data, int size, int* out)
{
    std::vector<unsigned char> rgba;
    int w = 0, h = 0;
    if (!WebpDecodeRGBA(data, (size_t)size, &rgba, &w, &h)) return NULL;
    unsigned char* copy = (unsigned char*)malloc(rgba.size());
    if (copy == NULL) return NULL;
    memcpy(copy, rgba.data(), rgba.size());
    out[0] = w;
    out[1] = h;
    return copy;
}

}  // extern "C"

int main()
{
    return 0;
}
