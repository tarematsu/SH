[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-Step {
  param(
    [string]$Message,
    [scriptblock]$Action
  )

  Write-Host "==> $Message"
  & $Action
}

function Invoke-External {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory = (Get-Location).Path
  )

  Push-Location $WorkingDirectory
  try {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "$FilePath exited with code $LASTEXITCODE"
    }
  }
  finally {
    Pop-Location
  }
}

function Assert-CleanWorktree {
  $status = git status --porcelain
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to read git status."
  }
  if ($status) {
    throw "Release requires a clean worktree."
  }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$workerRoot = Join-Path $repoRoot "worker"
$siteRoot = Join-Path $repoRoot "site"
$migrationRoot = Join-Path $repoRoot "database\migrations"

Set-Location $repoRoot
Assert-CleanWorktree

Invoke-Step "Repository checks" {
  Invoke-External -FilePath "npm" -Arguments @("run", "check") -WorkingDirectory $repoRoot
}

Invoke-Step "Worker install and checks" {
  Invoke-External -FilePath "npm" -Arguments @("install", "--no-audit", "--no-fund") -WorkingDirectory $workerRoot
  Invoke-External -FilePath "npm" -Arguments @("run", "check") -WorkingDirectory $workerRoot
}

Invoke-Step "Apply D1 migrations" {
  $migrationFiles = Get-ChildItem -Path $migrationRoot -File -Filter "*.sql" | Sort-Object Name
  foreach ($migrationFile in $migrationFiles) {
    Invoke-External -FilePath "npx" -Arguments @(
      "wrangler", "d1", "execute", "stationhead-monitor",
      "--remote",
      "--file", ("..\database\migrations\" + $migrationFile.Name)
    ) -WorkingDirectory $workerRoot
  }
}

Invoke-Step "Deploy Worker" {
  Invoke-External -FilePath "npx" -Arguments @("wrangler", "deploy", "--config", ".\wrangler.jsonc") -WorkingDirectory $workerRoot
}

Invoke-Step "Site install and checks" {
  Invoke-External -FilePath "npm" -Arguments @("install", "--no-audit", "--no-fund") -WorkingDirectory $siteRoot
  Invoke-External -FilePath "npm" -Arguments @("run", "check") -WorkingDirectory $siteRoot
}

Invoke-Step "Deploy Pages site" {
  Invoke-External -FilePath "npx" -Arguments @(
    "wrangler", "pages", "deploy", "public",
    "--project-name", "skrzk",
    "--branch", "main"
  ) -WorkingDirectory $siteRoot
}

Invoke-Step "Verify Worker health" {
  $response = Invoke-RestMethod "https://stationhead-monitor-collector.tarematsu.workers.dev/health"
  if (-not $response.healthy -and -not $response.ok) {
    throw "Worker health verification failed."
  }
}

Write-Host "Local deploy complete for stationhead-monitor"
