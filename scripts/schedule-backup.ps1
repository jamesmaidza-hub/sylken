# Sets up the nightly sylken backup in Windows Task Scheduler.
#
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-backup.ps1            (every night at 22:00)
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-backup.ps1 -At 23:30
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-backup.ps1 -Remove
#
# The task runs as you, while you are logged in, and if the computer was off at that time it runs the backup as soon as
# it can. Its output is added to backup.log in the sylken folder. Run it from the sylken folder.
param(
  [string]$At = '22:00',
  [string]$TaskName = 'sylken nightly backup',
  [switch]$Remove
)

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed the scheduled task '$TaskName'."
  return
}

$repo = (Get-Location).Path
if (-not (Test-Path (Join-Path $repo '.env'))) { throw "Run this from the sylken folder (no .env found in $repo)." }
$node = (Get-Command node -ErrorAction Stop).Source

# Use the built copy when there is one (dist), otherwise npm.
if (Test-Path (Join-Path $repo 'dist\src\cli\backup.js')) { $command = "`"$node`" --env-file=.env dist\src\cli\backup.js" }
else { $command = 'npm run backup' }
$arg = "/c cd /d `"$repo`" && $command >> backup.log 2>&1"

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $arg
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Encrypted backup of the sylken database' -Force | Out-Null
Write-Host "Scheduled '$TaskName' every day at $At."
Write-Host "Backups go to $env:USERPROFILE\sylken-backups (see SYLKEN_BACKUP_DIR). Output is in $repo\backup.log."
