param(
  [int]$Port = 4173,
  [string]$FinImpulseToken = $env:FINIMPULSE_TOKEN
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
$script:SymbolCache = $null

Write-Host "StocksAI Market Desk running at http://localhost:$Port/"
Write-Host "Press Ctrl+C to stop."
if ([string]::IsNullOrWhiteSpace($FinImpulseToken)) {
  Write-Host "FinImpulse token missing. Start with -FinImpulseToken YOUR_KEY for live summaries."
}

function Get-ContentType($Path) {
  switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    ".html" { "text/html; charset=utf-8" }
    ".css" { "text/css; charset=utf-8" }
    ".js" { "application/javascript; charset=utf-8" }
    ".json" { "application/json; charset=utf-8" }
    default { "application/octet-stream" }
  }
}

function Send-Response($Stream, [int]$Status, [string]$StatusText, [byte[]]$Body, [string]$ContentType) {
  $header = "HTTP/1.1 $Status $StatusText`r`nContent-Type: $ContentType`r`nContent-Length: $($Body.Length)`r`nConnection: close`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::UTF8.GetBytes($header)
  try {
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($Body.Length -gt 0) {
      $Stream.Write($Body, 0, $Body.Length)
    }
  }
  catch [System.IO.IOException] {}
  catch [System.Net.Sockets.SocketException] {}
  catch {}
}

function Send-Text($Stream, [int]$Status, [string]$StatusText, [string]$Text) {
  $body = [System.Text.Encoding]::UTF8.GetBytes($Text)
  Send-Response $Stream $Status $StatusText $body "text/plain; charset=utf-8"
}

function Get-QueryParam([string]$Query, [string]$Name, [string]$Default) {
  $prefix = "$Name="
  foreach ($part in $Query.TrimStart("?").Split("&")) {
    if ($part.StartsWith($prefix)) {
      return [Uri]::UnescapeDataString($part.Substring($prefix.Length))
    }
  }
  return $Default
}

function Require-FinImpulseToken($Stream) {
  if (-not [string]::IsNullOrWhiteSpace($FinImpulseToken)) {
    return $true
  }

  Send-Text $Stream 500 "Missing Token" "Missing FinImpulse token. Restart server with -FinImpulseToken YOUR_KEY."
  return $false
}

function Invoke-FinImpulse([string]$Path, $Payload) {
  $headers = @{
    "Content-Type" = "application/json"
    "Authorization" = "Bearer $FinImpulseToken"
  }
  $body = $Payload | ConvertTo-Json -Compress
  return Invoke-WebRequest -UseBasicParsing -Uri "https://api.finimpulse.com/v1/$Path" -Method Post -Headers $headers -Body $body
}

function Convert-UnixSecondsToIso($Seconds) {
  if ($null -eq $Seconds) {
    return $null
  }

  try {
    return [DateTimeOffset]::FromUnixTimeSeconds([int64][double]$Seconds).ToString("o")
  }
  catch {
    return $null
  }
}

function Merge-FinImpulseIntoSummary([string]$YahooSummary, [string]$FinImpulseSummary) {
  try {
    $baseRoot = $YahooSummary | ConvertFrom-Json
    $finRoot = $FinImpulseSummary | ConvertFrom-Json
    $base = $baseRoot.result
    $fin = if ($null -ne $finRoot.result) { $finRoot.result } else { $finRoot }

    foreach ($field in @("long_name", "short_name", "currency", "financial_currency", "quote_type", "sector", "industry")) {
      if ($null -ne $fin.$field -and -not [string]::IsNullOrWhiteSpace([string]$fin.$field)) {
        $base | Add-Member -NotePropertyName $field -NotePropertyValue $fin.$field -Force
      }
    }

    foreach ($field in @("display_name", "full_exchange_name", "exchange")) {
      if (($null -eq $base.$field -or [string]::IsNullOrWhiteSpace([string]$base.$field)) -and
          $null -ne $fin.$field -and -not [string]::IsNullOrWhiteSpace([string]$fin.$field)) {
        $base | Add-Member -NotePropertyName $field -NotePropertyValue $fin.$field -Force
      }
    }

    return @{ result = $base } | ConvertTo-Json -Compress -Depth 8
  }
  catch {
    return $YahooSummary
  }
}

