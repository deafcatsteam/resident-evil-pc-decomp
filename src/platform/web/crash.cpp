// crash.cpp - crash diagnostics for the web build.
//
// Counterpart of src/platform/linux/crash.cpp. A WebAssembly trap is not a
// signal: the browser reports it, with a symbolized wasm stack, as an uncaught
// exception in the console, and web/shell.html shows it to the player. So
// there is nothing to install; the step marks go to the console so the same
// breadcrumbs as crash.log are visible there.
#include "../platform.h"

#include <stdio.h>

void crashlog_install(void)
{
}

void crashlog_mark(const char* step)
{
    if (step == NULL) return;
    fprintf(stderr, "[step] %s\n", step);
}
