<#
  Извлекает данные редактора персонажа из установленной Cyberpunk 2077 (только чтение).

  Требуется WolvenKit.CLI (https://github.com/WolvenKit/WolvenKit/releases, архив WolvenKit.Console-*.zip).

  Пример:
    .\tools\extract\extract_game_data.ps1 -GamePath "G:\Cyberpunk 2077" -WolvenKit "C:\tools\wk\WolvenKit.CLI.exe" -Work "C:\tmp\cp-work"
    python -I tools\extract\build_catalog.py --work "C:\tmp\cp-work" --out src\data
#>
param(
    [Parameter(Mandatory = $true)][string]$GamePath,
    [Parameter(Mandatory = $true)][string]$WolvenKit,
    [Parameter(Mandatory = $true)][string]$Work
)
$ErrorActionPreference = 'Stop'
$c = Join-Path $GamePath 'archive\pc'
New-Item -ItemType Directory -Force $Work, "$Work\cc_raw", "$Work\cc_json", "$Work\loc_raw", "$Work\loc_json", "$Work\atlas_png" | Out-Null

# 1. Листинг архивов (нужен для имён мешей причёсок)
$archives = Get-ChildItem "$c\content\basegame_*.archive", "$c\ep1\ep1_*.archive" | Where-Object { $_.Name -notmatch 'video|nightcity_gi|terrain' }
$list = New-Object System.Collections.Generic.List[string]
foreach ($a in $archives) {
    foreach ($l in (& $WolvenKit archive $a.FullName -l 2>&1)) {
        $t = "$l"
        if ($t -match '\\') { $list.Add("$($a.Name)|$t") }
    }
}
[System.IO.File]::WriteAllLines("$Work\all_list.txt", $list)

# 2. Описания редактора, пресеты, атлас образцов
$rx = 'inkcharcustomization|charcustpreset|\.ccstate|character_creation_thumbnails_atlas\.(inkatlas|xbm)'
& $WolvenKit extract "$c\content\basegame_4_gamedata.archive" -o "$Work\cc_raw" -r $rx | Out-Null
& $WolvenKit extract "$c\content\basegame_1_engine.archive" -o "$Work\cc_raw" -r 'player_presets' | Out-Null
& $WolvenKit extract "$c\ep1\ep1_2_gamedata.archive" -o "$Work\cc_raw" -r 'inkcharcustomization' | Out-Null
& $WolvenKit convert serialize "$Work\cc_raw" -o "$Work\cc_json" | Out-Null
& $WolvenKit export "$Work\cc_raw\base\gameplay\gui\fullscreen\main_menu\character_creation_thumbnails_atlas.xbm" -o "$Work\atlas_png" --gamepath $GamePath --uext png | Out-Null

# 3. Локализация RU/EN (базовая игра + Phantom Liberty)
foreach ($a in "$c\content\lang_ru_text.archive", "$c\content\lang_en_text.archive", "$c\ep1\lang_ru_text.archive", "$c\ep1\lang_en_text.archive") {
    & $WolvenKit extract $a -o "$Work\loc_raw" -r 'onscreens' | Out-Null
}
foreach ($f in (Get-ChildItem "$Work\loc_raw" -Recurse -File)) {
    $rel = $f.FullName.Substring("$Work\loc_raw\".Length)
    $dst = Join-Path "$Work\loc_json" (($rel -replace '[\\/]', '_') -replace '\.json$', '')
    New-Item -ItemType Directory -Force $dst | Out-Null
    & $WolvenKit convert serialize $f.FullName -o $dst | Out-Null
}
Write-Host "Готово: $Work"
