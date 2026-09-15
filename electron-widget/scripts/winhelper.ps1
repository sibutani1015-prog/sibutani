# 그리드 데스크: "카톡 붙이기" 기능에서만 쓰는 창 위치 제어 도우미.
# 위젯(Electron) 프로세스가 아닌 다른 프로그램(예: 카카오톡)의 창을 옮기거나
# 최소화/복원하려면 Windows API(user32.dll)가 필요해서, 네이티브 npm 모듈을
# 새로 추가하는 대신 이 스크립트 하나로 처리함.
param(
  [string]$Action,
  [string]$Process = '',
  [string]$Title = '',
  [int]$X = 0,
  [int]$Y = 0
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class GriddeskWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@

function Get-VisibleWindows {
  $result = New-Object System.Collections.Generic.List[PSObject]
  $callback = {
    param($hwnd, $lparam)
    if ([GriddeskWin32]::IsWindowVisible($hwnd)) {
      $sb = New-Object System.Text.StringBuilder 256
      [GriddeskWin32]::GetWindowText($hwnd, $sb, 256) | Out-Null
      $t = $sb.ToString()
      if ($t -ne '') {
        [uint32]$procId = 0
        [GriddeskWin32]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
        $pname = ''
        try { $pname = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
        $result.Add([PSCustomObject]@{ Handle = $hwnd.ToInt64(); Title = $t; Process = $pname })
      }
    }
    return $true
  }
  [GriddeskWin32]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
  return $result
}

# 프로세스 이름은 같고 제목은 조금 달라질 수 있어서(안읽은 메시지 수 표시 등)
# 정확히 일치 -> 서로 포함 -> 그 프로세스의 아무 창이나 순으로 관대하게 찾음.
function Find-Target([string]$proc, [string]$title) {
  $wins = @(Get-VisibleWindows | Where-Object { $_.Process -eq $proc })
  if ($wins.Count -eq 0) { return $null }
  $exact = @($wins | Where-Object { $_.Title -eq $title })
  if ($exact.Count -gt 0) { return $exact[0] }
  $contains = @($wins | Where-Object { $_.Title.Contains($title) -or $title.Contains($_.Title) })
  if ($contains.Count -gt 0) { return $contains[0] }
  return $wins[0]
}

switch ($Action) {
  'Pick' {
    # 위젯 쪽에서 먼저 안내한 뒤 이 스크립트를 실행함: 사용자가 이 3초 사이에
    # 카카오톡 창을 클릭해서 앞으로 가져오면, 그 창을 "현재 활성 창"으로 잡음.
    Start-Sleep -Seconds 3
    $h = [GriddeskWin32]::GetForegroundWindow()
    [uint32]$procId = 0
    [GriddeskWin32]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    $pname = ''
    try { $pname = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
    $sb = New-Object System.Text.StringBuilder 256
    [GriddeskWin32]::GetWindowText($h, $sb, 256) | Out-Null
    [PSCustomObject]@{ ok = ($pname -ne ''); process = $pname; title = $sb.ToString() } | ConvertTo-Json -Compress
  }
  'Move' {
    $w = Find-Target $Process $Title
    if (-not $w) { [PSCustomObject]@{ ok = $false } | ConvertTo-Json -Compress; break }
    $SWP_NOSIZE = 0x0001; $SWP_NOZORDER = 0x0004; $SWP_NOACTIVATE = 0x0010
    $flags = $SWP_NOSIZE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE
    [GriddeskWin32]::SetWindowPos([IntPtr]$w.Handle, [IntPtr]::Zero, $X, $Y, 0, 0, $flags) | Out-Null
    [PSCustomObject]@{ ok = $true } | ConvertTo-Json -Compress
  }
  'Minimize' {
    $w = Find-Target $Process $Title
    if (-not $w) { [PSCustomObject]@{ ok = $false } | ConvertTo-Json -Compress; break }
    [GriddeskWin32]::ShowWindow([IntPtr]$w.Handle, 6) | Out-Null   # SW_MINIMIZE
    [PSCustomObject]@{ ok = $true } | ConvertTo-Json -Compress
  }
  'Restore' {
    $w = Find-Target $Process $Title
    if (-not $w) { [PSCustomObject]@{ ok = $false } | ConvertTo-Json -Compress; break }
    [GriddeskWin32]::ShowWindow([IntPtr]$w.Handle, 9) | Out-Null   # SW_RESTORE
    [PSCustomObject]@{ ok = $true } | ConvertTo-Json -Compress
  }
  # 특정 창 하나가 아니라, 그 프로그램(예: 카카오톡)의 열려있는 창을 전부
  # 한번에 최소화/복원함 - "붙이기"로 지정해두지 않았어도 비상시에 쓸 수 있음.
  'MinimizeAllByProcess' {
    $wins = @(Get-VisibleWindows | Where-Object { $_.Process -eq $Process })
    foreach ($w in $wins) { [GriddeskWin32]::ShowWindow([IntPtr]$w.Handle, 6) | Out-Null }  # SW_MINIMIZE
    [PSCustomObject]@{ ok = $true; count = $wins.Count } | ConvertTo-Json -Compress
  }
  'RestoreAllByProcess' {
    $wins = @(Get-VisibleWindows | Where-Object { $_.Process -eq $Process })
    foreach ($w in $wins) { [GriddeskWin32]::ShowWindow([IntPtr]$w.Handle, 9) | Out-Null }  # SW_RESTORE
    [PSCustomObject]@{ ok = $true; count = $wins.Count } | ConvertTo-Json -Compress
  }
  default {
    [PSCustomObject]@{ ok = $false; error = 'unknown action' } | ConvertTo-Json -Compress
  }
}
