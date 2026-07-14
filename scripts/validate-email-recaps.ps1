$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$workerDir = Join-Path $repoRoot 'worker'
$outputPath = Join-Path $repoRoot 'database\email-recap-validation-results.csv'

$emails = @(
  [pscustomobject]@{ WeekOf='2025-12-01'; EmailSentAt=1765202464000L; EmailStreams=35740602L },
  [pscustomobject]@{ WeekOf='2025-12-08'; EmailSentAt=1765807249000L; EmailStreams=36235610L },
  [pscustomobject]@{ WeekOf='2025-12-15'; EmailSentAt=1766412243000L; EmailStreams=36694932L },
  [pscustomobject]@{ WeekOf='2025-12-22'; EmailSentAt=1767016909000L; EmailStreams=37087169L },
  [pscustomobject]@{ WeekOf='2025-12-29'; EmailSentAt=1767621791000L; EmailStreams=37573631L },
  [pscustomobject]@{ WeekOf='2026-01-05'; EmailSentAt=1768226697000L; EmailStreams=38024921L },
  [pscustomobject]@{ WeekOf='2026-01-12'; EmailSentAt=1768831476000L; EmailStreams=38449924L },
  [pscustomobject]@{ WeekOf='2026-01-19'; EmailSentAt=1769436068000L; EmailStreams=38904764L },
  [pscustomobject]@{ WeekOf='2026-01-26'; EmailSentAt=1770040870000L; EmailStreams=39339510L },
  [pscustomobject]@{ WeekOf='2026-02-02'; EmailSentAt=1770645682000L; EmailStreams=39750934L },
  [pscustomobject]@{ WeekOf='2026-02-09'; EmailSentAt=1771250537000L; EmailStreams=40312074L },
  [pscustomobject]@{ WeekOf='2026-02-16'; EmailSentAt=1771855321000L; EmailStreams=40788869L },
  [pscustomobject]@{ WeekOf='2026-02-23'; EmailSentAt=1772460242000L; EmailStreams=41306614L },
  [pscustomobject]@{ WeekOf='2026-03-02'; EmailSentAt=1773061342000L; EmailStreams=41774678L },
  [pscustomobject]@{ WeekOf='2026-03-09'; EmailSentAt=1773666264000L; EmailStreams=42251363L },
  [pscustomobject]@{ WeekOf='2026-03-16'; EmailSentAt=1774270957000L; EmailStreams=42689563L },
  [pscustomobject]@{ WeekOf='2026-03-23'; EmailSentAt=1774875621000L; EmailStreams=43125588L },
  [pscustomobject]@{ WeekOf='2026-03-30'; EmailSentAt=1775480528000L; EmailStreams=43540123L },
  [pscustomobject]@{ WeekOf='2026-05-04'; EmailSentAt=1778504460000L; EmailStreams=45552854L },
  [pscustomobject]@{ WeekOf='2026-05-11'; EmailSentAt=1779109382000L; EmailStreams=45903824L },
  [pscustomobject]@{ WeekOf='2026-05-18'; EmailSentAt=1779714072000L; EmailStreams=46377895L },
  [pscustomobject]@{ WeekOf='2026-05-25'; EmailSentAt=1780318896000L; EmailStreams=46802122L },
  [pscustomobject]@{ WeekOf='2026-06-01'; EmailSentAt=1780923836000L; EmailStreams=47190350L },
  [pscustomobject]@{ WeekOf='2026-06-08'; EmailSentAt=1781528583000L; EmailStreams=47576224L },
  [pscustomobject]@{ WeekOf='2026-06-15'; EmailSentAt=1782133437000L; EmailStreams=47986298L }
)

function Find-ResultRows {
  param([Parameter(Mandatory=$false)]$Node)
  if ($null -eq $Node) { return $null }

  if ($Node.PSObject -and ($Node.PSObject.Properties.Name -contains 'results')) {
    return @($Node.results)
  }

  if ($Node -is [System.Collections.IEnumerable] -and -not ($Node -is [string])) {
    foreach ($child in $Node) {
      $found = Find-ResultRows $child
      if ($null -ne $found) { return $found }
    }
  }

  if ($Node.PSObject) {
    foreach ($property in $Node.PSObject.Properties) {
      $found = Find-ResultRows $property.Value
      if ($null -ne $found) { return $found }
    }
  }
  return $null
}

function To-JstText {
  param($Milliseconds)
  if ($null -eq $Milliseconds -or [string]::IsNullOrWhiteSpace([string]$Milliseconds)) { return $null }
  return [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$Milliseconds).ToOffset([TimeSpan]::FromHours(9)).ToString('yyyy-MM-dd HH:mm:ss')
}

