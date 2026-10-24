// vfs.cpp - the web build's game root in the virtual file system.
//
// plat_exe_dir() is "/re1" on the web (platform.cpp): config.ini, the save
// folder and the data tree all resolve against it. Phase 0 only creates the
// directory, so the engine starts and reports the missing data the way a
// native build without assets does. The lazy, manifest-driven data tree is
// mounted here in Phase 1 (docs/WEB_PORT.md).
#include <sys/stat.h>

__attribute__((constructor)) static void WebVfs_CreateRoot(void)
{
    mkdir("/re1", 0777);
}