function Read-SymbolDirectory([string]$Url, [string]$Exchange) {
  $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -Headers @{ "User-Agent" = "StocksAI/1.0" }
  $lines = $response.Content -split "`n"
  $items = @()

  foreach ($line in $lines) {
    $clean = $line.Trim()
    if ([string]::IsNullOrWhiteSpace($clean) -or $clean.StartsWith("File Creation") -or $clean.StartsWith("Symbol|")) {
      continue
    }

    $parts = $clean.Split("|")
    if ($parts.Length -lt 2) {
      continue
    }

    if ($parts[0] -eq "Symbol" -or $parts[0] -eq "ACT Symbol") {
      continue
    }

    $symbol = $parts[0].Trim()
    $name = $parts[1].Trim()
    if ($symbol -and $name -and $symbol -notmatch "\$" -and $name -notmatch "Test Issue") {
      $items += [pscustomobject]@{
        symbol = $symbol
        displaySymbol = $symbol
        description = $name
        exchange = $Exchange
      }
    }
  }

  return $items
}

function Get-ExchangeSymbols {
  if ($null -ne $script:SymbolCache) {
    return $script:SymbolCache
  }

  $nasdaq = Read-SymbolDirectory "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt" "NASDAQ"
  $otherRaw = Invoke-WebRequest -UseBasicParsing -Uri "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt" -Headers @{ "User-Agent" = "StocksAI/1.0" }
  $nyse = @()
  foreach ($line in ($otherRaw.Content -split "`n")) {
    $clean = $line.Trim()
    if ([string]::IsNullOrWhiteSpace($clean) -or $clean.StartsWith("File Creation") -or $clean.StartsWith("ACT Symbol|")) {
      continue
    }
    $parts = $clean.Split("|")
    if ($parts.Length -lt 4) {
      continue
    }
    if ($parts[2].Trim() -eq "N") {
      $nyse += [pscustomobject]@{
        symbol = $parts[0].Trim()
        displaySymbol = $parts[0].Trim()
        description = $parts[1].Trim()
        exchange = "NYSE"
      }
    }
  }

  $script:SymbolCache = @($nasdaq + $nyse | Sort-Object symbol -Unique)
  return $script:SymbolCache
}

function Get-YahooInterval([string]$Interval) {
  switch ($Interval) {
    "1m" { @{ range = "1d"; interval = "1m" } }
    "5m" { @{ range = "5d"; interval = "1m" } }
    "10m" { @{ range = "5d"; interval = "1m" } }
    "15m" { @{ range = "5d"; interval = "1m" } }
    "30m" { @{ range = "5d"; interval = "1m" } }
    "1h" { @{ range = "1mo"; interval = "5m" } }
    default { @{ range = "1d"; interval = "1m" } }
  }
}

function Get-YahooChartContent([string]$Symbol, [string]$Interval) {
  $config = Get-YahooInterval $Interval
  $marketUrl = "https://query1.finance.yahoo.com/v8/finance/chart/$Symbol" +
    "?region=US&lang=en-US&includePrePost=true&interval=$($config.interval)&range=$($config.range)&corsDomain=finance.yahoo.com"
  $marketResponse = Invoke-WebRequest -UseBasicParsing -Uri $marketUrl -Headers @{ "User-Agent" = "StocksAI/1.0" }
  return $marketResponse.Content
}

function Get-USSessionKey {
  try {
    $eastern = [System.TimeZoneInfo]::FindSystemTimeZoneById("Eastern Standard Time")
    $now = [System.TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $eastern)
    if ($now.DayOfWeek -eq "Saturday" -or $now.DayOfWeek -eq "Sunday") {
      return "CLOSED"
    }
    $minutes = ($now.Hour * 60) + $now.Minute
    if ($minutes -ge 240 -and $minutes -lt 570) { return "PRE" }
    if ($minutes -ge 570 -and $minutes -lt 960) { return "REGULAR" }
    if ($minutes -ge 960 -and $minutes -lt 1200) { return "POST" }
    return "CLOSED"
  }
  catch {
    return "UNKNOWN"
  }
}

