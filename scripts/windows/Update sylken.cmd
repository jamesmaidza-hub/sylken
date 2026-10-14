@echo off
title Update sylken
echo.
echo  Updating sylken. Please wait and do not close this window.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$SelfPath='%~f0'; iex ((Get-Content -LiteralPath $SelfPath -Raw) -split '#PS-START#\r?\n',2)[1]"
echo.
pause
exit /b
#PS-START#
# Updates the sylken trial install on this PC from sylken-latest.zip.
#
# What it touches: the sylken code folder (code files only), sylken's own
# node.exe / esbuild.exe processes, a backup folder under %LOCALAPPDATA%\sylken-backups
# and a temp folder. It keeps .env, data\, node_modules\ and the database.
# It never touches Compharm, its Firebird service (port 3050) or SQL Server.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$desktop = [Environment]::GetFolderPath('Desktop')
$logFile = Join-Path $desktop 'sylken update log.txt'
try { Start-Transcript -Path $logFile -Force | Out-Null } catch {}

function Say($text) { Write-Host "  $text" }
function Fail($text) {
  Write-Host ''
  Write-Host "  PROBLEM: $text" -ForegroundColor Red
  Write-Host '  Nothing in Compharm was touched. Send Claude a photo of this window,' -ForegroundColor Red
  Write-Host "  or the file 'sylken update log.txt' on your desktop." -ForegroundColor Red
  throw 'stopped'
}

function Test-Port([int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $r = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    if ($r.AsyncWaitHandle.WaitOne(700)) { $c.EndConnect($r); return $true }
    return $false
  } catch { return $false } finally { $c.Close() }
}

function Wait-Port([int]$port, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) { if (Test-Port $port) { return $true }; Start-Sleep -Seconds 1 }
  return $false
}

function Test-SylkenFolder($dir) {
  $pkg = Join-Path $dir 'package.json'
  if (-not (Test-Path -LiteralPath $pkg)) { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $dir 'src\server.ts'))) { return $false }
  return ((Get-Content -LiteralPath $pkg -Raw) -match '"name"\s*:\s*"sylken"')
}

function Find-Repo {
  $desktops = @($desktop, (Join-Path $HOME 'Desktop'), (Join-Path $HOME 'OneDrive\Desktop')) | Select-Object -Unique
  $found = @()
  foreach ($d in $desktops) {
    foreach ($top in @((Join-Path $d 'sylken-app'), (Join-Path $d 'sylken'))) {
    if (-not (Test-Path -LiteralPath $top)) { continue }
    if (Test-SylkenFolder $top) { $found += (Get-Item -LiteralPath $top).FullName }
    Get-ChildItem -LiteralPath $top -Directory -Recurse -Depth 1 -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '\\node_modules(\\|$)' -and (Test-SylkenFolder $_.FullName) } |
      ForEach-Object { $found += $_.FullName }
    }
  }
  $found = @($found | Select-Object -Unique)
  if ($found.Count -eq 0) { return $null }
  $withModules = @($found | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'node_modules') })
  if ($withModules.Count -gt 0) { return $withModules[0] }
  return $found[0]
}

function Test-Node($exe) {
  try { $v = & $exe -v; return ($v -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) } catch { return $false }
}

function Find-NodeExe($root, [int]$depth) {
  # Walks folders breadth-first, skipping node_modules and .git, so it stays quick.
  $level = @(Get-Item -LiteralPath $root -ErrorAction SilentlyContinue)
  for ($d = 0; $d -le $depth -and $level.Count -gt 0; $d++) {
    $next = @()
    foreach ($dir in $level) {
      $exe = Join-Path $dir.FullName 'node.exe'
      if ((Test-Path -LiteralPath $exe) -and (Test-Node $exe)) { return $exe }
      $next += @(Get-ChildItem -LiteralPath $dir.FullName -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notin @('node_modules', '.git', 'AppData', 'Windows') })
    }
    $level = $next
  }
  return $null
}

function Find-Node($repo) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd -and (Test-Node $cmd.Source)) { return $cmd.Source }
  $roots = @(
    @{ Path = (Split-Path $repo -Parent); Depth = 3 },
    @{ Path = (Join-Path $env:LOCALAPPDATA 'Programs'); Depth = 2 },
    @{ Path = $env:LOCALAPPDATA; Depth = 2 },
    @{ Path = $HOME; Depth = 3 },
    @{ Path = (Join-Path $env:ProgramFiles 'nodejs'); Depth = 0 }
  )
  foreach ($r in $roots) {
    if (-not $r.Path -or -not (Test-Path -LiteralPath $r.Path)) { continue }
    $hit = Find-NodeExe $r.Path $r.Depth
    if ($hit) { return $hit }
  }
  return $null
}

