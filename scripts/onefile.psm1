# scripts/onefile.psm1 — shared helpers for the one-file backup / restore pair
# (backup-onefile.ps1, restore-onefile.ps1).
#
# Everything here is deliberately dependency-free and side-effect-free so it can
# be unit-tested without Docker (see onefile.Tests.ps1). The Docker calls live in
# the two scripts.
#
# The archive layout is byte-compatible with scripts/platform-backup.sh, so a file
# made by either tool can be restored by the other:
#   manifest.json               parts + sizes + sha256, row counts, key fingerprint
#   database.dump               pg_dump -Fc  (schema + data + migration history)
#   objects/minio-data.tar.gz   every deposit proof + avatar
#   RESTORE.txt                 instructions that work without this repo

Set-StrictMode -Version Latest

# ── .env parsing ───────────────────────────────────────────────────────────
# Dot-source equivalent: returns a hashtable of KEY=VALUE. Quotes are stripped,
# comments and blanks skipped. Values are NOT expanded — we only read them.
function Get-DotEnv {
  param([Parameter(Mandatory = $true)][string]$Path)
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  foreach ($line in (Get-Content -LiteralPath $Path)) {
    $t = $line.Trim()
    if (-not $t) { continue }
    if ($t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -lt 1) { continue }
    $k = $t.Substring(0, $i).Trim()
    $v = $t.Substring($i + 1).Trim()
    if ($v.Length -ge 2) {
      $dq = $v.StartsWith('"') -and $v.EndsWith('"')
      $sq = $v.StartsWith("'") -and $v.EndsWith("'")
      if ($dq -or $sq) { $v = $v.Substring(1, $v.Length - 2) }
    }
    $map[$k] = $v
  }
  return $map
}

# A .env value, or a default when absent/empty.
function Get-DotEnvValue {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Map,
    [Parameter(Mandatory = $true)][string]$Key,
    [string]$Default = ''
  )
  if ($Map.ContainsKey($Key) -and $Map[$Key]) { return [string]$Map[$Key] }
  return $Default
}

# ── hashing / fingerprints ─────────────────────────────────────────────────
# MUST stay identical to the bash side: sha256sum of the raw string, first 16 hex
# chars. Also used for ENCRYPTION_KEY_PREVIOUS entries, so a backup's fingerprint
# can be matched against any key the target deployment still holds.
function Get-KeyFingerprint {
  param([string]$Key)
  if ([string]::IsNullOrEmpty($Key)) { return 'none' }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Key))
  } finally {
    $sha.Dispose()
  }
  $hex = ($hash | ForEach-Object { $_.ToString('x2') }) -join ''
  return $hex.Substring(0, 16)
}

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# ── manifest ───────────────────────────────────────────────────────────────
# One part entry: { bytes, sha256 } — the same shape platform-backup.sh writes.
function New-BackupPart {
  param([Parameter(Mandatory = $true)][string]$Path)
  $item = Get-Item -LiteralPath $Path
  return [ordered]@{ bytes = [int64]$item.Length; sha256 = (Get-FileSha256 -Path $Path) }
}

function New-BackupManifest {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Parts,      # name -> {bytes, sha256}
    [Parameter(Mandatory = $true)][hashtable]$Counts,     # table -> int (or $null)
    [string]$KeyFingerprint = 'none',
    [string]$AppCommit = 'unknown',
    [string]$HostName = ''
  )
  if (-not $HostName) {
    if ($env:COMPUTERNAME) { $HostName = $env:COMPUTERNAME }
    elseif ($env:HOSTNAME) { $HostName = $env:HOSTNAME }
    else { $HostName = 'unknown' }
  }
  $manifest = [ordered]@{
    format    = 'casino-platform-backup'
    version   = 1
    createdAt = ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))
    host      = $HostName
    appCommit = $AppCommit
    parts     = $Parts
    counts    = $Counts
    encryption = [ordered]@{
      keyFingerprint = $KeyFingerprint
      note           = 'sha256(ENCRYPTION_KEY) truncated to 16 hex chars. NOT reversible. If the restored stack has a different ENCRYPTION_KEY, saved payout-account details will be unreadable.'
    }
  }
  return ($manifest | ConvertTo-Json -Depth 6)
}