function Convert-YahooChartToSummary([string]$Symbol, [string]$Content) {
  $json = $Content | ConvertFrom-Json
  $result = $json.chart.result[0]
  $meta = $result.meta
  $quote = $result.indicators.quote[0]
  $opens = @($quote.open | Where-Object { $null -ne $_ })
  $highs = @($quote.high | Where-Object { $null -ne $_ })
  $lows = @($quote.low | Where-Object { $null -ne $_ })
  $closes = @($quote.close | Where-Object { $null -ne $_ })
  $volumes = @($quote.volume | Where-Object { $null -ne $_ })

  $lastClose = if ($closes.Count -gt 0) { [double]$closes[$closes.Count - 1] } else { [double]$meta.regularMarketPrice }
  $marketState = if ($meta.marketState) { [string]$meta.marketState } else { "UNKNOWN" }
  $preMarket = if ($null -ne $meta.preMarketPrice) { [double]$meta.preMarketPrice } else { $null }
  $postMarket = if ($null -ne $meta.postMarketPrice) { [double]$meta.postMarketPrice } else { $null }
  $regularMarket = if ($null -ne $meta.regularMarketPrice) { [double]$meta.regularMarketPrice } else { $lastClose }
  $regularMarketTime = Convert-UnixSecondsToIso $meta.regularMarketTime
  $preMarketTime = Convert-UnixSecondsToIso $meta.preMarketTime
  $postMarketTime = Convert-UnixSecondsToIso $meta.postMarketTime
  $sessionKey = Get-USSessionKey

  if ($null -eq $preMarket -and $sessionKey -eq "PRE" -and [Math]::Abs($lastClose - $regularMarket) -gt 0.0001) {
    $preMarket = $lastClose
  }
  if ($null -eq $postMarket -and ($sessionKey -eq "POST" -or $sessionKey -eq "CLOSED") -and [Math]::Abs($lastClose - $regularMarket) -gt 0.0001) {
    $postMarket = $lastClose
  }
  if ($marketState -eq "UNKNOWN" -and $sessionKey -ne "UNKNOWN") {
    $marketState = $sessionKey
  }

  $currentPrice = $regularMarket

  $previous = if ($null -ne $meta.previousClose) { [double]$meta.previousClose } elseif ($null -ne $meta.chartPreviousClose) { [double]$meta.chartPreviousClose } else { $lastClose }
  $open = if ($opens.Count -gt 0) { [double]$opens[0] } else { $lastClose }
  $high = if ($highs.Count -gt 0) { ($highs | Measure-Object -Maximum).Maximum } else { $lastClose }
  $low = if ($lows.Count -gt 0) { ($lows | Measure-Object -Minimum).Minimum } else { $lastClose }
  $volume = if ($null -ne $meta.regularMarketVolume) { [double]$meta.regularMarketVolume } elseif ($volumes.Count -gt 0) { ($volumes | Measure-Object -Sum).Sum } else { 0 }

  return @{
    result = @{
      symbol = $Symbol
      display_name = if ($meta.longName) { $meta.longName } elseif ($meta.shortName) { $meta.shortName } else { $Symbol }
      current_price = $currentPrice
      regular_market_price = $regularMarket
      pre_market_price = $preMarket
      post_market_price = $postMarket
      regular_market_time = $regularMarketTime
      pre_market_time = $preMarketTime
      post_market_time = $postMarketTime
      previous_close = $previous
      regular_market_previous_close = $previous
      open = $open
      regular_market_open = $open
      day_high = $high
      regular_market_day_high = $high
      day_low = $low
      regular_market_day_low = $low
      volume = $volume
      regular_market_volume = $volume
      market_state = $marketState
      full_exchange_name = if ($meta.fullExchangeName) { $meta.fullExchangeName } elseif ($meta.exchangeName) { $meta.exchangeName } else { "US" }
    }
  } | ConvertTo-Json -Compress
}

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $stream.ReadTimeout = 2000
      $buffer = [byte[]]::new(4096)
      try {
        $read = $stream.Read($buffer, 0, $buffer.Length)
      }
      catch [System.IO.IOException] {
        continue
      }
      catch {
        continue
      }

      if ($read -le 0) {
        continue
      }

      $requestText = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
      $requestLine = $requestText.Split("`r`n")[0]
      if ([string]::IsNullOrWhiteSpace($requestLine)) {
        continue
      }

      $parts = $requestLine.Split(" ")
      $method = $parts[0]
      $requestPath = if ($parts.Length -gt 1) { $parts[1] } else { "/" }
      $pathOnly = $requestPath.Split("?")[0]
      $query = if ($requestPath.Contains("?")) { $requestPath.Substring($requestPath.IndexOf("?")) } else { "" }
      $path = [Uri]::UnescapeDataString($pathOnly.TrimStart("/"))
      if ([string]::IsNullOrWhiteSpace($path)) {
        $path = "index.html"
      }

      if ($path -eq "api/summary") {
        $symbol = (Get-QueryParam $query "symbol" "AAPL").ToUpperInvariant() -replace "[^A-Z0-9\.-]", ""
        try {
          $summaryJson = Convert-YahooChartToSummary $symbol (Get-YahooChartContent $symbol "1m")

          if (-not [string]::IsNullOrWhiteSpace($FinImpulseToken)) {
            try {
              $finImpulseSummary = Invoke-FinImpulse "summary" @{ symbol = $symbol }
              $summaryJson = Merge-FinImpulseIntoSummary $summaryJson $finImpulseSummary.Content
            }
            catch {}
          }

          $body = [System.Text.Encoding]::UTF8.GetBytes($summaryJson)
          Send-Response $stream 200 "OK" $body "application/json; charset=utf-8"
        }
        catch {
          try {
            if ([string]::IsNullOrWhiteSpace($FinImpulseToken)) {
              throw "Missing FinImpulse token"
            }

            $summary = Invoke-FinImpulse "summary" @{ symbol = $symbol }
            $body = [System.Text.Encoding]::UTF8.GetBytes($summary.Content)
            Send-Response $stream 200 "OK" $body "application/json; charset=utf-8"
          }
          catch {
            Send-Text $stream 502 "Bad Gateway" "Could not fetch summary for $symbol."
          }
        }
        continue
      }

      if ($path -eq "api/symbols") {
        $queryText = (Get-QueryParam $query "q" "").ToUpperInvariant()
        try {
          $symbols = Get-ExchangeSymbols
          if (-not [string]::IsNullOrWhiteSpace($queryText)) {
            $starts = @($symbols | Where-Object { $_.symbol.ToUpperInvariant().StartsWith($queryText) -or $_.description.ToUpperInvariant().StartsWith($queryText) })
            $contains = @($symbols | Where-Object {
              -not ($_.symbol.ToUpperInvariant().StartsWith($queryText) -or $_.description.ToUpperInvariant().StartsWith($queryText)) -and
              ($_.symbol.ToUpperInvariant().Contains($queryText) -or $_.description.ToUpperInvariant().Contains($queryText))
            })
            $symbols = @($starts + $contains)
          }
          $selectedSymbols = @($symbols | Select-Object -First 80 symbol,displaySymbol,description,exchange)
          $payload = $selectedSymbols | ConvertTo-Json -Compress
          if ([string]::IsNullOrWhiteSpace($payload)) {
            $payload = "[]"
          }
          $body = [System.Text.Encoding]::UTF8.GetBytes($payload)
          Send-Response $stream 200 "OK" $body "application/json; charset=utf-8"
        }
        catch {
          Send-Text $stream 502 "Bad Gateway" "Could not load NYSE/Nasdaq symbol list."
        }
        continue
      }

      if ($path -eq "api/chart") {
        $symbol = (Get-QueryParam $query "symbol" "AAPL").ToUpperInvariant() -replace "[^A-Z0-9\.-]", ""
        $requestedInterval = Get-QueryParam $query "interval" "1m"

        try {
          $body = [System.Text.Encoding]::UTF8.GetBytes((Get-YahooChartContent $symbol $requestedInterval))
          Send-Response $stream 200 "OK" $body "application/json; charset=utf-8"
        }
        catch {
          Send-Text $stream 502 "Bad Gateway" "Could not fetch chart data for $symbol."
        }
        continue
      }

      if ($method -ne "GET") {
        Send-Text $stream 405 "Method Not Allowed" "Method not allowed"
        continue
      }

      $filePath = Join-Path $root $path
      $resolvedRoot = [System.IO.Path]::GetFullPath($root)
      $resolvedFile = [System.IO.Path]::GetFullPath($filePath)

      if (-not $resolvedFile.StartsWith($resolvedRoot)) {
        Send-Text $stream 403 "Forbidden" "Forbidden"
      }
      elseif (-not [System.IO.File]::Exists($resolvedFile)) {
        Send-Text $stream 404 "Not Found" "Not found"
      }
      else {
        $body = [System.IO.File]::ReadAllBytes($resolvedFile)
        Send-Response $stream 200 "OK" $body (Get-ContentType $resolvedFile)
      }
    }
    finally {
      $client.Close()
    }
  }
}
finally {
  $listener.Stop()
}