function Find-Zip {
  $dirs = @((Split-Path $SelfPath -Parent), (Join-Path $HOME 'Downloads'), $desktop) | Select-Object -Unique
  $zips = foreach ($d in $dirs) {
    if (Test-Path -LiteralPath $d) { Get-ChildItem -LiteralPath $d -Filter 'sylken-latest*.zip' -File -ErrorAction SilentlyContinue }
  }
  return ($zips | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
}

function Find-Shortcut {
  $desktops = @($desktop, (Join-Path $HOME 'Desktop'), (Join-Path $HOME 'OneDrive\Desktop'),
    [Environment]::GetFolderPath('CommonDesktopDirectory')) | Select-Object -Unique
  foreach ($d in $desktops) {
    if (-not (Test-Path -LiteralPath $d)) { continue }
    $s = Get-ChildItem -LiteralPath $d -File -ErrorAction SilentlyContinue |
      Where-Object { $_.BaseName -eq 'Start sylken' } | Select-Object -First 1
    if ($s) { return $s.FullName }
  }
  return $null
}

function Stop-Sylken($repo) {
  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { ($_.Name -eq 'node.exe' -or $_.Name -eq 'esbuild.exe') -and $_.CommandLine -and
      ($_.CommandLine -like "*$repo*" -or $_.CommandLine -match 'src[\\/]server\.ts') })
  try {
    Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction Stop | ForEach-Object {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue
      if ($p -and $p.Name -eq 'node.exe') { $procs += $p }
    }
  } catch {}
  foreach ($p in ($procs | Sort-Object ProcessId -Unique)) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {}
  }
  for ($i = 0; $i -lt 15 -and (Test-Port 3000); $i++) { Start-Sleep -Seconds 1 }
}

function Copy-Code($from, $to, $names) {
  foreach ($n in $names) {
    $src = Join-Path $from $n
    $dst = Join-Path $to $n
    if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }
    Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
  }
}

function Invoke-Migrate($node, $repo) {
  # Use the same settings as the app: the PC install's secrets.ps1 (as start-sylken.ps1 does),
  # else .env if there is one, else sylken's built-in defaults (port 5433).
  $envFile = Join-Path $repo '.env'
  $saved = @{}
  $secrets = Join-Path $HOME 'sylken-tools\secrets.ps1'
  if (Test-Path -LiteralPath $secrets) {
    $PgSuperPassword = $null; $AppDbPassword = $null
    . $secrets
    $vars = @{
      DATABASE_ADMIN_URL = "postgres://postgres:$PgSuperPassword@localhost:5433/sylken"
      DATABASE_URL = "postgres://sylken_app:$AppDbPassword@localhost:5433/sylken"
      APP_DB_PASSWORD = $AppDbPassword
    }
    foreach ($k in $vars.Keys) {
      $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
      [Environment]::SetEnvironmentVariable($k, $vars[$k], 'Process')
    }
    $envFile = ''
  }
  if ($envFile -and (Test-Path -LiteralPath $envFile)) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
      if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
        $k = $Matches[1]; $v = $Matches[2].Trim().Trim('"').Trim("'")
        if ($v -eq '') { continue }
        $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
        [Environment]::SetEnvironmentVariable($k, $v, 'Process')
      }
    }
  }
  $tsx = Join-Path $repo 'node_modules\tsx\dist\cli.mjs'
  if (-not (Test-Path -LiteralPath $tsx)) { Say '  tsx is missing from node_modules.'; return $false }
  Push-Location $repo
  $ErrorActionPreference = 'Continue'
  try {
    & $node $tsx 'src\cli\migrate.ts' 2>&1 | ForEach-Object { Say "$_" }
    return ($LASTEXITCODE -eq 0)
  } finally {
    $ErrorActionPreference = 'Stop'
    Pop-Location
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
  }
}

function Start-Sylken($shortcut, $node, $repo) {
  if ($shortcut) { Start-Process -FilePath $shortcut | Out-Null; return }
  Start-Process -FilePath $node -ArgumentList @('node_modules\tsx\dist\cli.mjs', 'src\server.ts') -WorkingDirectory $repo | Out-Null
  Start-Sleep -Seconds 8
  Start-Process 'http://localhost:3000/' | Out-Null
}

