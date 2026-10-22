<#
  News Radar - Tencent Cloud SCF one-click deploy (zero dependency).

  Usage (project root, PowerShell):
    .\scripts\deploy-scf.ps1            # interactive: prompts for SecretId / SecretKey
    .\scripts\deploy-scf.ps1 -Probe    # verify the key only, no changes made
    .\scripts\deploy-scf.ps1 -CnOnly   # deploy the CN function only

  Key handling: never written into any repo file, never passed as a command line
  argument; it lives only in a variable while this script runs.
#>
param(
  [switch]$Probe,
  [switch]$CnOnly,
  [switch]$Inspect,
  [string]$Bucket        = 'jinrixtiao-1301107017',
  [string]$CnRegion      = 'ap-guangzhou',
  [string]$ForeignRegion = 'ap-singapore',
  [string]$ZipPath       = 'scf-newsradar.zip'
)

$ErrorActionPreference = 'Stop'

$secretId  = $env:COS_DEPLOY_ID
$secretKey = $env:COS_DEPLOY_KEY
if (-not $secretId)  { $secretId  = Read-Host 'Enter Tencent Cloud SecretId' }
if (-not $secretKey) { $secretKey = Read-Host 'Enter Tencent Cloud SecretKey (not saved)' }
if (-not $secretId -or -not $secretKey) { throw 'missing SecretId / SecretKey' }

function Get-Sha256Hex($text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-HmacSha256Bytes($keyBytes, $text) {
  $hmac = [System.Security.Cryptography.HMACSHA256]::new($keyBytes)
  return $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text))
}

function ConvertTo-HexString($bytes) {
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Invoke-TcApi {
  param([string]$Action, [string]$Region, $BodyObj)

  $service  = 'scf'
  $hostName = "$service.tencentcloudapi.com"
  $uri      = "https://$hostName"
  $contentType = 'application/json; charset=utf-8'
  $payload = $BodyObj | ConvertTo-Json -Depth 10 -Compress

  # 用 DateTimeOffset 取 UTC 的 Unix 时间，彻底避开本地时区偏移污染签名
  $nowUtc = [DateTimeOffset]::UtcNow
  $ts     = [int]$nowUtc.ToUnixTimeSeconds()
  $date   = $nowUtc.ToString('yyyy-MM-dd')

  $canonicalHeaders = "content-type:$contentType`nhost:$hostName`n"
  $signedHeaders    = 'content-type;host'
  $canonicalRequest = "POST`n/`n`n" + $canonicalHeaders + "`n" + $signedHeaders + "`n" + (Get-Sha256Hex $payload)
  $scope = "$date/$service/tc3_request"
  $sts   = "TC3-HMAC-SHA256`n$ts`n$scope`n" + (Get-Sha256Hex $canonicalRequest)

  $kDate    = Get-HmacSha256Bytes ([System.Text.Encoding]::UTF8.GetBytes("TC3$SecretKey")) $date
  $kService = Get-HmacSha256Bytes $kDate $service
  $kSigning = Get-HmacSha256Bytes $kService 'tc3_request'
  $signature = ConvertTo-HexString (Get-HmacSha256Bytes $kSigning $sts)

  $auth = "TC3-HMAC-SHA256 Credential=$SecretId/$scope, SignedHeaders=$signedHeaders, Signature=$signature"

  $headers = @{
    'Authorization'   = $auth
    'Content-Type'    = $contentType
    'Host'            = $hostName
    'X-TC-Action'     = $Action
    'X-TC-Version'    = '2018-04-16'
    'X-TC-Timestamp'  = "$ts"
    'X-TC-Region'    = $Region
  }

  try {
    $resp = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($payload))
    # 腾讯云 API 的业务错误同样返回 HTTP 200，错误藏在 Response.Error 里，
    # 只看是否抛异常会把失败误判成成功
    if ($null -ne $resp.Response -and $null -ne $resp.Response.Error) {
      $e = $resp.Response.Error
      Write-Host "API error [$($e.Code)]: $($e.Message)" -ForegroundColor Yellow
      Write-Host "  RequestId: $($resp.Response.RequestId)" -ForegroundColor DarkGray
      Write-Host "  Hint: request body sent to Tencent Cloud (first 300 chars):" -ForegroundColor DarkGray
      Write-Host ("  " + $payload.Substring(0, [Math]::Min(300, $payload.Length))) -ForegroundColor DarkGray
      return $null
    }
    return $resp
  } catch {
    $detail = $_.ErrorDetails.Message
    if ($detail) { Write-Host "API error: $detail" -ForegroundColor Yellow }
    else { Write-Host "Request failed: $($_.Exception.Message)" -ForegroundColor Yellow }
    return $null
  }
}