function Read-BackupManifest {
  param([Parameter(Mandatory = $true)][string]$ExtractDir)
  $path = Join-Path $ExtractDir 'manifest.json'
  if (-not (Test-Path -LiteralPath $path)) {
    throw "manifest.json is missing — this is not a casino platform backup archive"
  }
  $m = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  if ($m.format -ne 'casino-platform-backup') {
    throw "unexpected archive format: $($m.format)"
  }
  return $m
}

# Verifies every part in the manifest: file present, size equal, sha256 equal.
# Throws on the first mismatch — a corrupt archive must stop before it touches a
# live database.
function Assert-BackupParts {
  param(
    [Parameter(Mandatory = $true)]$Manifest,
    [Parameter(Mandatory = $true)][string]$ExtractDir
  )
  $results = @()
  foreach ($name in $Manifest.parts.PSObject.Properties.Name) {
    $expected = $Manifest.parts.$name
    # manifest keys use forward slashes (objects/minio-data.tar.gz)
    $local = Join-Path $ExtractDir ($name -replace '/', [IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $local)) {
      throw "archive is incomplete: $name is missing"
    }
    $actualBytes = (Get-Item -LiteralPath $local).Length
    if ($expected.bytes -and ($actualBytes -ne [int64]$expected.bytes)) {
      throw "size mismatch for ${name}: expected $($expected.bytes), got $actualBytes"
    }
    $actualSha = Get-FileSha256 -Path $local
    if ($actualSha -ne $expected.sha256) {
      throw "checksum mismatch for ${name}: archive is corrupt or was modified"
    }
    $results += $name
  }
  return $results
}

# The set of key fingerprints a target deployment can read: its current key plus
# every retired key in ENCRYPTION_KEY_PREVIOUS (comma separated).
function Get-ReadableKeyFingerprints {
  param(
    [string]$EncryptionKey,
    [string]$EncryptionKeyPrevious
  )
  $out = @()
  if ($EncryptionKey) { $out += Get-KeyFingerprint -Key $EncryptionKey }
  if ($EncryptionKeyPrevious) {
    foreach ($k in ($EncryptionKeyPrevious -split ',')) {
      $t = $k.Trim()
      if ($t) { $out += Get-KeyFingerprint -Key $t }
    }
  }
  # Plain output (no comma trick): PowerShell enumerates what a function emits,
  # so an empty result arrives as nothing at all. Callers that need a count must
  # write @(Get-ReadableKeyFingerprints ...) — the standard idiom.
  return $out
}

# ── misc ───────────────────────────────────────────────────────────────────
function Format-Bytes {
  param([Parameter(Mandatory = $true)][int64]$Bytes)
  if ($Bytes -ge 1073741824) { return ('{0:N2} GiB' -f ($Bytes / 1073741824)) }
  if ($Bytes -ge 1048576) { return ('{0:N1} MiB' -f ($Bytes / 1048576)) }
  if ($Bytes -ge 1024) { return ('{0:N1} KiB' -f ($Bytes / 1024)) }
  return "$Bytes B"
}

# SQL that psql can be pointed at with -f, avoiding all quote-mangling between
# PowerShell, docker.exe and the container shell.
function Get-CountsSql {
  param([Parameter(Mandatory = $true)][string[]]$Tables)
  $lines = foreach ($t in $Tables) { "SELECT '$t', COUNT(*) FROM ""$t"";" }
  return ($lines -join "`n") + "`n"
}

Export-ModuleMember -Function Get-DotEnv, Get-DotEnvValue, Get-KeyFingerprint, Get-FileSha256,
  New-BackupPart, New-BackupManifest, Read-BackupManifest, Assert-BackupParts,
  Get-ReadableKeyFingerprints, Format-Bytes, Get-CountsSql
