$ErrorActionPreference = 'Stop'

$openssl = 'C:\Program Files\Git\usr\bin\openssl.exe'
if (-not (Test-Path -LiteralPath $openssl)) {
  throw 'OpenSSL non trovato. Installa Git for Windows oppure aggiorna il percorso nello script.'
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('fpt-vapid-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null

try {
  $pem = Join-Path $tempRoot 'private.pem'
  $publicDer = Join-Path $tempRoot 'public.der'
  $privateDer = Join-Path $tempRoot 'private.der'

  & $openssl ecparam -name prime256v1 -genkey -noout -out $pem
  & $openssl ec -in $pem -pubout -conv_form uncompressed -outform DER -out $publicDer
  & $openssl ec -in $pem -outform DER -out $privateDer

  $pubBytes = [IO.File]::ReadAllBytes($publicDer)
  $privBytes = [IO.File]::ReadAllBytes($privateDer)
  [byte[]]$publicKey = $pubBytes[($pubBytes.Length - 65)..($pubBytes.Length - 1)]
  [byte[]]$privateKey = $privBytes[7..38]

  [byte[]]$secret = New-Object byte[] 32
  $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
  $rng.GetBytes($secret)
  $rng.Dispose()

  function ConvertTo-Base64Url([byte[]]$bytes) {
    [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  }

  Write-Host ''
  Write-Host 'Copia questi valori direttamente in Netlify > Environment variables:' -ForegroundColor Green
  Write-Host ('VAPID_PUBLIC_KEY=' + (ConvertTo-Base64Url $publicKey))
  Write-Host ('VAPID_PRIVATE_KEY=' + (ConvertTo-Base64Url $privateKey))
  Write-Host ('PUSH_WEBHOOK_SECRET=' + (ConvertTo-Base64Url $secret))
  Write-Host ''
  Write-Host 'Non salvarli nel repository e non inviarli in chat.' -ForegroundColor Yellow
}
finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
