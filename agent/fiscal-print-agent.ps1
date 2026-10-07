<#
  Fiscal print agent for a Zoho POS till (Windows PowerShell 5.1+, nothing to install).

  Every second it asks the fiscal print service for the next receipt for this
  printer and sends it to the printer as raw ESC/POS, then reports back
  whether it printed. Leave it running while the till is open.

  USB / Windows-installed printer (use the name shown in Printers & scanners):
    powershell -ExecutionPolicy Bypass -File fiscal-print-agent.ps1 `
      -Server https://zoho-pos-fiscal-print.vercel.app -Key <admin key> `
      -PrinterId HEAD-OFFICE-TILL-1 -PrinterName "POS-80"

  Network printer (raw port 9100):
    ... -PrinterId HEAD-OFFICE-TILL-1 -PrinterIp 192.168.1.50

  Test the printer without the service:  add -TestPrint
#>
param(
  [Parameter(Mandatory = $true)] [string] $Server,
  [Parameter(Mandatory = $true)] [string] $Key,
  [Parameter(Mandatory = $true)] [string] $PrinterId,
  [string] $PrinterName,
  [string] $PrinterIp,
  [int] $PrinterPort = 9100,
  [int] $IntervalMs = 1000,
  [switch] $TestPrint
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not $PrinterName -and -not $PrinterIp) { throw 'Give -PrinterName (Windows printer) or -PrinterIp (network printer).' }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool OpenPrinter(string name, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool StartDocPrinter(IntPtr h, int level, DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] b, int n, out int written);
  public static void Send(string printer, string docName, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("Cannot open printer '" + printer + "' (error " + Marshal.GetLastWin32Error() + ")");
    try {
      var di = new DOCINFO { pDocName = docName, pDataType = "RAW" };
      if (!StartDocPrinter(h, 1, di)) throw new Exception("StartDocPrinter failed (error " + Marshal.GetLastWin32Error() + ")");
      StartPagePrinter(h);
      int written;
      bool ok = WritePrinter(h, data, data.Length, out written);
      EndPagePrinter(h);
      EndDocPrinter(h);
      if (!ok || written != data.Length) throw new Exception("WritePrinter failed (error " + Marshal.GetLastWin32Error() + ")");
    } finally { ClosePrinter(h); }
  }
}
'@

function Send-ToPrinter([byte[]] $bytes, [string] $docName) {
  if ($PrinterIp) {
    $client = New-Object Net.Sockets.TcpClient
    try {
      $client.Connect($PrinterIp, $PrinterPort)
      $stream = $client.GetStream()
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush()
    } finally { $client.Close() }
  } else {
    [RawPrinter]::Send($PrinterName, $docName, $bytes)
  }
}

if ($TestPrint) {
  $esc = [byte[]](0x1b, 0x40) + [Text.Encoding]::ASCII.GetBytes("Fiscal print agent test`n$PrinterId`n$(Get-Date)`n`n`n") + [byte[]](0x1d, 0x56, 0x42, 3)
  Send-ToPrinter $esc 'agent test'
  Write-Host 'Test page sent.'
  return
}

$base = $Server.TrimEnd('/')
$headers = @{ 'x-admin-key' = $Key }
Write-Host "Fiscal print agent: printer '$PrinterId' -> $(if ($PrinterIp) { "$PrinterIp`:$PrinterPort" } else { $PrinterName }). Ctrl+C to stop."

while ($true) {
  try {
    $body = @{ printer = $PrinterId } | ConvertTo-Json -Compress
    $res = Invoke-RestMethod -Method Post -Uri "$base/agent/next" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 15
    if ($res.job) {
      $job = $res.job
      $ok = $true; $detail = ''
      try {
        Send-ToPrinter ([Convert]::FromBase64String($job.data)) "Receipt $($job.number)"
        Write-Host "$(Get-Date -Format HH:mm:ss) printed $($job.number)"
      } catch {
        $ok = $false; $detail = $_.Exception.Message
        Write-Warning "$(Get-Date -Format HH:mm:ss) $($job.number) failed: $detail"
      }
      $done = @{ jobId = $job.id; ok = $ok; detail = $detail } | ConvertTo-Json -Compress
      Invoke-RestMethod -Method Post -Uri "$base/agent/done" -Headers $headers -ContentType 'application/json' -Body $done -TimeoutSec 15 | Out-Null
      continue  # more jobs may be waiting
    }
  } catch {
    Write-Warning "$(Get-Date -Format HH:mm:ss) service unreachable: $($_.Exception.Message)"
    Start-Sleep -Seconds 5
  }
  Start-Sleep -Milliseconds $IntervalMs
}
