[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ConfigPath,

  [ValidateRange(1, 300)]
  [int]$PollSeconds = 5,

  [string]$LogPath = (Join-Path $env:LOCALAPPDATA 'Chat2API\native\supervisor.log'),

  [string]$MutexName = 'Local\Chat2API.NativeSupervisor',

  [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:UnhealthySince = @{}

function Write-SupervisorLog {
  param([Parameter(Mandatory = $true)][string]$Message)

  $line = '{0:o} {1}' -f [DateTimeOffset]::Now, $Message
  [Console]::WriteLine($line)

  if ([string]::IsNullOrWhiteSpace($LogPath)) {
    return
  }

  $logDirectory = Split-Path -Parent $LogPath
  if ($logDirectory -and -not (Test-Path -LiteralPath $logDirectory)) {
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  }
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

function Resolve-RequiredFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Description
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Description was not found: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Resolve-RequiredDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Description
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Description was not found: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Get-PlainTextValue {
  param([Parameter(Mandatory = $true)][Security.SecureString]$SecureValue)

  $credential = [PSCredential]::new('environment', $SecureValue)
  return $credential.GetNetworkCredential().Password
}

function Test-ServiceHealth {
  param([Parameter(Mandatory = $true)]$Service)

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Service.HealthUrl -Method Get -TimeoutSec 3
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Get-TrackedProcess {
  param([Parameter(Mandatory = $true)]$Service)

  if (-not (Test-Path -LiteralPath $Service.PidPath -PathType Leaf)) {
    return $null
  }

  $rawProcessId = (Get-Content -LiteralPath $Service.PidPath -Raw).Trim()
  $processId = 0
  if (-not [int]::TryParse($rawProcessId, [ref]$processId) -or $processId -le 0) {
    return $null
  }

  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return $null
  }

  try {
    $expectedPath = [IO.Path]::GetFullPath([string]$Service.Executable)
    $actualPath = [IO.Path]::GetFullPath($process.Path)
    if (-not $actualPath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
      Write-SupervisorLog ("Ignoring stale PID file for {0}: PID {1} belongs to another executable." -f $Service.Name, $processId)
      return $null
    }
  } catch {
    Write-SupervisorLog ("Could not validate PID {0} for {1}: {2}" -f $processId, $Service.Name, $_.Exception.Message)
    return $null
  }

  return $process
}

function Set-ProcessEnvironment {
  param([Parameter(Mandatory = $true)]$EnvironmentEntries)

  $original = @{}
  foreach ($entry in @($EnvironmentEntries)) {
    $name = [string]$entry.Name
    if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
      throw "Invalid environment variable name in native service config: $name"
    }

    $original[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    $plainText = Get-PlainTextValue -SecureValue $entry.Value
    try {
      [Environment]::SetEnvironmentVariable($name, $plainText, 'Process')
    } finally {
      $plainText = $null
    }
  }
  return $original
}

function Restore-ProcessEnvironment {
  param([Parameter(Mandatory = $true)][hashtable]$Original)

  foreach ($entry in $Original.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
  }
}

function Start-ManagedService {
  param([Parameter(Mandatory = $true)]$Service)

  $executable = Resolve-RequiredFile -Path $Service.Executable -Description ("Executable for {0}" -f $Service.Name)
  $workingDirectory = Resolve-RequiredDirectory -Path $Service.WorkingDirectory -Description ("Working directory for {0}" -f $Service.Name)

  foreach ($outputPath in @($Service.StdOutPath, $Service.StdErrPath, $Service.PidPath)) {
    $parent = Split-Path -Parent $outputPath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
  }

  $original = Set-ProcessEnvironment -EnvironmentEntries $Service.Environment
  try {
    $process = Start-Process `
      -FilePath $executable `
      -ArgumentList ([string]$Service.CommandLineArguments) `
      -WorkingDirectory $workingDirectory `
      -RedirectStandardOutput $Service.StdOutPath `
      -RedirectStandardError $Service.StdErrPath `
      -WindowStyle Hidden `
      -PassThru
  } finally {
    Restore-ProcessEnvironment -Original $original
  }

  Set-Content -LiteralPath $Service.PidPath -Value $process.Id -Encoding ASCII
  Write-SupervisorLog ("Started {0} with PID {1}." -f $Service.Name, $process.Id)

  $deadline = [DateTime]::UtcNow.AddSeconds([int]$Service.StartTimeoutSeconds)
  do {
    $process.Refresh()
    if ($process.HasExited) {
      Write-SupervisorLog ("{0} exited during startup with code {1}." -f $Service.Name, $process.ExitCode)
      return $false
    }
    if (Test-ServiceHealth -Service $Service) {
      Write-SupervisorLog ("{0} became healthy at {1}." -f $Service.Name, $Service.HealthUrl)
      return $true
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)

  Write-SupervisorLog ("{0} did not become healthy within {1}s." -f $Service.Name, $Service.StartTimeoutSeconds)
  return $false
}

function Ensure-ManagedService {
  param([Parameter(Mandatory = $true)]$Service)

  $name = [string]$Service.Name
  if (Test-ServiceHealth -Service $Service) {
    $script:UnhealthySince.Remove($name)
    return $true
  }

  $process = Get-TrackedProcess -Service $Service
  if ($null -eq $process) {
    $script:UnhealthySince.Remove($name)
    return Start-ManagedService -Service $Service
  }

  if (-not $script:UnhealthySince.ContainsKey($name)) {
    $script:UnhealthySince[$name] = [DateTime]::UtcNow
    Write-SupervisorLog ("{0} is running with PID {1}, but its health check is failing." -f $name, $process.Id)
    return $false
  }

  $unhealthySeconds = ([DateTime]::UtcNow - $script:UnhealthySince[$name]).TotalSeconds
  if ($unhealthySeconds -lt [int]$Service.RestartAfterSeconds) {
    return $false
  }

  Write-SupervisorLog ("Restarting unhealthy service {0} after {1:n1}s." -f $name, $unhealthySeconds)
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  $script:UnhealthySince.Remove($name)
  return Start-ManagedService -Service $Service
}

function Invoke-SupervisorCheck {
  param([Parameter(Mandatory = $true)]$Services)

  $dependenciesHealthy = $true
  foreach ($service in @($Services)) {
    if (-not $dependenciesHealthy) {
      Write-SupervisorLog ("Skipping {0} until an earlier service is healthy." -f $service.Name)
      continue
    }
    $dependenciesHealthy = Ensure-ManagedService -Service $service
  }
}

$resolvedConfigPath = Resolve-RequiredFile -Path $ConfigPath -Description 'Native supervisor config'
$config = Import-Clixml -LiteralPath $resolvedConfigPath
if ([int]$config.SchemaVersion -ne 1) {
  throw "Unsupported native supervisor config schema: $($config.SchemaVersion)"
}
$services = @($config.Services)
if ($services.Count -eq 0) {
  throw 'Native supervisor config does not contain any services.'
}

$createdNew = $false
$mutex = [Threading.Mutex]::new($true, $MutexName, [ref]$createdNew)
if (-not $createdNew) {
  Write-SupervisorLog ("Another native supervisor owns mutex {0}; exiting." -f $MutexName)
  $mutex.Dispose()
  exit 0
}

try {
  Write-SupervisorLog ("Native supervisor started for {0} service(s)." -f $services.Count)
  do {
    try {
      Invoke-SupervisorCheck -Services $services
    } catch {
      Write-SupervisorLog ("Supervisor check failed: {0}" -f $_.Exception.Message)
    }

    if (-not $Once) {
      Start-Sleep -Seconds $PollSeconds
    }
  } while (-not $Once)
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