Push-Location $workerDir
try {
  $results = foreach ($email in $emails) {
    $timestamp = [int64]$email.EmailSentAt
    $window = 7L * 24L * 60L * 60L * 1000L
    $from = $timestamp - $window
    $to = $timestamp + $window

    $sql = @"
WITH candidates AS (
  SELECT observed_at,total_stream_count AS stream_count,'legacy' AS source
  FROM sh_legacy_snapshots
  WHERE total_stream_count IS NOT NULL
    AND observed_at BETWEEN $from AND $to
  UNION ALL
  SELECT observed_at,current_stream_count AS stream_count,'live' AS source
  FROM sh_channel_snapshots
  WHERE current_stream_count IS NOT NULL
    AND observed_at BETWEEN $from AND $to
),
previous_point AS (
  SELECT observed_at,stream_count,source
  FROM candidates
  WHERE observed_at<=$timestamp
  ORDER BY observed_at DESC, CASE source WHEN 'live' THEN 0 ELSE 1 END
  LIMIT 1
),
next_point AS (
  SELECT observed_at,stream_count,source
  FROM candidates
  WHERE observed_at>=$timestamp
  ORDER BY observed_at ASC, CASE source WHEN 'live' THEN 0 ELSE 1 END
  LIMIT 1
)
SELECT
  (SELECT observed_at FROM previous_point) AS previous_at,
  (SELECT stream_count FROM previous_point) AS previous_count,
  (SELECT source FROM previous_point) AS previous_source,
  (SELECT observed_at FROM next_point) AS next_at,
  (SELECT stream_count FROM next_point) AS next_count,
  (SELECT source FROM next_point) AS next_source;
"@

    Write-Host "Validating $($email.WeekOf)..." -ForegroundColor Cyan
    $raw = & npx wrangler d1 execute stationhead-legacy --remote --config ..\site\wrangler.jsonc --json --command=$sql
    if ($LASTEXITCODE -ne 0) { throw "D1 query failed for $($email.WeekOf)" }

    $parsed = ($raw -join "`n") | ConvertFrom-Json
    $row = @(Find-ResultRows $parsed | Select-Object -First 1)[0]

    $previousAt = if ($null -ne $row.previous_at) { [int64]$row.previous_at } else { $null }
    $previousCount = if ($null -ne $row.previous_count) { [int64]$row.previous_count } else { $null }
    $nextAt = if ($null -ne $row.next_at) { [int64]$row.next_at } else { $null }
    $nextCount = if ($null -ne $row.next_count) { [int64]$row.next_count } else { $null }

    $estimated = $null
    if ($null -ne $previousAt -and $null -ne $nextAt -and $nextAt -gt $previousAt) {
      $ratio = ($timestamp - $previousAt) / [double]($nextAt - $previousAt)
      $estimated = [int64][Math]::Round($previousCount + (($nextCount - $previousCount) * $ratio))
    } elseif ($null -ne $previousCount) {
      $estimated = $previousCount
    } elseif ($null -ne $nextCount) {
      $estimated = $nextCount
    }

    $nearestAt = $null
    $nearestCount = $null
    $nearestSource = $null
    if ($null -ne $previousAt -and ($null -eq $nextAt -or [Math]::Abs($timestamp-$previousAt) -le [Math]::Abs($nextAt-$timestamp))) {
      $nearestAt = $previousAt; $nearestCount = $previousCount; $nearestSource = $row.previous_source
    } elseif ($null -ne $nextAt) {
      $nearestAt = $nextAt; $nearestCount = $nextCount; $nearestSource = $row.next_source
    }

    $difference = if ($null -ne $estimated) { [int64]$email.EmailStreams - $estimated } else { $null }
    $differencePercent = if ($null -ne $estimated) { [Math]::Abs($difference) / [double]$email.EmailStreams * 100 } else { $null }
    $distanceMinutes = if ($null -ne $nearestAt) { [Math]::Abs($nearestAt-$timestamp) / 60000.0 } else { $null }

    $status = if ($null -eq $estimated) { 'no_reference' }
      elseif ($distanceMinutes -gt 1440) { 'reference_far' }
      elseif ([Math]::Abs($difference) -le 1000) { 'excellent' }
      elseif ([Math]::Abs($difference) -le 10000) { 'good' }
      elseif ([Math]::Abs($difference) -le 50000 -and $differencePercent -le 0.1) { 'plausible' }
      else { 'mismatch' }

    [pscustomobject]@{
      week_of = $email.WeekOf
      email_sent_jst = To-JstText $timestamp
      email_stream_count = [int64]$email.EmailStreams
      previous_jst = To-JstText $previousAt
      previous_count = $previousCount
      next_jst = To-JstText $nextAt
      next_count = $nextCount
      estimated_count = $estimated
      difference = $difference
      difference_percent = if ($null -ne $differencePercent) { [Math]::Round($differencePercent, 5) } else { $null }
      nearest_distance_minutes = if ($null -ne $distanceMinutes) { [Math]::Round($distanceMinutes, 1) } else { $null }
      nearest_source = $nearestSource
      validation_status = $status
    }
  }

  $results | Export-Csv -Path $outputPath -NoTypeInformation -Encoding UTF8
  $results | Format-Table week_of,email_stream_count,estimated_count,difference,difference_percent,nearest_distance_minutes,validation_status -AutoSize
  Write-Host "`nSaved: $outputPath" -ForegroundColor Green
  Write-Host "`nSummary:" -ForegroundColor Green
  $results | Group-Object validation_status | Sort-Object Name | Select-Object Name,Count | Format-Table -AutoSize
}
finally {
  Pop-Location
}
