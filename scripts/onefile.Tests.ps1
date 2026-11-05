# scripts/onefile.Tests.ps1 — tests for the one-file backup helpers.
#
# No Pester needed:   pwsh -File scripts/onefile.Tests.ps1
#                     powershell -File scripts\onefile.Tests.ps1
#
# These cover the pure logic — hashing, fingerprints, .env parsing, the manifest,
# checksum verification and the packaging step. The Docker calls themselves are
# exercised by running the two scripts against a live stack.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'onefile.psm1') -Force

$script:passed = 0
$script:failed = 0

function Assert-Equal {
  param($Expected, $Actual, [string]$Label)
  if ("$Expected" -eq "$Actual") {
    $script:passed++
    Write-Host "  ok    $Label" -ForegroundColor Green
  } else {
    $script:failed++
    Write-Host "  FAIL  $Label" -ForegroundColor Red
    Write-Host "        expected: $Expected"
    Write-Host "        actual  : $Actual"
  }
}

function Assert-Throws {
  param([scriptblock]$Block, [string]$Label)
  try {
    & $Block | Out-Null
    $script:failed++
    Write-Host "  FAIL  $Label (expected an error, none was raised)" -ForegroundColor Red
  } catch {
    $script:passed++
    Write-Host "  ok    $Label" -ForegroundColor Green
  }
}

Write-Host ""
Write-Host "one-file backup helpers" -ForegroundColor Cyan

# ── key fingerprints must match the bash implementation exactly ────────────
# Expected values produced by:  printf '%s' '<key>' | sha256sum | cut -c1-16
Write-Host "key fingerprint (must agree with bash sha256sum)"
Assert-Equal 'a8ae6e6ee929abea' (Get-KeyFingerprint -Key '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef') 'dev default key'
Assert-Equal '1827da6cb83a0bfc' (Get-KeyFingerprint -Key 'da97acfc120904f7a5a860250c8c409e74d629d47ca02ab78dfa4ba0b1901c1f') 'a 64-hex deployment key'
Assert-Equal 'none' (Get-KeyFingerprint -Key '') 'empty key reports none'
Assert-Equal 16 (Get-KeyFingerprint -Key 'anything').Length 'fingerprint is 16 hex chars'