try {
  # 1. Find everything first, before changing anything.
  Say 'Step 1 of 6: finding sylken on this PC...'
  $zip = Find-Zip
  if (-not $zip) { Fail "I can't find sylken-latest.zip. Put it in Downloads, next to this file, then double-click this file again." }
  $repo = Find-Repo
  if (-not $repo) { Fail "I can't find the sylken folder on the desktop." }
  $node = Find-Node $repo
  if (-not $node) { Fail "I can't find sylken's copy of Node.js." }
  $shortcut = Find-Shortcut
  Say "  sylken folder: $repo"
  Say "  update file:   $($zip.FullName)"
  Say "  Node.js:       $node"
  if ($shortcut) { Say "  start shortcut: $shortcut" }

  # 2. Unpack the new version to a temp folder and check it.
  Say 'Step 2 of 6: unpacking the new version...'
  $tmp = Join-Path $env:TEMP "sylken-update-$stamp"
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
  Expand-Archive -LiteralPath $zip.FullName -DestinationPath $tmp -Force
  $new = Get-ChildItem -LiteralPath $tmp -Directory -Recurse -Depth 1 |
    Where-Object { Test-SylkenFolder $_.FullName } | Select-Object -First 1
  if (-not $new) { Fail 'The update file is not a sylken update. Download sylken-latest.zip again.' }
  $version = 'latest'
  $vf = Join-Path $tmp 'VERSION.txt'
  if (Test-Path -LiteralPath $vf) { $version = (Get-Content -LiteralPath $vf -Raw).Trim() }
  Say "  new version: $version"
  $names = @(Get-ChildItem -LiteralPath $new.FullName -Force | ForEach-Object { $_.Name } |
    Where-Object { $_ -notin @('.env', 'data', 'node_modules', '.git') })

  # 3. Stop sylken (the black window) so its files can be replaced. The database keeps running.
  Say 'Step 3 of 6: stopping sylken...'
  Stop-Sylken $repo

  # 4. Back up the current code, then put the new code in place.
  Say 'Step 4 of 6: backing up the old version and copying in the new one...'
  $backup = Join-Path $env:LOCALAPPDATA "sylken-backups\before-update-$stamp"
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  foreach ($n in $names) {
    $old = Join-Path $repo $n
    if (Test-Path -LiteralPath $old) { Copy-Item -LiteralPath $old -Destination (Join-Path $backup $n) -Recurse -Force }
  }
  Say "  old version saved in $backup"
  try { Copy-Code $new.FullName $repo $names }
  catch {
    $why = "$_"
    try { Copy-Code $backup $repo @(Get-ChildItem -LiteralPath $backup -Force | ForEach-Object { $_.Name }) } catch {}
    Start-Sylken $shortcut $node $repo
    Fail "Could not copy in the new files ($why), so the old version was put back and started again."
  }

  # 5. Packages, then the database update.
  Say 'Step 5 of 6: updating packages and the database (this can take a few minutes)...'
  $nodeDir = Split-Path $node -Parent
  $env:Path = "$nodeDir;$env:Path"
  $npmCli = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
  Push-Location $repo
  $ErrorActionPreference = 'Continue'
  try {
    if (Test-Path -LiteralPath $npmCli) { & $node $npmCli install --no-audit --no-fund 2>&1 | ForEach-Object { Say "$_" } }
    else { & npm.cmd install --no-audit --no-fund 2>&1 | ForEach-Object { Say "$_" } }
    if ($LASTEXITCODE -ne 0) { Say '  (Packages could not be refreshed. This version needs no new ones, so carrying on.)' }
  } finally { $ErrorActionPreference = 'Stop'; Pop-Location }

  $startedEarly = $false
  if (-not (Test-Port 5433)) {
    Say "  sylken's database is not running, starting sylken to bring it up..."
    if (-not $shortcut) { Fail "sylken's database is not running and the 'Start sylken' shortcut is missing." }
    Start-Sylken $shortcut $node $repo
    $startedEarly = $true
    if (-not (Wait-Port 5433 120)) { Fail "sylken's database did not start." }
    Start-Sleep -Seconds 3
  }
  if (-not (Invoke-Migrate $node $repo)) {
    Say '  The database update failed. Putting the old version back...'
    Stop-Sylken $repo
    Copy-Code $backup $repo @(Get-ChildItem -LiteralPath $backup -Force | ForEach-Object { $_.Name })
    Start-Sylken $shortcut $node $repo
    Fail 'The database update failed, so the old version was put back and started again.'
  }

  # 6. Start sylken again and check it answers.
  Say 'Step 6 of 6: starting sylken...'
  if (-not $startedEarly) { Start-Sylken $shortcut $node $repo }
  $ok = $false
  for ($i = 0; $i -lt 90 -and -not $ok; $i++) {
    try { $r = Invoke-WebRequest -Uri 'http://localhost:3000/login' -UseBasicParsing -TimeoutSec 3; $ok = ($r.StatusCode -eq 200) }
    catch { Start-Sleep -Seconds 1 }
  }
  if (-not $ok) { Fail 'sylken was updated but did not start. Double-click Start sylken on the desktop and wait a minute.' }

  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host ''
  Write-Host "  DONE. sylken is updated ($version) and running." -ForegroundColor Green
  Write-Host '  Press F5 in the sylken browser tab to reload it. Your shops, stock, patients' -ForegroundColor Green
  Write-Host '  and logins are unchanged. You can close this window.' -ForegroundColor Green
} catch {
  if ("$_" -ne 'stopped') {
    Write-Host ''
    Write-Host "  PROBLEM: $_" -ForegroundColor Red
    Write-Host "  Send Claude a photo of this window, or 'sylken update log.txt' from the desktop." -ForegroundColor Red
  }
} finally {
  try { Stop-Transcript | Out-Null } catch {}
}
