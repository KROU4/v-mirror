# Asset pack

[English](#english) · [Русский](#русский)

## English

V-Mirror draws V in 3D with the meshes, textures and animations of Cyberpunk 2077 itself.
Those files belong to CD PROJEKT RED, so they are **not** in this repository and **not** on the
public site. Instead, you build an *asset pack* from your own copy of the game, once, and
connect its folder in the browser. The files never leave your computer: the page reads them
straight from disk.

Without a pack the app still works: the catalog of every creator option, the photo scan,
the settings list and colour swatches are all there; only the live 3D model needs the pack.

### Quick start: one command (Windows 10/11)

Open PowerShell (Start → type "PowerShell") and run:

```powershell
irm https://krou4.github.io/v-mirror/pack.ps1 | iex
```

No git clone, no `npm install`, no flags. The script
([`public/pack.ps1`](../public/pack.ps1), published by the site and stamped with the commit the
site was built from):

1. finds Node.js 20+ and Python 3.10+; if one is missing it installs it with `winget`
   (Python 3.12 for your user; the Node.js LTS package has only a machine-wide installer, so
   Windows asks for permission once) and installs `numpy` and `Pillow` with `pip install --user`
   only when they cannot be imported;
2. downloads the V-Mirror source of that exact commit from GitHub into
   `%LOCALAPPDATA%\v-mirror\src\<commit>` (reused on the next run);
3. finds the game: GOG, Steam (every library) and Epic launcher records, then a scan of the
   fixed drives (two folder levels, plus `Games`, `Program Files`, `GOG Games`, `SteamLibrary`,
   `XboxGames`); with several installs the newest game version wins;
4. builds the pack into `Documents\V-Mirror pack`, or into `%LOCALAPPDATA%\v-mirror\pack` when
   `%USERPROFILE%\Documents` does not exist (OneDrive folder backup moves Documents into the
   OneDrive folder) or is a link into OneDrive; the script prints the folder it used. 5–10
   minutes, 560–800 MB. Run it again and a complete pack of the same version is kept as it is;
5. copies the pack path to the clipboard and opens V-Mirror with `?pack=1`: the pack panel opens
   with **Choose pack folder** highlighted. Pick the folder (Ctrl+V pastes the path into the
   folder dialog).

Nothing is uploaded, the game folder is only read, and no administrator rights are needed
(only when Node.js has to be installed, Windows asks for permission once).

Settings, as environment variables before the one-liner:

```powershell
$env:VMIRROR_GAME = 'D:\Games\Cyberpunk 2077'   # this game folder, no search
$env:VMIRROR_OUT = 'D:\v-mirror-pack'           # another pack folder
$env:VMIRROR_FORCE = '1'                        # rebuild a complete pack
$env:VMIRROR_KEEP_WORK = '1'                    # keep <pack>.work and its logs
irm https://krou4.github.io/v-mirror/pack.ps1 | iex
```

`VMIRROR_NO_BROWSER=1` leaves the clipboard and the browser alone (automated runs).

From a clone of the repository: double-click `tools\pack-windows.cmd`, or run
`powershell -NoProfile -ExecutionPolicy Bypass -File public\pack.ps1 -Source . [-Game <dir>] [-Out <dir>] [-Force] [-KeepWork] [-NoBrowser]`
(`-Source` uses the checkout instead of downloading the source).

### Manual build

Requirements:

- Windows 10/11 with Cyberpunk 2077 2.x installed (built and checked against patch 2.5, GOG).
  The game folder is only read, never written.
- Node.js 20+ and this repository (`npm install`).
- Python 3.10+ with `numpy` and `Pillow` (`pip install numpy pillow`).
- About 1.5 GB of free disk space while building; the finished pack is 560–800 MB.
- Internet access once, to download [WolvenKit](https://github.com/WolvenKit/WolvenKit) CLI 9.1.1
  from its official GitHub release (SHA-256 checked; or pass your own `--wolvenkit`).

```sh
npm run pack                                      # finds the game, writes Documents\V-Mirror pack
npm run pack -- --game "D:\Games\Cyberpunk 2077" --out "D:\v-mirror-pack"
```

| Option | Meaning |
| --- | --- |
| `--game <dir>` | game install folder (contains `archive\pc\content`); default: found as described above |
| `--out <dir>` | pack folder; empty or an older pack. Default `Documents\V-Mirror pack` (`%LOCALAPPDATA%\v-mirror\pack` when `%USERPROFILE%\Documents` does not exist or links into OneDrive) |
| `--force` | rebuild even if `--out` holds a complete pack of this version, recipe and game version |
| `--wolvenkit <exe>` | use this `WolvenKit.CLI.exe` (default: `%WOLVENKIT%`, else download into `%LOCALAPPDATA%\v-mirror\wolvenkit`) |
| `--work <dir>` | temporary folder (default `<out>.work`, deleted at the end) |
| `--keep-work`, `--skip-extract` | keep the work folder / reuse it on the next run |
| `--no-webp` | keep PNG textures instead of converting them to WebP |
| `--only <phases>` | run some phases only, e.g. `--only optimize,index --out tools/local` |
| `--python <cmd>` | Python to use (default `%PYTHON%`, `python`, `py -3`) |

A full build takes 5–10 minutes on an SSD (WolvenKit ~1 min, builders ~1.5 min, WebP 2–6 min). It ends with `pack.json` and a check against the list of
files the app expects; the command exits with code 2 if something is missing. `pack.json`
records the tool version and a hash of the recipe: a second run on a complete pack of the same
version says so and stops (`--force` rebuilds).

### Troubleshooting

- **"Running scripts is disabled on this system"** (execution policy). The one-liner
  `irm … | iex` is not affected by it. For the file itself use
  `powershell -ExecutionPolicy Bypass -File public\pack.ps1 …` or `tools\pack-windows.cmd`;
  there is no need to change the policy of the machine.
- **winget is missing** (older Windows 10, LTSC, Server): install "App Installer" from the
  Microsoft Store, or install [Node.js LTS](https://nodejs.org) and
  [Python 3.12](https://www.python.org/downloads/) (tick "Add python.exe to PATH") yourself and
  run the command again. If winget itself fails ("winget could not install …", for example the
  permission prompt was declined or there is no network), install the program from the link the
  script prints. If a fresh install is still "not found", open a new PowerShell window.
- **Antivirus.** WolvenKit CLI is downloaded from its official GitHub release and checked
  against a pinned SHA-256, but some antivirus programs quarantine or slow down mod tools. Allow
  `%LOCALAPPDATA%\v-mirror\wolvenkit` (or restore the file from quarantine) and run the command
  again.
- **Disk space.** The build needs about 1.5 GB free next to the pack folder (the work folder
  `<pack>.work` is deleted at the end); the pack is 560–800 MB. Put it on another drive with
  `$env:VMIRROR_OUT` or `--out`.
- **Game not found.** Set `$env:VMIRROR_GAME` (or `-Game` / `--game`) to the folder that
  contains `archive\pc\content` and paste the command again. A complete pack that is already
  there is kept even when the game is no longer found.
- **"N game files not found (other game version?)".** The recipe targets patch 2.x (checked on
  2.5); a much older or newer patch may lack some files.
- **Details of a failed build:** run the command again with `$env:VMIRROR_KEEP_WORK = '1'`
  (from a clone: `npm run pack -- --keep-work`) and read `<pack>.work\wolvenkit.log` and
  `<pack>.work\builders.log`.

### Connect it

Open V-Mirror and press **3D** in the header (or use the panel shown instead of the 3D scene),
then **Choose pack folder** and pick the pack folder (or its parent folder). Chrome and Edge
remember the folder; on the next visit one click restores it. Firefox and Safari have no
folder handles, so they ask for the folder on every visit.

### What is inside

```
pack.json            {format: 1, gameVersion, createdAt, files, bytes, tool, recipe}
                     (recipe: hash of the recipe and builders; a re-run keeps a complete pack
                     only when tool and recipe match)
glb/                 head morph targets (head, eyes, brows) and teeth for both body types
hair/                every hairstyle mesh + app_to_mesh.json, hint_meshes*.json, index.json
hair/beards/         beard meshes with head morph targets (male V)
glb/face/decals/     head layers: makeup (eyes, lips, cheeks), freckles/blemishes, face tattoos,
                     scars, face cyberware (decal meshes with the head morph targets) and piercings
tex/skin|face|hair/  skin tones, eyes, lashes, brows, teeth, hair cards/caps/profiles + manifest.json each
                     (tex/hair/manifest.json also lists the beard styles and colours under "beards";
                     tex/face/decals.json maps creator rows to the layer meshes, chunks and materials)
body/                body, arms, nails, legs, animations, skeletons, joints, manifest.json
body/intimate/       nipples, genitals, pubic hair, body tattoos and scars + intimate.json
swatches/            creator colour thumbnails (when tools/extract/build_swatches.py is present)
```

Manifests use paths relative to the pack root; the app loads every file through
`src/assets/pack.ts` (`gameAssetUrl`, `fetchGameJson`, `hasGameAsset`).

### How the build works

`tools/extract/pack.mjs` runs these phases:

1. **extract** — computes the game resource id (FNV-1a 64 of the lower-cased path) of every
   file listed in `tools/extract/pack/recipe.json` and lets WolvenKit pull exactly those files
   out of the `.archive` files (`extract --hash`).
2. **export** — textures to PNG, meshes/morph targets/animations to glTF, material files to JSON.
3. **inputs** — lays the exports out the way the builders read them, plus the derived metadata
   in `tools/extract/pack/data/*.json.gz` (material analyses, colour maps; no pixels or meshes).
4. **meshes** — copies head/body/hair meshes, cuts the creator animations out of the UI clips,
   writes joint reports.
5. **build** — the Python builders in `tools/extract/pack/builders/` bake skin tones,
   multilayer materials (eyes, nails, teeth, accessories), hair cards and gradients, convert
   normal maps to OpenGL and write the manifests.
6. **swatches** — `tools/extract/build_swatches.py` crops the creator colour thumbnails.
7. **optimize** — PNG textures named by a manifest become lossless WebP (pixel-exact,
   including RGB under transparent pixels) when that saves space; manifests are rewritten.
8. **index** — writes `pack.json` and checks the result.

The recipe was produced by tracing the original extraction once and is verified by rebuilding
the pack from the game and comparing it file by file with the reference pack (pixels for
images, parsed JSON for manifests).

### Development

`npm run dev` serves `tools/local` (if it exists) at `/game/...` and the app uses it without
asking for a folder. Build a dev pack with `npm run pack -- --game <dir> --out tools/local`, or
point the dev server at another pack: `VM_PACK_DIR=D:\v-mirror-pack npm run dev`.

### Never in git, never on the site

`.gitignore` excludes `tools/local/`, work folders and every game file format. `npm run build`
ends with `npm run audit:dist`, which fails if `dist/` contains a mesh or game texture format,
an asset-pack folder, an unexpected image, or a byte copy of any file of the local pack.

## Русский

V-Mirror рисует V в 3D мешами, текстурами и анимациями самой Cyberpunk 2077. Это файлы
CD PROJEKT RED, поэтому их **нет** ни в репозитории, ни на публичном сайте. Вместо этого вы один
раз собираете *набор ассетов* (asset pack) из своей копии игры и подключаете его папку в
браузере. Файлы не покидают компьютер: страница читает их прямо с диска.

Без набора приложение тоже работает: каталог всех настроек редактора, скан фотографии, список
настроек и образцы цветов на месте; набор нужен только живой 3D-модели.

### Быстрый старт: одна команда (Windows 10/11)

Откройте PowerShell (Пуск → наберите «PowerShell») и выполните:

```powershell
irm https://krou4.github.io/v-mirror/pack.ps1 | iex
```

Без git clone, без `npm install`, без параметров. Скрипт
([`public/pack.ps1`](../public/pack.ps1) публикуется вместе с сайтом, и сборка сайта вписывает в
него коммит, из которого сайт собран):

1. находит Node.js 20+ и Python 3.10+; если чего-то нет, ставит через `winget` (Python 3.12 —
   для вашего пользователя; у пакета Node.js LTS есть только установщик для всего компьютера,
   поэтому Windows один раз спросит разрешение), а `numpy` и `Pillow` ставит через
   `pip install --user`, только если они не импортируются;
2. скачивает исходники V-Mirror ровно этого коммита с GitHub в
   `%LOCALAPPDATA%\v-mirror\src\<коммит>` (при следующем запуске берёт оттуда);
3. находит игру: записи GOG, Steam (все библиотеки) и Epic, затем просмотр несъёмных дисков (два
   уровня папок, плюс `Games`, `Program Files`, `GOG Games`, `SteamLibrary`, `XboxGames`); если
   установок несколько, берёт самую новую версию игры;
4. собирает набор в `Документы\V-Mirror pack` (`Documents\V-Mirror pack`), а если папки
   `%USERPROFILE%\Documents` нет (резервное копирование папок OneDrive переносит «Документы» в
   папку OneDrive) или она ссылается в OneDrive — в `%LOCALAPPDATA%\v-mirror\pack`; скрипт
   печатает, какую папку взял. 5–10 минут, 560–800 МБ. Повторный запуск не пересобирает готовый
   набор той же версии;
5. копирует путь к набору в буфер обмена и открывает V-Mirror с `?pack=1`: сразу открывается
   панель набора с подсвеченной кнопкой **«Выбрать папку набора»**. Выберите папку (путь
   вставляется в окно выбора через Ctrl+V).

В интернет ничего не загружается, папка игры только читается, права администратора не нужны
(только если нужно поставить Node.js, Windows один раз спросит разрешение).

Настройки — переменными окружения перед командой:

```powershell
$env:VMIRROR_GAME = 'D:\Games\Cyberpunk 2077'   # эта папка игры, без поиска
$env:VMIRROR_OUT = 'D:\v-mirror-pack'           # другая папка набора
$env:VMIRROR_FORCE = '1'                        # пересобрать готовый набор
$env:VMIRROR_KEEP_WORK = '1'                    # оставить <набор>.work с журналами
irm https://krou4.github.io/v-mirror/pack.ps1 | iex
```

`VMIRROR_NO_BROWSER=1` не трогает буфер обмена и не открывает браузер (автоматические запуски).

Из клона репозитория: дважды щёлкните `tools\pack-windows.cmd` или выполните
`powershell -NoProfile -ExecutionPolicy Bypass -File public\pack.ps1 -Source . [-Game <папка>] [-Out <папка>] [-Force] [-KeepWork] [-NoBrowser]`
(`-Source` берёт исходники из клона, а не скачивает их).

### Ручная сборка

Что нужно:

- Windows 10/11 и установленная Cyberpunk 2077 2.x (собрано и проверено на патче 2.5, GOG).
  Папка игры только читается.
- Node.js 20+ и этот репозиторий (`npm install`).
- Python 3.10+ с `numpy` и `Pillow` (`pip install numpy pillow`).
- Около 1,5 ГБ свободного места на время сборки; готовый набор весит 560–800 МБ.
- Один раз интернет, чтобы скачать CLI [WolvenKit](https://github.com/WolvenKit/WolvenKit) 9.1.1
  с официальной страницы релизов (с проверкой SHA-256; или укажите свой `--wolvenkit`).

```sh
npm run pack                                      # сам найдёт игру, набор — в Documents\V-Mirror pack
npm run pack -- --game "D:\Games\Cyberpunk 2077" --out "D:\v-mirror-pack"
```

Параметры — в таблице выше: `--game` (папка игры, по умолчанию ищется), `--out` (папка набора,
пустая или старый набор; по умолчанию `Documents\V-Mirror pack`, без папки Documents —
`%LOCALAPPDATA%\v-mirror\pack`), `--force` (пересобрать готовый
набор), `--wolvenkit`, `--work`, `--keep-work`, `--skip-extract`, `--no-webp`, `--only`, `--python`.
Полная сборка на SSD идёт 5–10 минут и заканчивается файлом `pack.json` и сверкой со списком файлов,
которые ждёт приложение; если чего-то не хватает, команда завершается с кодом 2. В `pack.json`
записаны версия инструмента и хеш рецепта (поле `recipe`): повторный запуск на готовом наборе той же версии
сообщает об этом и ничего не делает.

### Если что-то не так

- **«Выполнение сценариев отключено в этой системе»** (политика выполнения). На команду
  `irm … | iex` она не влияет. Файл запускайте через
  `powershell -ExecutionPolicy Bypass -File public\pack.ps1 …` или `tools\pack-windows.cmd`;
  менять политику для всего компьютера не нужно.
- **Нет winget** (старая Windows 10, LTSC, Server): поставьте «Установщик приложений» (App
  Installer) из Microsoft Store или сами установите [Node.js LTS](https://nodejs.org) и
  [Python 3.12](https://www.python.org/downloads/) (галочка «Add python.exe to PATH»), затем
  запустите команду снова. Если ошибся сам winget («winget не смог установить …», например
  отказались в окне разрешения или нет сети), установите программу по ссылке, которую напечатал
  скрипт. Если только что установленная программа «не найдена», откройте новое окно PowerShell.
- **Антивирус.** CLI WolvenKit скачивается с официальной страницы релизов и сверяется с
  закреплённым SHA-256, но некоторые антивирусы помещают инструменты для модов в карантин или
  тормозят их. Разрешите `%LOCALAPPDATA%\v-mirror\wolvenkit` (или верните файл из карантина) и
  запустите команду снова.
- **Место на диске.** На время сборки нужно около 1,5 ГБ рядом с папкой набора (рабочая папка
  `<набор>.work` в конце удаляется); сам набор — 560–800 МБ. Другой диск: `$env:VMIRROR_OUT` или
  `--out`.
- **Игра не найдена.** Укажите в `$env:VMIRROR_GAME` (или `-Game` / `--game`) папку, в которой
  есть `archive\pc\content`, и вставьте команду ещё раз. Уже готовый полный набор остаётся как
  есть, даже если игра больше не находится.
- **«N game files not found (other game version?)».** Рецепт рассчитан на патч 2.x (проверен на
  2.5); в сильно старшем или младшем патче части файлов может не быть.
- **Подробности неудачной сборки:** запустите команду снова с `$env:VMIRROR_KEEP_WORK = '1'`
  (из клона: `npm run pack -- --keep-work`), затем смотрите `<набор>.work\wolvenkit.log` и
  `<набор>.work\builders.log`.

### Подключение

Откройте V-Mirror, нажмите **3D** в шапке (или воспользуйтесь панелью на месте 3D-сцены), затем
**«Выбрать папку набора»** и укажите папку набора (или папку, в которой он лежит). Chrome и Edge
запоминают папку, при следующем визите её возвращает один клик. Firefox и Safari не умеют
хранить доступ к папке и спрашивают её каждый раз.

### Что внутри и как собирается

Состав папок и восемь фаз сборки (extract, export, inputs, meshes, build, swatches, optimize,
index) описаны в английском разделе. Коротко: WolvenKit достаёт из архивов игры ровно те файлы,
что перечислены в `tools/extract/pack/recipe.json` (по хешу FNV-1a 64 от пути), выгружает
текстуры в PNG, меши и анимации в glTF, материалы в JSON; Python-сборщики из
`tools/extract/pack/builders/` запекают тона кожи, многослойные материалы, карточки и градиенты
волос и пишут манифесты; затем PNG, на которые ссылаются манифесты, без потерь пересохраняются
в WebP, а манифесты обновляются.

Рецепт получен трассировкой исходной выгрузки и проверен пересборкой набора из игры с
пофайловым сравнением с эталоном (пиксели для картинок, разобранный JSON для манифестов).

### Разработка

`npm run dev` отдаёт `tools/local` (если папка есть) по адресу `/game/...`, и приложение
пользуется им без выбора папки. Собрать такой набор: `npm run pack -- --game <папка игры> --out tools/local`;
подключить другой: `VM_PACK_DIR=D:\v-mirror-pack npm run dev`.

### Ни в git, ни на сайт

`.gitignore` исключает `tools/local/`, рабочие папки и все форматы файлов игры. `npm run build`
завершается проверкой `npm run audit:dist`: она падает, если в `dist/` попал меш или формат
текстур игры, папка набора, лишняя картинка или побайтовая копия любого файла локального набора.
