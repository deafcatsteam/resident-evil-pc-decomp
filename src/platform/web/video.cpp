// video.cpp - FMV backend for the web build (platform.h, plat_video_*).
//
// Phase 0 placeholder: no decoder yet, so plat_video_init reports "no FMV"
// and VideoPlayback.cpp skips every movie, exactly as a build without the
// movie files does. The <video>-element backend replaces this (docs/WEB_PORT.md).
#include "../platform.h"

static PlatVideoOverlayCallback s_overlay = NULL;

void plat_video_set_overlay_callback(PlatVideoOverlayCallback callback)
{
    s_overlay = callback;
}

BOOL plat_video_init(void)
{
    return FALSE;
}

BOOL plat_video_open_and_play(const char* path, int playToMs)
{
    (void)path;
    (void)playToMs;
    return FALSE;
}

int plat_video_probe_duration_ms(const char* path)
{
    (void)path;
    return 0;
}

void plat_video_play_from(int fromMs)
{
    (void)fromMs;
}

void plat_video_stop(void) {}
void plat_video_close(void) {}

BOOL plat_video_is_active(void)
{
    return FALSE;
}

BOOL plat_video_take_end_event(void)
{
    return FALSE;
}

void plat_video_tick(void) {}
void plat_video_set_window_mode(BOOL forVideo)
{
    (void)forVideo;
}
