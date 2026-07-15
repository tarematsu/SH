$ErrorActionPreference = 'Stop'
$OracleArgs = [string[]]$args

function Get-ListeningChromePort {
    $processes = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
        Where-Object { $_.CommandLine -match '--remote-debugging-port[= ](\d+)' }

    foreach ($process in $processes) {
        $port = [int]$Matches[1]
        try {
            $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$port/json/version"
            if ($response.StatusCode -eq 200) {
                return $port
            }
        } catch {
            # A stale Chrome process or a port that closed during discovery.
        }
    }

    return $null
}

$hasExplicitBrowserTarget = $OracleArgs -match '^--remote-chrome$|^--remote-host$|^--browser-attach-running$'
if ($hasExplicitBrowserTarget) {
    & npx -y @steipete/oracle@latest @OracleArgs
    exit $LASTEXITCODE
}

$port = Get-ListeningChromePort
if ($null -eq $port) {
    Write-Error 'No running Chrome DevTools endpoint was found. Start signed-in Chrome with remote debugging, then retry Oracle.'
    exit 1
}

Write-Host "[oracle-safe] Using existing Chrome DevTools at 127.0.0.1:$port"
& npx -y @steipete/oracle@latest --remote-chrome "127.0.0.1:$port" @OracleArgs
exit $LASTEXITCODE
