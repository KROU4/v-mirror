<#
  Локально (для калибровки описаний причёсок): выгружает .app причёсок игрока,
  находит в них меши и экспортирует их в glb в tools/local/hair. В репозиторий не попадает.
  .\tools\extract\export_hair.ps1 -GamePath "G:\Cyberpunk 2077" -WolvenKit "C:\tools\wk\WolvenKit.CLI.exe" -Work "C:\tmp\cp-work"
#>
param(
    [Parameter(Mandatory = $true)][string]$GamePath,
    [Parameter(Mandatory = $true)][string]$WolvenKit,
    [Parameter(Mandatory = $true)][string]$Work
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
# Причёски 1.x лежат в basegame_4_appearance, добавленные позже — в других архивах content и ep1
$arch = @('archive\pc\content', 'archive\pc\ep1') | ForEach-Object { Join-Path $GamePath $_ } | Where-Object { Test-Path $_ }
$appRaw = Join-Path $Work 'hair_app_raw'
$appJson = Join-Path $Work 'hair_app_json'
$meshRaw = Join-Path $Work 'hair_mesh_raw'
$out = Join-Path $root 'tools\local\hair'
New-Item -ItemType Directory -Force $appRaw, $appJson, $meshRaw, $out | Out-Null

foreach ($a in $arch) {
    & $WolvenKit extract $a -o $appRaw -r 'player_base_heads\\appearances\\hairs\\hh_\d+_p(m|w)a__hairs_[^\\]*\.app$' | Select-Object -Last 1
}
& $WolvenKit convert serialize $appRaw -o $appJson | Out-Null

# Сопоставление app -> mesh
$map = @{}
foreach ($f in (Get-ChildItem $appJson -Recurse -Filter *.app.json)) {
    $txt = Get-Content $f.FullName -Raw
    $meshes = [regex]::Matches($txt, '"\$value":\s*"(base\\\\characters\\\\common\\\\hair\\\\[^"]+?\.mesh)"') | ForEach-Object { $_.Groups[1].Value -replace '\\\\', '\' } | Where-Object { $_ -notmatch 'shadow|_fpp' } | Select-Object -Unique
    $map[$f.Name -replace '\.app\.json$', ''] = @($meshes)
}
$map | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 (Join-Path $out 'app_to_mesh.json')

$all = $map.Values | ForEach-Object { $_ } | Select-Object -Unique
Write-Host "мешей: $($all.Count)"
# Регулярка по папкам причёсок (по полным путям мешей она не помещается в командную строку)
$dirs = $all | ForEach-Object { Split-Path $_ -Parent } | Select-Object -Unique
$rx = '(' + (($dirs | ForEach-Object { [regex]::Escape((Split-Path $_ -Leaf)) }) -join '|') + ')\\[^\\]+\.mesh$'
foreach ($a in $arch) { & $WolvenKit extract $a -o $meshRaw -r $rx | Select-Object -Last 1 }
# Экспорт мешей с материалами требует настроенного Depot в WolvenKit. Нам нужна только геометрия,
# поэтому отключаем материалы в appsettings.json рядом с CLI (если ещё не отключены).
$cfg = Join-Path (Split-Path $WolvenKit) 'appsettings.json'
if ((Test-Path $cfg) -and -not (Select-String -Path $cfg -Pattern 'MeshExportArgs' -Quiet)) {
    $j = Get-Content $cfg -Raw | ConvertFrom-Json
    $j | Add-Member -NotePropertyName MeshExportArgs -NotePropertyValue ([pscustomobject]@{ WithMaterials = $false; ExportGarmentSupport = $false })
    [IO.File]::WriteAllText($cfg, ($j | ConvertTo-Json -Depth 6))
}
# Экспортируем только меши, на которые ссылаются причёски игрока: складываем их в одну папку
# и отдаём CLI папкой (список файлов не влезает в командную строку Windows)
$sel = Join-Path $Work 'hair_mesh_sel'
New-Item -ItemType Directory -Force $sel | Out-Null
foreach ($rel in $all) {
    $src = Join-Path $meshRaw $rel
    $glb = Join-Path $out ([IO.Path]::GetFileNameWithoutExtension($rel) + '.glb')
    if ((Test-Path $src) -and -not (Test-Path $glb)) { Copy-Item $src $sel -Force }
}
if (Get-ChildItem $sel -Filter *.mesh) { & $WolvenKit export $sel -o $out --gamepath $GamePath | Select-Object -Last 2 }
Get-ChildItem $out -Recurse -Filter *.glb | ForEach-Object {
    if ($_.DirectoryName -ne $out) { Move-Item $_.FullName (Join-Path $out $_.Name) -Force }
}
$names = @(Get-ChildItem $out -Filter *.glb | ForEach-Object { $_.Name })
[IO.File]::WriteAllText((Join-Path $out 'index.json'), ($names | ConvertTo-Json))
Write-Host "glb: $($names.Count)"
