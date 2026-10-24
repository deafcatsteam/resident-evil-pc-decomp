# Portage Web (Emscripten)

Le jeu tourne dans un navigateur (Chrome, Firefox, Edge) au clavier ou à la manette. Le moteur est le même que celui du port Linux, compilé en WebAssembly. Les données du jeu ne sont **jamais** dans le build : la page les télécharge depuis le serveur, au fur et à mesure que le jeu les lit.

État : phase 1 (démarrage, chargement paresseux des données). Pas encore de vidéos (elles sont sautées), et les sauvegardes ne survivent pas à un rechargement de la page.

## Comment ça marche

| Pièce | Fichier |
|---|---|
| Cible CMake `if(EMSCRIPTEN)` : les sources du port Linux, plus `src/platform/web/` | `CMakeLists.txt` |
| Scheduler de tâches sur `emscripten_fiber` + Asyncify | `src/game/TaskScheduler.cpp` |
| Boucle principale cadencée par `requestAnimationFrame` | `src/platform/linux/main.cpp` (`RE1_IDLE`) |
| WebGL2 : shaders `#version 300 es` | `src/marni/MarniDX_GL.cpp` |
| Arborescence des données, téléchargée à la demande | `src/platform/web/vfs.cpp`, `vfs.js` |
| Page : écran « Cliquer pour jouer », erreurs, plein écran | `src/platform/web/shell.html`, `runtime.js` |
| Manifest des données | `tools/web/build_manifest.py` |
| Serveur de test local | `tools/web/serve_local.py` |

**Données à la demande.** Avant `main()`, la page lit `data/manifest.json` et crée sous `/re1` tous les dossiers et un fichier vide par entrée. La résolution de casse, `opendir` et l'index HD fonctionnent donc sans rien télécharger. `fopen` est intercepté (`-Wl,--wrap=fopen`) : un fichier encore distant est téléchargé à sa **première lecture**, puis libéré au `fclose`. Le navigateur le garde dans son Cache API, ce qui rend la lecture suivante locale. Un `fopen` qui sert juste à tester l'existence d'un fichier ne télécharge rien.

**Textures HD.** Il n'y a pas de threads dans le build Web : les images sont décodées sur le thread du jeu quand elles sont demandées. Le décodage asynchrone arrive en phase 3.

## Récupérer le build

Deux possibilités :

- **GitHub Actions** : le workflow « Web build » (`.github/workflows/web.yml`) tourne à chaque push sur `web-port`. Dans l'onglet *Actions* du dépôt, ouvrir la dernière exécution et télécharger l'artefact `re1-web-…`. Il contient `www/` (la page) et `tools/` (les scripts). Sur un fork, il faut d'abord activer les Actions, une seule fois, dans l'onglet *Actions*.
- **Compiler soi-même** (Linux ou WSL) :
  ```
  git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
  ~/emsdk/emsdk install 6.0.13 && ~/emsdk/emsdk activate 6.0.13
  source ~/emsdk/emsdk_env.sh
  emcmake cmake -S . -B build/web -DCMAKE_BUILD_TYPE=Release
  cmake --build build/web -j
  ```
  Le résultat se trouve dans `build/web/residentevil.{html,js,wasm}`.

## Préparer les données

Le dossier de données est la sortie du migrateur d'assets : `USA/` (obligatoire), et éventuellement `DC/`, `HD/`, `JPN/`, `SATURN/`. Après chaque modification de ce dossier, régénérer le manifest :

```
python3 tools/web/build_manifest.py ~/re1-web/data
```

Les dossiers `SAVE/` et `config.ini` à la racine de ce dossier sont ignorés : ils appartiennent au joueur, pas aux données.

## Tester en local

```
python3 tools/web/serve_local.py --data ~/re1-web/data
```

Ouvrir ensuite <http://localhost:8080/> et cliquer sur « Cliquer pour jouer ». `--build` indique le dossier de la page : par défaut `build/web` dans un checkout, ou `www/` à côté de `tools/` dans l'artefact. `--port` change le port.

Paramètres d'URL :
- `?debuglog=1` : affiche la trace du moteur (`RE1_DEBUGLOG`) dans la console du navigateur (F12).
- `?data=chemin/` : sert les données depuis un autre chemin que `data/`.

Si le jeu ne démarre pas, la console (F12) indique quel fichier a échoué. Un message `[vfs] … manifest says …` signifie que le manifest est périmé : il faut relancer `build_manifest.py`.

## Limites actuelles (phase 1)

- Les vidéos (FMV) sont sautées.
- `config.ini` et les sauvegardes vivent en mémoire : un rechargement de la page les perd. Les options sont donc celles par défaut (mode OG, HD actif si `HD/` est présent).
- Le plein écran se fait avec le bouton ⛶ en haut à droite. Sous Chrome, Échap et Ctrl restent alors au jeu.
