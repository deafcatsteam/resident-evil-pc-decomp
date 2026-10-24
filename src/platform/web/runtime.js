// runtime.js - the page's hooks into the engine's startup (--pre-js).
//
// Module.re1Env    environment variables for the engine (e.g. RE1_DEBUGLOG,
//                  which the shell sets for ?debuglog=1; the trace goes to the
//                  console, DebugPrint.h)
// Module.re1Gate   function (start): main() does not run before start() is
//                  called - the shell's "click to play", since audio and
//                  fullscreen need a user gesture
Module.preRun = Module.preRun || [];
if (typeof Module.preRun === 'function') Module.preRun = [Module.preRun];
Module.preRun.push(function () {
    var env = Module.re1Env || {};
    for (var k in env) ENV[k] = String(env[k]);
    if (Module.re1Gate) {
        addRunDependency('re1-gate');
        Module.re1Gate(function () { removeRunDependency('re1-gate'); });
    }
});