Write-Host "file hashing"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("onefile-tests-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  $payload = Join-Path $tmp 'payload.bin'
  [IO.File]::WriteAllText($payload, 'casino test payload')
  # Expected value produced by:  sha256sum /tmp/fpfile.bin | cut -d' ' -f1
  Assert-Equal '84a41e166e08c25d2b115692510f9126b557e1d3a1101678bd7f5610d9ba341e' (Get-FileSha256 -Path $payload) 'sha256 of a text payload'

  # ── .env parsing ─────────────────────────────────────────────────────────
  Write-Host ".env parsing"
  $envFile = Join-Path $tmp '.env'
  @(
    '# a comment',
    '',
    'PG_USER=casino',
    'PG_DB="quoted_db"',
    "REDIS_PASSWORD='single-quoted-pw'",
    'ENCRYPTION_KEY=da97acfc120904f7a5a860250c8c409e74d629d47ca02ab78dfa4ba0b1901c1f',
    'EMPTY=',
    'SPACED = value with spaces '
  ) | Set-Content -LiteralPath $envFile
  $map = Get-DotEnv -Path $envFile
  Assert-Equal 'casino' $map['PG_USER'] 'plain value'
  Assert-Equal 'quoted_db' $map['PG_DB'] 'double quotes stripped'
  Assert-Equal 'single-quoted-pw' $map['REDIS_PASSWORD'] 'single quotes stripped'
  Assert-Equal 'value with spaces' $map['SPACED'] 'key trimmed, value trimmed'
  Assert-Equal 'casino' (Get-DotEnvValue -Map $map -Key 'pg_user' -Default 'fallback') 'missing key falls back'
  Assert-Equal 'fallback' (Get-DotEnvValue -Map $map -Key 'NOT_THERE' -Default 'fallback') 'absent key falls back'
  Assert-Equal 'casino' (Get-DotEnvValue -Map $map -Key 'PG_USER' -Default 'x') 'present key wins'

  # ── readable-key set (current + retired, comma separated) ────────────────
  Write-Host "readable key fingerprints"
  $readable = Get-ReadableKeyFingerprints -EncryptionKey 'da97acfc120904f7a5a860250c8c409e74d629d47ca02ab78dfa4ba0b1901c1f' -EncryptionKeyPrevious '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef, secondkey'
  Assert-Equal 3 $readable.Count 'current + two retired keys'
  Assert-Equal $true ($readable -contains '1827da6cb83a0bfc') 'current key fingerprint is present'
  Assert-Equal $true ($readable -contains 'a8ae6e6ee929abea') 'retired key fingerprint is present'
  Assert-Equal 0 (@(Get-ReadableKeyFingerprints -EncryptionKey '' -EncryptionKeyPrevious '').Count) 'no keys -> empty set'

  # ── counts SQL must survive PowerShell + docker quoting ──────────────────
  Write-Host "counts SQL"
  $sql = Get-CountsSql -Tables @('User', 'Wallet')
  Assert-Equal $true ($sql.Contains('SELECT ''User'', COUNT(*) FROM "User";')) 'quotes the mixed-case table name'
  Assert-Equal $true ($sql.EndsWith("`n")) 'ends with a newline'
  Assert-Equal 2 (($sql.Trim() -split "`n").Count) 'one statement per table'

  # ── manifest + checksum verification ────────────────────────────────────
  Write-Host "manifest and verification"
  $dumpDir = Join-Path $tmp 'parts'
  New-Item -ItemType Directory -Force -Path (Join-Path $dumpDir 'objects') | Out-Null
  $dump = Join-Path $dumpDir 'database.dump'
  [IO.File]::WriteAllText($dump, 'fake pg_dump payload')
  $obj = Join-Path (Join-Path $dumpDir 'objects') 'minio-data.tar.gz'
  [IO.File]::WriteAllText($obj, 'fake objects payload')

  $parts = [ordered]@{}
  $parts['database.dump'] = New-BackupPart -Path $dump
  $parts['objects/minio-data.tar.gz'] = New-BackupPart -Path $obj
  $counts = [ordered]@{ User = 42; Wallet = 42; NoRows = $null }

  $json = New-BackupManifest -Parts $parts -Counts $counts -KeyFingerprint '1827da6cb83a0bfc' -AppCommit 'abc1234'
  [IO.File]::WriteAllText((Join-Path $dumpDir 'manifest.json'), $json)

  $parsed = $json | ConvertFrom-Json
  Assert-Equal 'casino-platform-backup' $parsed.format 'manifest format tag'
  Assert-Equal 1 $parsed.version 'manifest version'
  Assert-Equal '1827da6cb83a0bfc' $parsed.encryption.keyFingerprint 'fingerprint round-trips'
  Assert-Equal 42 $parsed.counts.User 'counts round-trip'
  Assert-Equal 'fake pg_dump payload'.Length $parsed.parts.'database.dump'.bytes 'part size recorded'
  Assert-Equal $true ([bool]$parsed.parts.'objects/minio-data.tar.gz'.sha256) 'nested part recorded'

  $manifest = Read-BackupManifest -ExtractDir $dumpDir
  $verified = Assert-BackupParts -Manifest $manifest -ExtractDir $dumpDir
  Assert-Equal 2 $verified.Count 'both parts verified'

  # tampering must be caught before anything is overwritten
  [IO.File]::WriteAllText($dump, 'fake pg_dump payload TAMPERED')
  Assert-Throws { Assert-BackupParts -Manifest $manifest -ExtractDir $dumpDir } 'a modified part is detected'
  [IO.File]::WriteAllText($dump, 'fake pg_dump payload')

  # a missing part must be caught too
  Remove-Item -LiteralPath $obj -Force
  Assert-Throws { Assert-BackupParts -Manifest $manifest -ExtractDir $dumpDir } 'a missing part is detected'
  [IO.File]::WriteAllText($obj, 'fake objects payload')

  Assert-Throws { Read-BackupManifest -ExtractDir $tmp } 'a directory without a manifest is rejected'

  # ── packaging, exactly as the backup script invokes it ───────────────────
  Write-Host "packaging"
  [IO.File]::WriteAllText((Join-Path $dumpDir 'RESTORE.txt'), 'instructions')
  $packed = Join-Path $tmp 'packed.tar.gz'
  & tar -czf $packed -C $dumpDir manifest.json database.dump RESTORE.txt objects
  Assert-Equal 0 $LASTEXITCODE 'tar creates the archive'
  Assert-Equal $true (Test-Path -LiteralPath $packed) 'archive exists'
  Assert-Equal $true ((Get-Item -LiteralPath $packed).Length -gt 0) 'archive is not empty'

  $unpacked = Join-Path $tmp 'unpacked'
  New-Item -ItemType Directory -Force -Path $unpacked | Out-Null
  & tar -xzf $packed -C $unpacked
  Assert-Equal 0 $LASTEXITCODE 'tar extracts the archive'
  Assert-Equal $true (Test-Path -LiteralPath (Join-Path $unpacked 'manifest.json')) 'manifest survives the round trip'
  Assert-Equal $true (Test-Path -LiteralPath (Join-Path $unpacked 'objects/minio-data.tar.gz')) 'nested objects survive the round trip'
  $roundTrip = Read-BackupManifest -ExtractDir $unpacked
  Assert-Equal 2 (Assert-BackupParts -Manifest $roundTrip -ExtractDir $unpacked).Count 'checksums still verify after the round trip'

  # ── formatting ───────────────────────────────────────────────────────────
  Write-Host "byte formatting"
  Assert-Equal '512 B' (Format-Bytes -Bytes 512) 'bytes'
  Assert-Equal '1.5 KiB' (Format-Bytes -Bytes 1536) 'kib'
  Assert-Equal '2.0 MiB' (Format-Bytes -Bytes 2097152) 'mib'
  Assert-Equal '1.00 GiB' (Format-Bytes -Bytes 1073741824) 'gib'
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host ("  {0} passed, {1} failed" -f $script:passed, $script:failed) -ForegroundColor $(if ($script:failed) { 'Red' } else { 'Green' })
Write-Host ""
if ($script:failed) { exit 1 } else { exit 0 }
