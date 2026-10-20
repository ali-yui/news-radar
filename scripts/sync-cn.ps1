<#
  News Radar - domestic (CN) data sync
  Runs hourly from Windows Task Scheduler.

  ASCII only on purpose: PowerShell 5.1 mis-reads UTF-8 .ps1 without BOM.
  Design:
    - fetch only CN sources (SOURCES=cn) -> public/data/cn.json
    - local content cache (.cache/content.json, not committed) so each run
      only fetches full text for items it has never seen before
    - publish cn.json to a single-commit branch (data-cn) via plumbing,
      so the repo does not grow one blob per hour
#>
param(
  [string]$Remote = "origin",
  [string]$Branch = "data-cn",
  [string]$PerCategory = "50",
  [string]$JsDelivrRepo = "ali-yui/news-radar"
)

$ErrorActionPreference = "Continue"
$Root = "e:/news/news-radar"
Set-Location $Root

$env:SOURCES = "cn"
$env:DATA_FILE = "cn.json"
$env:SKIP_TRANSLATE = "1"
$env:CONTENT_CACHE = "1"
$env:CONTENT_PER_CATEGORY = $PerCategory
$env:CONTENT_LIMIT = "160"

$logDir = Join-Path $Root "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir ("sync-cn-" + (Get-Date -Format "yyyyMMdd") + ".log")
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path $logFile -Value "==== run $stamp ====" -Encoding UTF8

function Write-Log([string]$text) { Add-Content -Path $logFile -Value $text -Encoding UTF8 }

# 1. fetch CN sources
Write-Log "-- fetch start"
& node scripts/fetch-data.mjs 2>&1 | ForEach-Object { Write-Log $_ }

if (-not (Test-Path "public/data/cn.json")) {
  Write-Log "!! cn.json missing, abort"
  exit 1
}

# 2. skip publish when nothing changed (compare with last published blob)
$prev = ""
try { $prev = (git rev-parse "refs/heads/$Branch" 2>$null).Trim() } catch { $prev = "" }
$blob = (git hash-object -w "public/data/cn.json").Trim()
$prevBlob = ""
if ($prev) {
  try { $prevBlob = (git rev-parse "refs/heads/${Branch}:public/data/cn.json" 2>$null).Trim() } catch { $prevBlob = "" }
}
if ($prevBlob -and ($prevBlob -eq $blob)) {
  Write-Log "-- no change, skip publish"
  exit 0
}

# 3. build a single-commit data branch with plumbing (no checkout needed)
#    NOTE: do not pipe tree specs into git mktree from PowerShell - it prefixes
#    stdin with a BOM and git fails with "input format error". Use a temp index.
$msg = "chore(data): cn news " + (Get-Date -Format "yyyy-MM-dd HH:00")
$tmpIndex = Join-Path $Root ".git/nr-data-index"
if (Test-Path $tmpIndex) { Remove-Item $tmpIndex -Force }
$env:GIT_INDEX_FILE = $tmpIndex
git add --force -- "public/data/cn.json" 2>&1 | ForEach-Object { Write-Log $_ }
$tree = ""
try { $tree = (git write-tree).Trim() } catch { $tree = "" }
Remove-Item $tmpIndex -Force -ErrorAction SilentlyContinue
Remove-Item env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
if (-not $tree) { Write-Log "!! write-tree failed"; exit 1 }
$commit = (git commit-tree $tree -m $msg).Trim()
if (-not $commit) { Write-Log "!! commit-tree failed"; exit 1 }
git update-ref "refs/heads/$Branch" $commit
Write-Log "-- new commit $commit"

# 4. force publish (branch is a pure data channel) with retries
#    github.com is intermittently reachable from this machine, so retry a few times
$ok = $false
for ($i = 1; $i -le 3; $i++) {
  $out = git push -f $Remote "$Branch" 2>&1
  $out | ForEach-Object { Write-Log $_ }
  if ($LASTEXITCODE -eq 0) { $ok = $true; break }
  Write-Log "-- push attempt $i failed, retry in 10s"
  Start-Sleep -Seconds 10
}
if (-not $ok) {
  Write-Log "!! push failed after 3 attempts (next run will retry)"
  exit 2
}

# 5. purge jsDelivr so the App sees new data immediately
$purge = "https://purge.jsdelivr.net/gh/$JsDelivrRepo@$Branch/public/data/cn.json"
try {
  Invoke-WebRequest -Uri $purge -Method Get -TimeoutSec 20 -UseBasicParsing | Out-Null
  Write-Log "-- jsdelivr purged"
} catch {
  Write-Log "-- jsdelivr purge failed (ignored): " + $_.Exception.Message
}
Write-Log "-- done"
exit 0
