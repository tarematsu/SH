$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$emails = Import-Csv (Join-Path $root 'database\email-recap-values.csv')
$outFile = Join-Path $root 'database\email-recap-validation-results.csv'

function Find-Rows($node) {
  if ($null -eq $node) { return $null }
  if ($node.PSObject -and $node.PSObject.Properties.Name -contains 'results') { return @($node.results) }
  if ($node -is [System.Collections.IEnumerable] -and -not ($node -is [string])) {
    foreach ($child in $node) { $found = Find-Rows $child; if ($null -ne $found) { return $found } }
  }
  if ($node.PSObject) {
    foreach ($property in $node.PSObject.Properties) { $found = Find-Rows $property.Value; if ($null -ne $found) { return $found } }
  }
  return $null
}

function Jst($ms) {
  if ($null -eq $ms) { return $null }
  [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$ms).ToOffset([TimeSpan]::FromHours(9)).ToString('yyyy-MM-dd HH:mm:ss')
}

Push-Location (Join-Path $root 'worker')
try {
  Write-Host 'Loading sh_daily_summary...' -ForegroundColor Cyan
  $sql = "SELECT period_key,period_start,period_end,stream_start,stream_end FROM sh_daily_summary WHERE period_key>='2025-11-30' AND period_key<='2026-06-23' ORDER BY period_key ASC;"
  $raw = & npx wrangler d1 execute stationhead-monitor --remote --json --command=$sql 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host ($raw -join "`n") -ForegroundColor Red
    throw 'D1 daily-summary query failed'
  }

  try { $parsed = ($raw -join "`n") | ConvertFrom-Json }
  catch {
    Write-Host ($raw -join "`n") -ForegroundColor Red
    throw 'Wrangler output was not valid JSON'
  }

  $rows = @(Find-Rows $parsed)
  if (-not $rows.Count) { throw 'sh_daily_summary returned no rows' }

  $points = foreach ($row in $rows) {
    if ($null -ne $row.period_start -and $null -ne $row.stream_start) {
      [pscustomobject]@{ At=[int64]$row.period_start; Count=[int64]$row.stream_start; Source='daily_start' }
    }
    if ($null -ne $row.period_end -and $null -ne $row.stream_end) {
      [pscustomobject]@{ At=[int64]$row.period_end; Count=[int64]$row.stream_end; Source='daily_end' }
    }
  }
  $points = @($points | Sort-Object At)
  if (-not $points.Count) { throw 'No stream points found in sh_daily_summary' }

  $results = foreach ($email in $emails) {
    $sent = [int64]$email.email_sent_at
    $value = [int64]$email.email_stream_count
    $previous = @($points | Where-Object At -LE $sent | Select-Object -Last 1)[0]
    $next = @($points | Where-Object At -GE $sent | Select-Object -First 1)[0]

    $estimate = $null
    if ($previous -and $next -and $next.At -gt $previous.At) {
      $ratio = ($sent - $previous.At) / [double]($next.At - $previous.At)
      $estimate = [int64][Math]::Round($previous.Count + (($next.Count - $previous.Count) * $ratio))
    } elseif ($previous) { $estimate = [int64]$previous.Count }
    elseif ($next) { $estimate = [int64]$next.Count }

    $nearest = if ($previous -and (-not $next -or [Math]::Abs($sent-$previous.At) -le [Math]::Abs($next.At-$sent))) { $previous } else { $next }
    $difference = if ($null -ne $estimate) { $value - $estimate } else { $null }
    $percent = if ($null -ne $estimate) { [Math]::Abs($difference) / [double]$value * 100 } else { $null }
    $minutes = if ($nearest) { [Math]::Abs($nearest.At-$sent) / 60000.0 } else { $null }

    $status = if ($null -eq $estimate) { 'no_reference' }
      elseif ($minutes -gt 1440) { 'reference_far' }
      elseif ([Math]::Abs($difference) -le 1000) { 'excellent' }
      elseif ([Math]::Abs($difference) -le 10000) { 'good' }
      elseif ([Math]::Abs($difference) -le 50000 -and $percent -le 0.1) { 'plausible' }
      else { 'mismatch' }

    [pscustomobject]@{
      week_of = $email.week_of
      email_sent_jst = Jst $sent
      email_stream_count = $value
      previous_jst = if ($previous) { Jst $previous.At } else { $null }
      previous_count = if ($previous) { $previous.Count } else { $null }
      next_jst = if ($next) { Jst $next.At } else { $null }
      next_count = if ($next) { $next.Count } else { $null }
      estimated_count = $estimate
      difference = $difference
      difference_percent = if ($null -ne $percent) { [Math]::Round($percent,5) } else { $null }
      nearest_distance_minutes = if ($null -ne $minutes) { [Math]::Round($minutes,1) } else { $null }
      nearest_source = if ($nearest) { $nearest.Source } else { $null }
      validation_status = $status
    }
  }

  $results | Export-Csv $outFile -NoTypeInformation -Encoding UTF8
  $results | Format-Table week_of,email_stream_count,estimated_count,difference,difference_percent,nearest_distance_minutes,validation_status -AutoSize
  Write-Host "`nSaved: $outFile" -ForegroundColor Green
  $results | Group-Object validation_status | Sort-Object Name | Select-Object Name,Count | Format-Table -AutoSize
}
finally { Pop-Location }
