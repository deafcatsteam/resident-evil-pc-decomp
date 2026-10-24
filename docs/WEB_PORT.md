# Portage Web (Emscripten)

Le jeu tourne dans un navigateur (Chrome, Firefox, Edge) au clavier ou à la manette. Le moteur est le même que celui du port Linux, compilé en WebAssembly. Les données du jeu ne sont **jamais** dans le build : la page les télécharge depuis le serveur, au fur et à mesure que le jeu les lit.

État : complet côté code (phases 0 à 4) ; reste à valider avec les vraies données (checklist en fin de page).

## Comment ça marche

| Pièce | Fichier |
|---|---|
| Cible CMake `if(EMSCRIPTEN)` : les sources du port Linux, plus `src/platform/web/` | `CMakeLists.txt` |
| Scheduler de tâches sur `emscripten_fiber` + Asyncify | `src/game/TaskScheduler.cpp` |
| Boucle principale cadencée par `requestAnimationFrame` | `src/platform/linux/main.cpp` (`RE1_IDLE`) |
| WebGL2 : shaders `#version 300 es` | `src/marni/MarniDX_GL.cpp` |
| Arborescence des données, téléchargée à la demande | `src/platform/web/vfs.cpp`, `vfs.js` |
| Vidéos : `<video>` caché, image copiée dans une texture GL à chaque frame | `src/platform/web/video.cpp`, `video.js` |
| Sauvegardes et `config.ini` : WebDAV + IndexedDB | `src/platform/web/persist.js`, `vfs.cpp` |
| Décodage HD dans 2 Web Workers | `src/platform/web/hd.js`, `hd_worker.cpp`, `hd_worker_post.js`, `src/system/HdTextures.cpp` |
| Page : écran « Cliquer pour jouer », erreurs, plein écran | `src/platform/web/shell.html`, `runtime.js` |
| Manifest des données | `tools/web/build_manifest.py` |
| Serveur de test local | `tools/web/serve_local.py` |
| Déploiement : copie vers le serveur, configuration Caddy | `tools/web/deploy.sh`, `deploy/Caddyfile.example` |

**Données à la demande.** Avant `main()`, la page lit `data/manifest.json` et crée sous `/re1` tous les dossiers et un fichier vide par entrée. La résolution de casse, `opendir` et l'index HD fonctionnent donc sans rien télécharger. `fopen` est intercepté (`-Wl,--wrap=fopen`) : un fichier encore distant est téléchargé à sa **première lecture**, puis libéré au `fclose`. Le navigateur le garde dans son Cache API, ce qui rend la lecture suivante locale. Un `fopen` qui sert juste à tester l'existence d'un fichier ne télécharge rien.

**Préchargement du stage.** Dès que le jeu lit un fichier d'un dossier `Stage<n>/` (hors `HD/`), le reste de ce dossier est mis dans le Cache API en tâche de fond. Il y a au plus deux requêtes à la fois, et seulement quand le jeu n'attend rien. Les portes suivantes s'ouvrent ainsi sans aller-retour au serveur.

**Vidéos.** Le navigateur décode lui-même : la vidéo est lue en streaming depuis le serveur (requêtes Range), son compris, et chaque image est copiée dans une texture puis dessinée comme sous Linux. Les sous-titres PS1 et les crédits DC restent donc par-dessus. Il faut des `.mp4` (H.264/AAC) : le jeu les préfère déjà à l'`.avi`, mais aucun navigateur ne lit le Cinepak. Une vidéo qui n'existe qu'en `.avi` est sautée, avec un message dans la console. Le migrateur d'assets produit ces `.mp4` (onglet PC, option AVI→MP4 ; l'onglet Director's Cut et le pack HD en font toujours).

