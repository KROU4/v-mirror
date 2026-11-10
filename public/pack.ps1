# V-Mirror asset pack: builds the pack for live 3D from your own Cyberpunk 2077 install.
#
#   irm https://krou4.github.io/v-mirror/pack.ps1 | iex
#
# What it does (no administrator rights needed, except that the Node.js installer of winget is
# machine-wide: when Node.js is missing, Windows may ask for permission once):
#   1. finds Node.js 20+ and Python 3.10+ (installs them with winget if missing: per user where
#      the package offers it) and the numpy and Pillow modules (pip install --user, only when
#      they are missing);
#   2. downloads the V-Mirror source of the exact commit the site was built from
#      (github.com/<repo>/zip/<commit>) into %LOCALAPPDATA%\v-mirror\src\<commit>;
#   3. runs node tools\extract\pack.mjs: it finds the game (GOG, Steam, Epic, drive scan),
#      only reads it, downloads WolvenKit CLI (SHA-256 checked) and writes the pack to
#      Documents\V-Mirror pack, or %LOCALAPPDATA%\v-mirror\pack without a Documents folder
#      (5-10 minutes, 560-800 MB);
#   4. copies the pack folder path to the clipboard and opens V-Mirror with ?pack=1.
# Nothing is uploaded anywhere.
#
# Local use (a clone of the repository, e.g. tools\pack-windows.cmd):
#   powershell -NoProfile -ExecutionPolicy Bypass -File public\pack.ps1 -Source . [-Game <dir>] [-Out <dir>] [-Force] [-KeepWork] [-NoBrowser]
# With irm | iex the same settings come from environment variables:
#   VMIRROR_GAME, VMIRROR_OUT, VMIRROR_FORCE=1, VMIRROR_KEEP_WORK=1, VMIRROR_SOURCE, VMIRROR_NO_BROWSER=1
# VMIRROR_KEEP_WORK=1 (or -KeepWork) keeps <pack>.work with the logs of a failed build;
# VMIRROR_NO_BROWSER=1 (or -NoBrowser) skips the clipboard and the browser (automated runs);
# VMIRROR_SOURCE_ONLY=1 (or -SourceOnly) stops after getting the source (checks, debugging).
#
# The file is plain ASCII on purpose (PowerShell 5.1 and irm may read it as Latin-1): the
# Russian messages are written as \u escapes and decoded at run time.
param(
  [string]$Game,
  [string]$Out,
  [switch]$Force,
  [switch]$KeepWork,
  [string]$Source,
  [switch]$NoBrowser,
  [switch]$SourceOnly
)

