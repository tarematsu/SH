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

Set-Location $repoRoot
Assert-CleanWorktree

Invoke-Step "Repository checks" {
  Invoke-External -FilePath "npm" -Arguments @("run", "check") -WorkingDirectory $repoRoot
}

Invoke-Step "Worker install and checks" {
  Invoke-External -FilePath "npm" -Arguments @("ci", "--no-audit", "--no-fund") -WorkingDirectory $workerRoot
  Invoke-External -FilePath "npm" -Arguments @("run", "check") -WorkingDirectory $workerRoot
}

Invoke-Step "Provision current D1 databases" {
  Invoke-External -FilePath "node" -Arguments @("scripts/provision-buddies-db.mjs") -WorkingDirectory $workerRoot
  Invoke-External -FilePath "node" -Arguments @("scripts/provision-current-facts-db.mjs") -WorkingDirectory $workerRoot
  Invoke-External -FilePath "node" -Arguments @("scripts/provision-other-db.mjs") -WorkingDirectory $workerRoot
}

Invoke-Step "Deploy active Workers" {
  Invoke-External -FilePath "npm" -Arguments @("run", "deploy:minute-enrichment") -WorkingDirectory $workerRoot
  Invoke-External -FilePath "npm" -Arguments @("run", "deploy:ingest") -WorkingDirectory $workerRoot
  Invoke-External -FilePath "npm" -Arguments @("run", "deploy:runtime") -WorkingDirectory $workerRoot
}

Invoke-Step "Site install and checks" {
  Invoke-External -FilePath "npm" -Arguments @("ci", "--no-audit", "--no-fund") -WorkingDirectory $siteRoot
  Invoke-External -FilePath "npm" -Arguments @("run", "check") -WorkingDirectory $siteRoot
}

Invoke-Step "Deploy Pages site" {
  Invoke-External -FilePath "npx" -Arguments @(
    "wrangler", "pages", "deploy", "public",
    "--project-name", "skrzk",
    "--branch", "main"
  ) -WorkingDirectory $siteRoot
}

Invoke-Step "Verify public health" {
  $response = Invoke-RestMethod "https://skrzk.pages.dev/api/health"
  if (-not [bool]$response.ok) {
    throw "Pages health verification failed."
  }
}

Write-Host "Local deploy complete for active Workers and Pages"