**Sauvegardes.** Sont conservés `config.ini` et tout le dossier `SAVE/` (`savedat*.dat`, `bonus.dat`, `batrank.dat`). Avant `main()`, la page les relit depuis le dossier WebDAV `saves/` du serveur. Chaque fichier écrit par le jeu y est renvoyé dès sa fermeture (le `fopen` intercepté s'en charge), avec une copie dans IndexedDB. Si le serveur ne répond pas, la sauvegarde reste dans le navigateur et part au démarrage suivant ; le coin bas gauche de la page le signale. Fermer l'onglet pendant un envoi déclenche une confirmation, et « Relancer » (APPLY AND RESTART) attend la fin des envois avant de recharger la page. Sans WebDAV du tout, seul IndexedDB est utilisé : les sauvegardes restent alors propres à ce navigateur.

**`config.ini` de départ.** S'il n'existe encore ni sur le serveur ni dans le navigateur, la page prend `data/config.ini` (à côté de `manifest.json`, qui l'ignore) comme point de départ. Exemple pour le Director's Cut avec le HD :
```ini
[Game]
Mode=DC
Ps1EndingCredits=1

[Textures]
HdTextures=1
```
Ensuite, c'est la copie du joueur qui compte : les changements faits dans OPTIONS sont conservés.

**Textures HD.** Il n'y a pas de threads dans le build Web : la page n'en a pas besoin, ce qui évite d'exiger les en-têtes COOP/COEP du serveur. Les images HD qu'une salle demande en arrivant sont décodées par deux Web Workers, `re1_hd_worker.js`/`.wasm`. Ce petit module, compilé à part, contient le même décodeur WebP que le jeu natif, donc les pixels sont identiques. Le jeu récupère les images au fil des frames. Si le worker ne se charge pas, le décodage se fait sur le thread du jeu, plus lentement mais sans rien casser ; la console l'indique.

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
  Le résultat se trouve dans `build/web` : `residentevil.{html,js,wasm}` et `re1_hd_worker.{js,wasm}`.

## Préparer les données

Le dossier de données est la sortie du migrateur d'assets : `USA/` (obligatoire), et éventuellement `DC/`, `HD/`, `JPN/`, `SATURN/`. Après chaque modification de ce dossier, régénérer le manifest :

```
python3 tools/web/build_manifest.py ~/re1-web/data
```

Les dossiers `SAVE/` et `config.ini` à la racine de ce dossier sont ignorés par le manifest. Un `config.ini` placé là sert de configuration de départ (voir plus haut).

## Tester en local

```
python3 tools/web/serve_local.py --data ~/re1-web/data
```

Ouvrir ensuite <http://localhost:8080/> et cliquer sur « Cliquer pour jouer ». `--build` indique le dossier de la page : par défaut `build/web` dans un checkout, ou `www/` à côté de `tools/` dans l'artefact. `--port` change le port (si 8080 est déjà pris, le script le dit). Le serveur local gère aussi les sauvegardes, en WebDAV simplifié, dans `~/re1-web/saves` (`--saves` pour un autre dossier), ainsi que les requêtes Range dont les vidéos ont besoin.

Paramètres d'URL :
- `?debuglog=1` : affiche la trace du moteur (`RE1_DEBUGLOG`) dans la console du navigateur (F12).
- `?data=chemin/` : sert les données depuis un autre chemin que `data/`.
- `?saves=chemin/` : dossier WebDAV des sauvegardes, à la place de `saves/`.

Si le jeu ne démarre pas, la console (F12) indique quel fichier a échoué. Un message `[vfs] … manifest says …` signifie que le manifest est périmé : il faut relancer `build_manifest.py`.

## Déploiement (Caddy)

Organisation sur le serveur :
```
/srv/re1/www/           index.html, residentevil.js/.wasm, re1_hd_worker.js/.wasm
/srv/re1/www/data/      USA/ DC/ HD/ …, manifest.json, config.ini (facultatif)
/srv/re1/saves/<login>/ sauvegardes et config.ini de chaque joueur (WebDAV)
```

1. **Caddy avec WebDAV.** Le module n'est pas dans Caddy de base :
   ```
   caddy add-package github.com/mholt/caddy-webdav
   ```
   Ou bien `xcaddy build --with github.com/mholt/caddy-webdav`. `caddy list-modules | grep webdav` doit afficher `http.handlers.webdav`.
2. **Mot de passe.** `caddy hash-password` donne le hash à mettre dans `basic_auth`, avec une ligne par joueur.
3. **Dossier de sauvegarde.** Créer un dossier par login, appartenant à l'utilisateur sous lequel tourne Caddy :
   ```
   mkdir -p /srv/re1/saves/<login> && chown -R caddy:caddy /srv/re1/saves
   ```
   Le dossier porte le nom du login (`{http.auth.user.id}`). Sans ce dossier, la page passe en mode « ce navigateur uniquement ».
4. **Caddyfile.** Partir de `deploy/Caddyfile.example` : remplacer le domaine et le hash, puis lancer `caddy validate` et recharger Caddy. Il met en place :
   - l'accès par mot de passe ;
   - le cache permanent pour les URL `?v=` ;
   - `no-cache` pour le reste ;
   - la compression ;
   - le WebDAV sur `/saves/`.
   Les requêtes Range des vidéos sont gérées par `file_server`.
5. **Envoi du jeu et des données** depuis la machine qui a les données :
   ```
   tools/web/deploy.sh --data ~/re1-web/data moi@serveur:/srv/re1
   ```
   Le script régénère le manifest, envoie le moteur, puis les données. Le manifest part en dernier, pour qu'une page ouverte entre-temps ne réclame jamais un fichier pas encore arrivé. `saves/` n'est jamais touché. Pour mettre à jour le moteur seul, ajouter `--no-data`. Dans l'artefact CI, le script se trouve dans `tools/deploy.sh`.

Testé dans le conteneur avec Caddy 2.10.2 + caddy-webdav : 401 sans identifiants, requêtes Range, cache permanent, sauvegardes par login, création de `SAVE/` (MKCOL).

## Checklist de validation

À faire avec les vraies données, en local (`serve_local.py`) puis sur le serveur :

- [ ] Logo Capcom et vidéo d'ouverture, avec le son.
- [ ] NEW GAME avec Jill : l'ouverture coupe bien la scène de Chris.
- [ ] Entrée dans une salle en HD : pas de saccade notable, les fonds et les masques sont corrects.
- [ ] Passages de porte : rapides une fois le stage préchargé.
- [ ] Sauvegarde à la machine à écrire, F5, puis LOAD GAME.
- [ ] Même chose depuis un autre appareil (serveur uniquement).
- [ ] OPTIONS > GAME : passer en DC puis APPLY AND RESTART. Vérifier les sous-titres PS1 et les crédits de fin PS1.
- [ ] Polices HD sur le menu titre et dans les textes.
- [ ] Manette, et plein écran (bouton ⛶) avec Ctrl qui ne ferme pas l'onglet.

## Limites actuelles

- Le plein écran se fait avec le bouton ⛶ en haut à droite. Sous Chrome, Échap et Ctrl restent alors au jeu. L'option plein écran du menu DISPLAY dépend de ce que le navigateur autorise.
- Une texture HD que le jeu réclame sans l'avoir préchargée est décodée sur le thread du jeu (c'est aussi le cas en natif).