function Invoke-VMirrorPack {
  param([string]$Game, [string]$Out, [bool]$Force, [bool]$KeepWork, [string]$Source, [bool]$NoBrowser, [bool]$SourceOnly)
  Set-StrictMode -Version Latest
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  # Stamped by the site build (vite.config.ts, stampPackScript); the fallbacks serve a local copy
  $commit = '__VMIRROR_COMMIT__'
  $repo = '__VMIRROR_REPO__'
  $site = '__VMIRROR_SITE__'
  if ($commit -notmatch '^[0-9a-f]{40}$') { $commit = 'main' }
  if ($repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { $repo = 'KROU4/v-mirror' }
  if ($site -notmatch '^https?://[^''\s]+/$') { $site = 'https://krou4.github.io/v-mirror/' }
  $guide = "https://github.com/$repo/blob/main/docs/ASSET_PACK.md"

  function Env([string]$name) { [Environment]::GetEnvironmentVariable($name) }
  if (-not $Game) { $Game = Env 'VMIRROR_GAME' }
  if (-not $Out) { $Out = Env 'VMIRROR_OUT' }
  if (-not $Source) { $Source = Env 'VMIRROR_SOURCE' }
  if (-not $Force) { $Force = (Env 'VMIRROR_FORCE') -eq '1' }
  if (-not $KeepWork) { $KeepWork = (Env 'VMIRROR_KEEP_WORK') -eq '1' }
  if (-not $NoBrowser) { $NoBrowser = (Env 'VMIRROR_NO_BROWSER') -eq '1' }
  if (-not $SourceOnly) { $SourceOnly = (Env 'VMIRROR_SOURCE_ONLY') -eq '1' }

  function Ru([string]$s) { [regex]::Unescape($s) }
  function Say([string]$msg) { Write-Host $msg }
  function Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
  function Fail([string]$en, [string]$ru) {
    Write-Host ''
    Write-Host $en -ForegroundColor Red
    if ($ru) { Write-Host $ru -ForegroundColor Red }
  }

  # Runs a program and returns its exit code and stdout; stderr is dropped. EAP Continue: in
  # PowerShell 5.1 a redirected stderr line would otherwise stop the script.
  function Invoke-Capture([string]$exe, [string[]]$arguments) {
    $ErrorActionPreference = 'Continue'
    try {
      $o = & $exe @arguments 2>$null
      return @{ Code = $LASTEXITCODE; Out = (@($o) -join "`n") }
    } catch {
      return @{ Code = -1; Out = '' }
    }
  }

  function Update-SessionPath {
    $parts = @($env:Path -split ';') + @(([Environment]::GetEnvironmentVariable('Path', 'Machine')) -split ';') + @(([Environment]::GetEnvironmentVariable('Path', 'User')) -split ';')
    $seen = @{}
    $keep = foreach ($p in $parts) {
      if ($p -and -not $seen.ContainsKey($p.ToLowerInvariant())) { $seen[$p.ToLowerInvariant()] = 1; $p }
    }
    $env:Path = ($keep -join ';')
  }

  function Join-Base([string]$base, [string]$rest) { if ($base) { Join-Path $base $rest } }

  # ---------------------------------------------------------------- Node.js 20+
  function Find-Node {
    $cands = New-Object System.Collections.Generic.List[string]
    $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { $cands.Add($cmd.Source) }
    foreach ($c in @(
        (Join-Base $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Base ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'nodejs\node.exe'),
        (Join-Base $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        (Join-Base (Env 'NVM_SYMLINK') 'node.exe'),
        (Join-Base $env:USERPROFILE 'scoop\apps\nodejs-lts\current\node.exe'),
        (Join-Base $env:USERPROFILE 'scoop\apps\nodejs\current\node.exe'))) {
      if ($c) { $cands.Add($c) }
    }
    $wg = Join-Base $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if ($wg -and (Test-Path -LiteralPath $wg)) {
      Get-ChildItem -LiteralPath $wg -Directory -Filter 'OpenJS.NodeJS*' -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Recurse -Filter node.exe -ErrorAction SilentlyContinue } |
        ForEach-Object { $cands.Add($_.FullName) }
    }
    foreach ($c in $cands) {
      if (-not (Test-Path -LiteralPath $c)) { continue }
      $r = Invoke-Capture $c @('-p', 'process.versions.node')
      if ($r.Code -eq 0 -and $r.Out -match '^(\d+)\.' -and [int]$Matches[1] -ge 20) { return @{ Exe = $c; Version = $r.Out.Trim() } }
    }
    return $null
  }

  # $null without winget, else the exit code of the last winget call (0 = installed)
  function Install-WithWinget([string]$id, [string]$what) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) { return $null }
    Step "installing $what with winget"
    $common = @('install', '--id', $id, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements')
    & $winget.Source @($common + @('--scope', 'user')) | Out-Host
    $code = $LASTEXITCODE
    if ($code -ne 0) {
      Say "  no per-user installer was accepted (code $code): trying the default one, Windows may ask for permission"
      Say ((Ru '  \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u0449\u0438\u043a \u0434\u043b\u044f \u043e\u0434\u043d\u043e\u0433\u043e \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f \u043d\u0435 \u043f\u043e\u0434\u043e\u0448\u0451\u043b (\u043a\u043e\u0434 {0}): \u043f\u0440\u043e\u0431\u0443\u044e \u043e\u0431\u044b\u0447\u043d\u044b\u0439, Windows \u043c\u043e\u0436\u0435\u0442 \u0441\u043f\u0440\u043e\u0441\u0438\u0442\u044c \u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043d\u0438\u0435') -f $code)
      & $winget.Source @common | Out-Host
      $code = $LASTEXITCODE
    }
    Update-SessionPath
    return [int]$code
  }

  # after an install attempt that still left the program missing: why, in both languages
  function Fail-Install([string]$what, $code, [string]$url, [string]$noteEn, [string]$noteRu) {
    if ($code -ne 0) {
      Fail ('winget could not install {0} (code {1}). Install it yourself from {2}{3} and run the command again.' -f $what, $code, $url, $noteEn) ((Ru 'winget \u043d\u0435 \u0441\u043c\u043e\u0433 \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u044c {0} (\u043a\u043e\u0434 {1}). \u0423\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u0435 \u0435\u0433\u043e \u0441\u0430\u043c\u0438 \u0441 {2}{3} \u0438 \u0437\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u0435 \u043a\u043e\u043c\u0430\u043d\u0434\u0443 \u0441\u043d\u043e\u0432\u0430.') -f $what, $code, $url, $noteRu)
    } else {
      Fail ('{0} was installed but cannot be found yet: open a new PowerShell window and run the command again.' -f $what) ((Ru '{0} \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d, \u043d\u043e \u043f\u043e\u043a\u0430 \u043d\u0435 \u043d\u0430\u0445\u043e\u0434\u0438\u0442\u0441\u044f: \u043e\u0442\u043a\u0440\u043e\u0439\u0442\u0435 \u043d\u043e\u0432\u043e\u0435 \u043e\u043a\u043d\u043e PowerShell \u0438 \u0437\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u0435 \u043a\u043e\u043c\u0430\u043d\u0434\u0443 \u0441\u043d\u043e\u0432\u0430.') -f $what)
    }
  }

  # ---------------------------------------------------------------- Python 3.10+
  function Find-Python {
    $probe = 'import sys; print(sys.executable); print(sys.version_info[0] * 100 + sys.version_info[1])'
    $cands = New-Object System.Collections.Generic.List[object]
    $cands.Add(@('py', '-3'))
    $cands.Add(@('python'))
    $cands.Add(@('python3'))
    foreach ($base in @((Join-Base $env:LOCALAPPDATA 'Programs\Python'), $env:ProgramFiles)) {
      if ($base -and (Test-Path -LiteralPath $base)) {
        Get-ChildItem -LiteralPath $base -Directory -Filter 'Python3*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending |
          ForEach-Object { $cands.Add(@((Join-Path $_.FullName 'python.exe'))) }
      }
    }
    foreach ($c in $cands) {
      $exe = [string]$c[0]
      if ($exe.Contains('\') -and -not (Test-Path -LiteralPath $exe)) { continue }
      if (-not $exe.Contains('\') -and -not (Get-Command $exe -CommandType Application -ErrorAction SilentlyContinue)) { continue }
      $pre = @($c | Select-Object -Skip 1)
      $r = Invoke-Capture $exe @($pre + @('-c', $probe))
      $lines = @($r.Out -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      if ($r.Code -eq 0 -and $lines.Count -ge 2 -and $lines[1] -match '^\d+$' -and [int]$lines[1] -ge 310 -and (Test-Path -LiteralPath $lines[0])) {
        return @{ Exe = $lines[0]; Version = ('{0}.{1}' -f [math]::Floor([int]$lines[1] / 100), ([int]$lines[1] % 100)) }
      }
    }
    return $null
  }

  # ---------------------------------------------------------------- V-Mirror source
  function Get-VMirrorSource {
    $root = Join-Path $env:LOCALAPPDATA 'v-mirror\src'
    $dest = Join-Path $root $commit
    if ($commit -ne 'main' -and (Test-Path -LiteralPath (Join-Path $dest 'tools\extract\pack.mjs'))) {
      Say "  V-Mirror source $commit is already in $dest"
      return $dest
    }
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $zip = Join-Path $root "$commit.zip"
    $tmp = "$dest.tmp"
    $url = "https://codeload.github.com/$repo/zip/$commit"
    Step "downloading the V-Mirror source ($repo @ $commit)"
    Say "  $url"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    $inner = Get-ChildItem -LiteralPath $tmp -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'tools\extract\pack.mjs') } | Select-Object -First 1
    if (-not $inner) { throw "the downloaded archive has no tools\extract\pack.mjs ($url)" }
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
    Move-Item -LiteralPath $inner.FullName -Destination $dest
    Remove-Item -LiteralPath $tmp -Recurse -Force
    Remove-Item -LiteralPath $zip -Force
    Say "  unpacked into $dest"
    return $dest
  }

  function Format-PathArg([string]$p) {
    # relative to the current PowerShell location ($PWD), not the folder the process started in
    # (GetFullPath alone uses the latter); a path on a drive that does not exist yet stays as is
    if (-not [IO.Path]::IsPathRooted($p)) { $p = Join-Path (Get-Location -PSProvider FileSystem).ProviderPath $p }
    $full = [IO.Path]::GetFullPath($p)
    # "D:\pack\" would escape the closing quote of the argument
    if ($full.EndsWith('\')) { $full = $full + '.' }
    return $full
  }

  # ---------------------------------------------------------------- main
  $savedEnc = $null
  $savedPyEnc = Env 'PYTHONIOENCODING'
  $resultFile = $null
  try {
    # program output (paths may be Cyrillic) is read and written as UTF-8
    try { $savedEnc = [Console]::OutputEncoding; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { $savedEnc = $null }
    Say ''
    Say 'V-Mirror: building the asset pack from your copy of Cyberpunk 2077. The game folder is only read; nothing is uploaded.'
    Say (Ru 'V-Mirror: \u0441\u0431\u043e\u0440\u043a\u0430 \u043d\u0430\u0431\u043e\u0440\u0430 \u0430\u0441\u0441\u0435\u0442\u043e\u0432 \u0438\u0437 \u0432\u0430\u0448\u0435\u0439 \u043a\u043e\u043f\u0438\u0438 Cyberpunk 2077. \u041f\u0430\u043f\u043a\u0430 \u0438\u0433\u0440\u044b \u0442\u043e\u043b\u044c\u043a\u043e \u0447\u0438\u0442\u0430\u0435\u0442\u0441\u044f, \u0432 \u0438\u043d\u0442\u0435\u0440\u043d\u0435\u0442 \u043d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u0437\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u0442\u0441\u044f.')
    Say ''

    if ($env:OS -ne 'Windows_NT') {
      Fail 'Windows 10 or 11 is required.' (Ru '\u041d\u0443\u0436\u0435\u043d Windows 10 \u0438\u043b\u0438 11.')
      return 1
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $env:PYTHONIOENCODING = 'utf-8'

    Step 'Node.js 20+'
    $node = Find-Node
    if (-not $node) {
      $wg = Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS'
      if ($null -eq $wg) {
        Fail 'Node.js 20+ is required and winget is not available. Install Node.js LTS from https://nodejs.org and run the command again.' (Ru '\u041d\u0443\u0436\u0435\u043d Node.js 20+, \u0430 winget \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d. \u0423\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u0435 Node.js LTS \u0441 https://nodejs.org \u0438 \u0437\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u0435 \u043a\u043e\u043c\u0430\u043d\u0434\u0443 \u0441\u043d\u043e\u0432\u0430.')
        return 1
      }
      $node = Find-Node
      if (-not $node) {
        Fail-Install 'Node.js LTS' $wg 'https://nodejs.org' '' ''
        return 1
      }
    }
    Say "  node $($node.Version): $($node.Exe)"

    Step 'Python 3.10+ with numpy and Pillow'
    $py = Find-Python
    if (-not $py) {
      $wg = Install-WithWinget 'Python.Python.3.12' 'Python 3.12'
      if ($null -eq $wg) {
        Fail 'Python 3.10+ is required and winget is not available. Install Python from https://www.python.org/downloads/ (tick "Add python.exe to PATH") and run the command again.' (Ru '\u041d\u0443\u0436\u0435\u043d Python 3.10+, \u0430 winget \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d. \u0423\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u0435 Python \u0441 https://www.python.org/downloads/ (\u0433\u0430\u043b\u043e\u0447\u043a\u0430 \u00abAdd python.exe to PATH\u00bb) \u0438 \u0437\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u0435 \u043a\u043e\u043c\u0430\u043d\u0434\u0443 \u0441\u043d\u043e\u0432\u0430.')
        return 1
      }
      $py = Find-Python
      if (-not $py) {
        Fail-Install 'Python 3.12' $wg 'https://www.python.org/downloads/' ' (tick "Add python.exe to PATH")' (Ru ' (\u0433\u0430\u043b\u043e\u0447\u043a\u0430 \u00abAdd python.exe to PATH\u00bb)')
        return 1
      }
    }
    Say "  python $($py.Version): $($py.Exe)"
    $mods = Invoke-Capture $py.Exe @('-E', '-c', 'import numpy, PIL')
    if ($mods.Code -ne 0) {
      Step 'installing numpy and Pillow (pip install --user)'
      & $py.Exe -m pip install --user --upgrade numpy pillow | Out-Host
      if ($LASTEXITCODE -ne 0) {
        # a virtual environment has no user site-packages: install into it
        & $py.Exe -m pip install --upgrade numpy pillow | Out-Host
      }
      $mods = Invoke-Capture $py.Exe @('-E', '-c', 'import numpy, PIL')
      if ($mods.Code -ne 0) {
        Fail "numpy and Pillow could not be installed for $($py.Exe). Run: `"$($py.Exe)`" -m pip install --user numpy pillow" ((Ru '\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u044c numpy \u0438 Pillow \u0434\u043b\u044f {0}. \u0412\u044b\u043f\u043e\u043b\u043d\u0438\u0442\u0435: "{0}" -m pip install --user numpy pillow') -f $py.Exe)
        return 1
      }
    }
    Say '  numpy and Pillow: ok'

    Step 'V-Mirror source'
    if ($Source) {
      $src = (Resolve-Path -LiteralPath $Source).Path
      Say "  local checkout: $src"
    } else {
      $src = Get-VMirrorSource
    }
    $packMjs = Join-Path $src 'tools\extract\pack.mjs'
    if (-not (Test-Path -LiteralPath $packMjs)) {
      Fail "no tools\extract\pack.mjs in $src" ((Ru '\u0412 {0} \u043d\u0435\u0442 {1}') -f $src, 'tools\extract\pack.mjs')
      return 1
    }
    if ($SourceOnly) {
      Say "source ready: $src"
      return 0
    }

    Step 'asset pack'
    $nodeArgs = New-Object System.Collections.Generic.List[string]
    $nodeArgs.Add($packMjs)
    if ($Game) { $nodeArgs.Add('--game'); $nodeArgs.Add((Format-PathArg $Game)) }
    if ($Out) { $nodeArgs.Add('--out'); $nodeArgs.Add((Format-PathArg $Out)) }
    if ($Force) { $nodeArgs.Add('--force') }
    if ($KeepWork) { $nodeArgs.Add('--keep-work') }
    $nodeArgs.Add('--python'); $nodeArgs.Add($py.Exe)
    $resultFile = [IO.Path]::GetTempFileName()
    $env:VMIRROR_RESULT_FILE = $resultFile
    & $node.Exe @($nodeArgs.ToArray()) | Out-Host
    $code = $LASTEXITCODE
    $packDir = ''
    if (Test-Path -LiteralPath $resultFile) { $packDir = [IO.File]::ReadAllText($resultFile, [Text.Encoding]::UTF8).Trim() }
    if ($code -ne 0 -or -not $packDir) {
      if ($code -eq 0) { $code = 1 }
      Fail ("The build failed (code {0}). The reason is in the messages above. Help: {1}" -f $code, $guide) ((Ru '\u0421\u0431\u043e\u0440\u043a\u0430 \u043d\u0435 \u0443\u0434\u0430\u043b\u0430\u0441\u044c (\u043a\u043e\u0434 {0}). \u041f\u0440\u0438\u0447\u0438\u043d\u0430 \u2014 \u0432 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u044f\u0445 \u0432\u044b\u0448\u0435. \u041f\u043e\u043c\u043e\u0449\u044c: {1}') -f $code, $guide)
      return $code
    }

    Write-Host ''
    Write-Host ("Asset pack ready: {0}" -f $packDir) -ForegroundColor Green
    Write-Host ((Ru '\u041d\u0430\u0431\u043e\u0440 \u0430\u0441\u0441\u0435\u0442\u043e\u0432 \u0433\u043e\u0442\u043e\u0432: {0}') -f $packDir) -ForegroundColor Green
    if (-not $NoBrowser) {
      # Set-Clipboard may report "Requested Clipboard operation did not succeed" while another
      # program (clipboard history) holds the clipboard, even when the text got there: check it
      $copied = $false
      $why = ''
      for ($i = 0; $i -lt 3 -and -not $copied; $i++) {
        try { Set-Clipboard -Value $packDir } catch { $why = $_.Exception.Message; Start-Sleep -Milliseconds 300 }
        try { $copied = ((@(Get-Clipboard) -join "`n").Trim() -eq $packDir) } catch { $copied = $false }
      }
      if ($copied) {
        Say 'The path is on the clipboard.'
        Say (Ru '\u041f\u0443\u0442\u044c \u0441\u043a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u043d \u0432 \u0431\u0443\u0444\u0435\u0440 \u043e\u0431\u043c\u0435\u043d\u0430.')
      } else {
        Say "(could not copy the path to the clipboard: $why)"
      }
    }
    Say 'In V-Mirror press "Choose pack folder" and select this folder (paste the path with Ctrl+V).'
    Say (Ru '\u0412 V-Mirror \u043d\u0430\u0436\u043c\u0438\u0442\u0435 \u00ab\u0412\u044b\u0431\u0440\u0430\u0442\u044c \u043f\u0430\u043f\u043a\u0443 \u043d\u0430\u0431\u043e\u0440\u0430\u00bb \u0438 \u0432\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u044d\u0442\u0443 \u043f\u0430\u043f\u043a\u0443 (\u043f\u0443\u0442\u044c \u043c\u043e\u0436\u043d\u043e \u0432\u0441\u0442\u0430\u0432\u0438\u0442\u044c \u0447\u0435\u0440\u0435\u0437 Ctrl+V).')
    $open = $site + '?pack=1'
    if ($NoBrowser) {
      Say "  (browser not opened: $open)"
    } else {
      Say "  opening $open"
      Start-Process $open
    }
    return 0
  } catch {
    Fail ("V-Mirror pack: {0}" -f $_.Exception.Message) ("Help / " + (Ru '\u041f\u043e\u043c\u043e\u0449\u044c') + ": $guide")
    return 1
  } finally {
    if ($savedEnc) { try { [Console]::OutputEncoding = $savedEnc } catch { } }
    $env:PYTHONIOENCODING = $savedPyEnc
    $env:VMIRROR_RESULT_FILE = $null
    if ($resultFile -and (Test-Path -LiteralPath $resultFile)) { Remove-Item -LiteralPath $resultFile -Force -ErrorAction SilentlyContinue }
  }
}

$vmirrorCode = Invoke-VMirrorPack -Game $Game -Out $Out -Force $Force.IsPresent -KeepWork $KeepWork.IsPresent -Source $Source -NoBrowser $NoBrowser.IsPresent -SourceOnly $SourceOnly.IsPresent
# -File: the exit code of the process; irm | iex: only $LASTEXITCODE (exit would close the window).
# iex runs in the caller's scope: leave nothing of the script behind in the user's session
if ($PSCommandPath) { exit $vmirrorCode }
$global:LASTEXITCODE = $vmirrorCode
Remove-Item -Path function:Invoke-VMirrorPack -ErrorAction SilentlyContinue
Remove-Variable -Name vmirrorCode, Game, Out, Force, KeepWork, Source, NoBrowser, SourceOnly -ErrorAction SilentlyContinue
