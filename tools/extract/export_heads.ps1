<#
  Локально (для калибровки морфов): выгружает морф-таргеты головы V (h0 — голова,
  he — глаза, heb — брови) для обоих типов тела и конвертирует их в glb в tools/local/glb.
  Игровые файлы в репозиторий не попадают.

  .\tools\extract\export_heads.ps1 -GamePath "G:\Cyberpunk 2077" -WolvenKit "C:\tools\wk\WolvenKit.CLI.exe" -Work "C:\tmp\cp-work"
#>
param(
    [Parameter(Mandatory = $true)][string]$GamePath,
    [Parameter(Mandatory = $true)][string]$WolvenKit,
    [Parameter(Mandatory = $true)][string]$Work
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$raw = Join-Path $Work 'morph_raw'
$out = Join-Path $root 'tools\local\glb'
New-Item -ItemType Directory -Force $raw, $out | Out-Null

$arch = Join-Path $GamePath 'archive\pc\content\basegame_4_appearance.archive'
& $WolvenKit extract $arch -o $raw -r 'player_base_heads\\player_(man|female)_average\\(h0|he|heb)_000_p(m|w)a__morphs\.morphtarget$' | Select-Object -Last 1
foreach ($f in (Get-ChildItem $raw -Recurse -Filter *.morphtarget)) {
    & $WolvenKit export $f.FullName -o $out --gamepath $GamePath | Select-Object -Last 1
}
Get-ChildItem $out -Recurse -Filter *.glb | ForEach-Object {
    if ($_.DirectoryName -ne $out) { Move-Item $_.FullName (Join-Path $out $_.Name) -Force }
}
Write-Host "glb: $((Get-ChildItem $out -Filter *.glb).Count)"