function New-Function($Fn, $Region, $Desc, $Extra) {
  # 在函数内构造，不依赖外部脚本作用域变量
  $vars = @(
    @{ Key = 'COS_BUCKET';     Value = $Bucket }
    @{ Key = 'COS_REGION';     Value = $CnRegion }
    @{ Key = 'COS_SECRET_ID';  Value = $secretId }
    @{ Key = 'COS_SECRET_KEY'; Value = $secretKey }
    @{ Key = 'STORE';          Value = 'cos' }
  ) + @($Extra)
  $body = @{
    FunctionName = $Fn
    Handler      = 'index.handler'
    Runtime      = 'Nodejs18.15'
    MemorySize   = 512
    Timeout      = 300
    Code         = @{ ZipFile = $zipBase64 }
    Environment  = @{ Variables = $vars }
    Description  = $Desc
  }
  $r = Invoke-TcApi -Action 'CreateFunction' -Region $Region -BodyObj $body
  if ($null -ne $r) { return $true }

  # 已存在：改为更新代码 + 更新配置（UpdateFunctionCode 的 zip 是顶层 ZipFile）
  Write-Host '    already exists, updating code and config...' -ForegroundColor Yellow
  $u = @{ FunctionName = $Fn; Handler = 'index.handler'; ZipFile = $zipBase64 }
  if ($null -eq (Invoke-TcApi -Action 'UpdateFunctionCode' -Region $Region -BodyObj $u)) { return $false }
  # 更新代码后函数进入 Updating 状态，此时改配置会被拒绝
  Write-Host '    waiting for update to settle...' -ForegroundColor Gray
  Start-Sleep -Seconds 20
  $c = @{ FunctionName = $Fn; Description = $Desc; Timeout = 300; MemorySize = 512; Environment = @{ Variables = $vars } }
  if ($null -eq (Invoke-TcApi -Action 'UpdateFunctionConfiguration' -Region $Region -BodyObj $c)) { return $false }
  return $true
}

function New-Timer($Fn, $Region) {
  $t = @{
    FunctionName = $Fn
    TriggerName  = 'hourly'
    Type         = 'timer'
    TriggerDesc  = '0 0 * * * * *'
  }
  $tr = Invoke-TcApi -Action 'CreateTrigger' -Region $Region -BodyObj $t
  if ($null -eq $tr) {
    Write-Host '    timer may already exist (ignored)' -ForegroundColor Yellow
    return $true
  }
  Write-Host '    timer created' -ForegroundColor Green
  return $true
}

Write-Host '=== News Radar SCF deploy ===' -ForegroundColor Cyan
Write-Host ''
Write-Host '[1/2] verifying key (ListFunctions)...' -ForegroundColor Cyan

$probeResult = Invoke-TcApi -Action 'ListFunctions' -Region $CnRegion -BodyObj @{}
$probeResp = if ($null -eq $probeResult) { $null } else { $probeResult.Response }
if ($null -eq $probeResp -or $null -ne $probeResp.Error) {
  $code = if ($probeResp -and $probeResp.Error) { $probeResp.Error.Code } else { 'no-response' }
  $msg  = if ($probeResp -and $probeResp.Error) { $probeResp.Error.Message } else { 'request failed' }
  Write-Host "key check FAILED: $code - $msg" -ForegroundColor Red
  exit 1
}
Write-Host '    key OK' -ForegroundColor Green

$fns = @($probeResult.Response.Functions)
Write-Host "    functions found: $($fns.Count)" -ForegroundColor Gray
foreach ($f in $fns) {
  Write-Host ("      - {0} [{1}] {2}" -f $f.FunctionName, $f.Runtime, $f.ModTime) -ForegroundColor Gray
}
Write-Host ''

if ($Probe) {
  Write-Host ''
  Write-Host 'probe done, nothing changed. re-run without -Probe to deploy.' -ForegroundColor Green
  exit 0
}

if ($Inspect) {
  $r = Invoke-TcApi -Action 'GetFunction' -Region $CnRegion -BodyObj @{ FunctionName = 'news-radar-cn' }
  if ($null -eq $r) { exit 1 }
  Write-Host ($r.Response | ConvertTo-Json -Depth 8)
  exit 0
}

if (-not (Test-Path $ZipPath)) { throw "deploy zip not found: $ZipPath" }
$zipBytes  = [System.IO.File]::ReadAllBytes((Resolve-Path $ZipPath).Path)
$zipBase64 = [System.Convert]::ToBase64String($zipBytes)
Write-Host "    zip loaded: $ZipPath ($([math]::Round($zipBytes.Length/1KB,1)) KB)" -ForegroundColor Gray
Write-Host ''

Write-Host '[2/2] deploying news-radar-cn ...' -ForegroundColor Cyan
$envCn = @(
  @{ Key = 'SOURCES';        Value = 'cn' },
  @{ Key = 'DATA_FILE';      Value = 'cn.json' },
  @{ Key = 'COS_KEY';        Value = 'data/cn.json' },
  @{ Key = 'SKIP_TRANSLATE'; Value = '1' }
)
$okCn = New-Function -Fn 'news-radar-cn' -Region $CnRegion -Desc 'CN sources -> data/cn.json' -Extra $envCn
if ($okCn) {
  Write-Host '    function ready' -ForegroundColor Green
  # 刚创建的函数状态是 Creating，此时绑触发器会被拒绝，需要等它变为 Active
  Write-Host '    waiting for function to become Active...' -ForegroundColor Gray
  Start-Sleep -Seconds 20
  New-Timer -Fn 'news-radar-cn' -Region $CnRegion | Out-Null
} else {
  Write-Host '    function failed' -ForegroundColor Red
}
