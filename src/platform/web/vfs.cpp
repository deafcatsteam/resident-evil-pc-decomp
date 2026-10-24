// vfs.cpp - the web build's game root and its lazily fetched data tree.
//
// plat_exe_dir() is "/re1" on the web (platform.cpp): config.ini, the save
// folder and the data tree all resolve against it, exactly as they resolve
// against the executable's folder natively.
//
// The data tree (USA/, DC/, HD/, ... as the asset migrator writes it) is not
// downloaded up front: it is ~2 GB with the HD pack, and a session touches a
// small part of it. web/vfs.js reads data/manifest.json before main() and
// creates every directory and an EMPTY placeholder for every file in MEMFS.
// The tree is therefore complete for everything that only looks at names -
// plat_normalize_path's case matching, plat_dir_list (the HD index), opendir -
// and nothing has been fetched.
//
// The game reads every file through fopen (plat_file_read_all included), so
// fopen is wrapped (-Wl,--wrap=fopen). A read-mode open of a placeholder
// returns a cookie stream that knows the file's real size from the manifest;
// the bytes are fetched on the first read, through Asyncify (the caller is
// often a task, i.e. a fiber - TaskScheduler.cpp), and dropped on fclose. An
// fopen used as an existence probe (AssetPath.cpp, HdTextures.cpp) therefore
// costs nothing, and the browser's Cache API, not the wasm heap, keeps what
// was already downloaded. Any write-mode open turns the placeholder into an
// ordinary MEMFS file.
#ifndef _GNU_SOURCE
#define _GNU_SOURCE   // fopencookie
#endif
#include <emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

// The real size of `path` when it is a placeholder still to be fetched, else -1.
EM_JS(int, web_vfs_remote_size, (const char* path), {
    return Module.re1Vfs ? Module.re1Vfs.remoteSize(UTF8ToString(path)) : -1;
});

// A write-mode open: the file's content is the game's from now on.
EM_JS(void, web_vfs_forget, (const char* path), {
    if (Module.re1Vfs) Module.re1Vfs.forget(UTF8ToString(path));
});

// Fetch `path` into dst[0..size). Returns the byte count, or -1.
EM_ASYNC_JS(int, web_vfs_fetch, (const char* path, unsigned char* dst, int size), {
    return await Module.re1Vfs.fetchInto(UTF8ToString(path), dst, size);
});

namespace {

struct RemoteFile {
    unsigned char* data;   // NULL until the first read
    long size;
    long pos;
    char path[1];          // the rest of the allocation
};

ssize_t remote_read(void* cookie, char* buf, size_t len)
{
    RemoteFile* f = (RemoteFile*)cookie;
    if (f->data == NULL && f->size > 0) {
        f->data = (unsigned char*)malloc((size_t)f->size);
        if (f->data == NULL) return -1;
        if (web_vfs_fetch(f->path, f->data, (int)f->size) != (int)f->size) {
            free(f->data);
            f->data = NULL;
            return -1;
        }
    }
    long left = f->size - f->pos;
    if (left <= 0) return 0;
    if ((long)len > left) len = (size_t)left;
    memcpy(buf, f->data + f->pos, len);
    f->pos += (long)len;
    return (ssize_t)len;
}

int remote_seek(void* cookie, off_t* offset, int whence)
{
    RemoteFile* f = (RemoteFile*)cookie;
    long base = (whence == SEEK_SET) ? 0 : (whence == SEEK_CUR) ? f->pos : f->size;
    long to = base + (long)*offset;
    if (to < 0) return -1;
    f->pos = to;
    *offset = (off_t)to;
    return 0;
}

int remote_close(void* cookie)
{
    RemoteFile* f = (RemoteFile*)cookie;
    free(f->data);
    free(f);
    return 0;
}

}  // namespace

extern "C" FILE* __real_fopen(const char* path, const char* mode);

extern "C" FILE* __wrap_fopen(const char* path, const char* mode)
{
    if (path == NULL || mode == NULL) return __real_fopen(path, mode);
    if (mode[0] != 'r' || strchr(mode, '+') != NULL) {
        web_vfs_forget(path);
        return __real_fopen(path, mode);
    }
    int size = web_vfs_remote_size(path);
    if (size < 0) return __real_fopen(path, mode);

    size_t len = strlen(path);
    RemoteFile* f = (RemoteFile*)malloc(sizeof(RemoteFile) + len);
    if (f == NULL) return NULL;
    f->data = NULL;
    f->size = size;
    f->pos = 0;
    memcpy(f->path, path, len + 1);

    cookie_io_functions_t io = { remote_read, NULL, remote_seek, remote_close };
    FILE* stream = fopencookie(f, mode, io);
    if (stream == NULL) free(f);
    return stream;
}

__attribute__((constructor)) static void WebVfs_CreateRoot(void)
{
    // vfs.js has normally made it already (the tree is mounted in preRun);
    // without a data tree the engine still starts and reports what is missing.
    mkdir("/re1", 0777);
    chdir("/re1");
}
