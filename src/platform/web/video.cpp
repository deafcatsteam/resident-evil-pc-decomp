// video.cpp - FMV backend for the web build (platform.h, plat_video_*).
//
// The browser decodes: web/video.js plays the movie in a hidden <video>
// element, sound included, streamed from the server. Each tick the element's
// current picture is copied into a MarniDX texture (texImage2D takes the
// element directly, no pixel round trip through the heap) and drawn exactly as
// the Linux backend draws its ffmpeg frames - after the overlay callback, so
// the PS1 subtitles and the DC ending credits keep working.
//
// The clock is the element's currentTime. The movie must be one the browser
// plays: H.264/AAC .mp4, which the asset migrator writes beside (or instead
// of) the Cinepak .avi; VideoPlayback.cpp already prefers the .mp4. A movie
// that does not open is skipped, as natively.
#include "../platform.h"

#include "../../marni/MarniDX.h"
#include "../../marni/MarniSystem.h"

#include <emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Load `path` and start it; the picture size on success, 0 on failure.
EM_ASYNC_JS(int, web_video_open, (const char* path, int playToMs, int* outW, int* outH), {
    var ok = await Module.re1Video.open(UTF8ToString(path), playToMs);
    if (!ok) return 0;
    var el = Module.re1Video.el;
    HEAP32[outW >> 2] = el.videoWidth;
    HEAP32[outH >> 2] = el.videoHeight;
    return 1;
});

EM_ASYNC_JS(int, web_video_probe, (const char* path), {
    return await Module.re1Video.probe(UTF8ToString(path));
});

EM_ASYNC_JS(void, web_video_seek_and_play, (int fromMs), {
    await Module.re1Video.seek(fromMs);
    Module.re1Video.playToMs = 0;
    Module.re1Video.start();
});

EM_JS(void, web_video_pause, (void), {
    if (Module.re1Video.el) Module.re1Video.el.pause();
});

EM_JS(void, web_video_release, (void), {
    Module.re1Video.release();
});

// Current stream time in ms; sets *ended once the movie (or the segment
// before playToMs) is over.
EM_JS(int, web_video_time, (int* ended), {
    var v = Module.re1Video;
    var ms = v.el ? Math.round(v.el.currentTime * 1000) : 0;
    var over = v.ended || (v.playToMs > 0 && ms >= v.playToMs);
    if (over && v.el && !v.el.paused) v.el.pause();
    HEAP32[ended >> 2] = over ? 1 : 0;
    return ms;
});

// Copy the element's current picture into GL texture `name`. FALSE while the
// element has no picture yet.
EM_JS(int, web_video_upload, (unsigned int name), {
    var el = Module.re1Video.el;
    if (!el || el.readyState < 2 || !GL.textures[name]) return 0;
    GLctx.bindTexture(GLctx.TEXTURE_2D, GL.textures[name]);
    GLctx.texImage2D(GLctx.TEXTURE_2D, 0, GLctx.RGBA, GLctx.RGBA, GLctx.UNSIGNED_BYTE, el);
    GLctx.bindTexture(GLctx.TEXTURE_2D, null);
    return 1;
});

namespace {

PlatVideoOverlayCallback s_overlayCallback = NULL;

MarniHandle s_tex    = MARNI_NULL_HANDLE;
BOOL        s_open   = FALSE;   // a movie is loaded in the element
BOOL        s_active = FALSE;
BOOL        s_endEvent = FALSE;

void DestroyTex(void)
{
    if (s_tex != MARNI_NULL_HANDLE) {
        MarniDX* dx = Marni_DX();
        if (dx != NULL) dx->DestroyTexture(s_tex);
        s_tex = MARNI_NULL_HANDLE;
    }
}

void Present(int frameMs)
{
    MarniDX* dx = Marni_DX();
    if (dx == NULL || s_tex == MARNI_NULL_HANDLE) return;
    web_video_upload(dx->GLTextureName(s_tex));

    DWORD bw = 0, bh = 0;
    dx->GetBackBufferSize(&bw, &bh);
    if (bw == 0 || bh == 0) return;

    dx->Clear(0.0f, 0.0f, 0.0f, 1.0f);
    if (s_overlayCallback == NULL || !s_overlayCallback(s_tex, frameMs)) {
        dx->DrawSprite(0.0f, 0.0f, (float)bw, (float)bh,
                       0.0f, 0.0f, 1.0f, 1.0f,
                       0xFFFFFFFFu, s_tex, MARNI_SAMPLER_POINT, MARNI_BLEND_DISABLE);
    }
    dx->Present();
}

}  // namespace

void plat_video_set_overlay_callback(PlatVideoOverlayCallback callback)
{
    s_overlayCallback = callback;
}

BOOL plat_video_init(void)
{
    return TRUE;   // every browser the build targets has <video> with H.264
}

BOOL plat_video_open_and_play(const char* path, int playToMs)
{
    plat_video_close();

    // A Cinepak .avi is what is left when no .mp4 was made: no browser plays it.
    const char* dot = strrchr(path, '.');
    if (dot != NULL && strcasecmp(dot, ".avi") == 0) {
        fprintf(stderr, "[VIDEO] %s: the browser cannot play .avi - convert the movies "
                        "to .mp4 (asset migrator)\n", path);
        return FALSE;
    }

    int w = 0, h = 0;
    if (!web_video_open(path, playToMs, &w, &h) || w <= 0 || h <= 0) {
        return FALSE;
    }

    MarniDX* dx = Marni_DX();
    if (dx != NULL) {
        // The texture is created at the picture's size; its pixels come from
        // the element on every frame.
        unsigned char* black = (unsigned char*)calloc((size_t)w * h, 4);
        if (black != NULL) {
            s_tex = dx->CreateTexture(w, h, 32, black, NULL, NULL);
            free(black);
        }
    }
    if (s_tex == MARNI_NULL_HANDLE) {
        web_video_release();
        return FALSE;
    }

    s_open = TRUE;
    s_active = TRUE;
    s_endEvent = FALSE;
    fprintf(stderr, "[VIDEO] playing %s (%dx%d)\n", path, w, h);
    return TRUE;
}

int plat_video_probe_duration_ms(const char* path)
{
    return web_video_probe(path);
}

void plat_video_play_from(int fromMs)
{
    if (!s_open) return;
    web_video_seek_and_play(fromMs);
    s_endEvent = FALSE;
    s_active = TRUE;
}

void plat_video_stop(void)
{
    if (s_open) web_video_pause();
    s_active = FALSE;
}

void plat_video_close(void)
{
    if (s_open) web_video_release();
    DestroyTex();
    s_open = FALSE;
    s_active = FALSE;
    s_endEvent = FALSE;
}

BOOL plat_video_is_active(void)
{
    return s_active;
}

BOOL plat_video_take_end_event(void)
{
    if (!s_endEvent) return FALSE;
    s_endEvent = FALSE;
    return TRUE;
}

void plat_video_tick(void)
{
    if (!s_active) return;
    int ended = 0;
    const int ms = web_video_time(&ended);
    Present(ms);
    if (ended) {
        s_active = FALSE;
        s_endEvent = TRUE;
    }
}

void plat_video_set_window_mode(BOOL forVideo)
{
    (void)forVideo;
}
