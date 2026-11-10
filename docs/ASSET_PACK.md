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

### Requirements

- Windows 10/11 with Cyberpunk 2077 2.x installed (built and checked against patch 2.5, GOG).
  The game folder is only read, never written.
- Node.js 20+ and this repository (`npm install`).
- Python 3.10+ with `numpy` and `Pillow` (`pip install numpy pillow`).
- About 1.5 GB of free disk space while building; the finished pack is about 560 MB.
- Internet access once, to download [WolvenKit](https://github.com/WolvenKit/WolvenKit) CLI 9.1.1
  from its official GitHub release (or pass your own `--wolvenkit`).

### Build it

```sh
npm run pack -- --game "D:\Games\Cyberpunk 2077" --out "D:\v-mirror-pack"
```

| Option | Meaning |
| --- | --- |
| `--game <dir>` | game install folder (contains `archive\pc\content`) |
| `--out <dir>` | pack folder to create; must be empty or an older pack |
| `--wolvenkit <exe>` | use this `WolvenKit.CLI.exe` (default: `%WOLVENKIT%`, else download into `%LOCALAPPDATA%\v-mirror\wolvenkit`) |
| `--work <dir>` | temporary folder (default `<out>.work`, deleted at the end) |
| `--keep-work`, `--skip-extract` | keep the work folder / reuse it on the next run |
| `--no-webp` | keep PNG textures instead of converting them to WebP |
| `--only <phases>` | run some phases only, e.g. `--only optimize,index --out tools/local` |
| `--python <cmd>` | Python to use (default `%PYTHON%`, `python`, `py -3`) |

A full build takes about 5 minutes on an SSD (WolvenKit ~1 min, builders ~1.5 min, WebP ~2 min). It ends with `pack.json` and a check against the list of
files the app expects; the command exits with code 2 if something is missing.

### Connect it

Open V-Mirror and press **Connect asset pack** in the header, then pick the pack folder (or its
parent folder). Chrome and Edge remember the folder; on the next visit one click restores it.
Firefox and Safari have no folder handles, so they ask for the folder on every visit.

### What is inside

```
pack.json            {format: 1, gameVersion, createdAt, files, bytes, tool}
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

### Что нужно

- Windows 10/11 и установленная Cyberpunk 2077 2.x (собрано и проверено на патче 2.5, GOG).
  Папка игры только читается.
- Node.js 20+ и этот репозиторий (`npm install`).
- Python 3.10+ с `numpy` и `Pillow` (`pip install numpy pillow`).
- Около 1,5 ГБ свободного места на время сборки; готовый набор весит около 560 МБ.
- Один раз интернет, чтобы скачать CLI [WolvenKit](https://github.com/WolvenKit/WolvenKit) 9.1.1
  с официальной страницы релизов (или укажите свой `--wolvenkit`).

### Сборка

```sh
npm run pack -- --game "D:\Games\Cyberpunk 2077" --out "D:\v-mirror-pack"
```

Параметры — в таблице выше: `--game` (папка игры), `--out` (папка набора, пустая или старый
набор), `--wolvenkit`, `--work`, `--keep-work`, `--skip-extract`, `--no-webp`, `--only`, `--python`.
Полная сборка на SSD идёт около 5 минут и заканчивается файлом `pack.json` и сверкой со списком файлов,
которые ждёт приложение; если чего-то не хватает, команда завершается с кодом 2.

### Подключение

Откройте V-Mirror, нажмите **«Подключить набор ассетов»** в шапке и выберите папку набора (или
папку, в которой он лежит). Chrome и Edge запоминают папку, при следующем визите её
возвращает один клик. Firefox и Safari не умеют хранить доступ к папке и спрашивают её каждый раз.

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
