param([ValidateSet('resources','program','maa','screenshot','maa-start','maa-stop','maa-rogue-on','maa-rogue-off')][string]$Action='resources',[string]$ProcessName='MAA',[string]$MaaDir='',[string]$OutputFile='')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
 if($Action -eq 'resources') {
  $os=Get-CimInstance Win32_OperatingSystem
  $cpu=Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
  $adapters=@(Get-NetAdapter -Physical | Where-Object Status -eq Up)
  $mode='physical';if(!$adapters.Count){$adapters=@(Get-NetAdapter | Where-Object Status -eq Up);$mode='all-up'}
  $first=@{};foreach($a in $adapters){$s=$a|Get-NetAdapterStatistics;$first[$a.Name]=@([double]$s.ReceivedBytes,[double]$s.SentBytes)}
  $clock=[Diagnostics.Stopwatch]::StartNew();Start-Sleep -Milliseconds 1000
  $net=@(foreach($a in $adapters){$s=$a|Get-NetAdapterStatistics;[pscustomobject]@{name=$a.Name;received=[double]$s.ReceivedBytes;sent=[double]$s.SentBytes;receivePerSec=[Math]::Max(0,([double]$s.ReceivedBytes-$first[$a.Name][0])/$clock.Elapsed.TotalSeconds);sendPerSec=[Math]::Max(0,([double]$s.SentBytes-$first[$a.Name][1])/$clock.Elapsed.TotalSeconds)}})
  @{ok=$true;cpu=[double]$cpu.PercentProcessorTime;memoryTotal=[double]$os.TotalVisibleMemorySize*1024;memoryAvailable=[double]$os.FreePhysicalMemory*1024;network=$net;networkMode=$mode;sampleSeconds=$clock.Elapsed.TotalSeconds;at=[DateTimeOffset]::Now.ToString('o')}|ConvertTo-Json -Depth 6 -Compress;exit
 }
 if($ProcessName -notmatch '^[a-zA-Z0-9_.-]{1,80}$'){throw '程序名必须是进程名称，不接受路径或命令'}
 $processes=@(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
 if($MaaDir -and $ProcessName -eq 'MAA'){$foundCount=$processes.Count;$expected=[IO.Path]::GetFullPath((Join-Path $MaaDir 'MAA.exe'));$processes=@($processes|Where-Object {$_.Path -and [IO.Path]::GetFullPath($_.Path) -eq $expected});if($foundCount -gt 0 -and !$processes.Count){throw '发现MAA进程，但路径与工作台配置不一致，未读取或操作'}}
 $summary=@($processes|ForEach-Object {[pscustomobject]@{pid=$_.Id;name=$_.ProcessName;memory=$_.WorkingSet64;cpuSeconds=$_.CPU;responding=$_.Responding}})
 if(!$processes.Count){@{ok=$true;running=$false;processes=@()}|ConvertTo-Json -Compress;exit}
 if($Action -eq 'program'){@{ok=$true;running=$true;processes=$summary}|ConvertTo-Json -Depth 4 -Compress;exit}
 if($processes.Count -ne 1){throw '存在多个同名程序，请先在本机确定要控制的实例'}
 Add-Type -AssemblyName UIAutomationClient
 Add-Type -AssemblyName UIAutomationTypes
 Add-Type -AssemblyName System.Drawing
 Add-Type @'
using System; using System.Runtime.InteropServices;
public static class WhaleWindowCapture {
 [StructLayout(LayoutKind.Sequential)] public struct RECT {public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@
 $condition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,$processes[0].Id)
 $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,$condition)
 $candidates=if($ProcessName -eq 'MAA'){@($windows|Where-Object {$_.Current.Name -match '^MAA(?:\s|$)'})}else{@($windows|Where-Object {$_.Current.NativeWindowHandle -eq $processes[0].MainWindowHandle.ToInt64()})}
 if($candidates.Count -ne 1){throw '未找到唯一的目标程序主窗口；窗口可能已关闭、会话锁定或权限不一致'}
 $root=$candidates[0];$handle=[IntPtr]$root.Current.NativeWindowHandle
 $modals=@($windows|Where-Object {$_.Current.NativeWindowHandle -ne $root.Current.NativeWindowHandle -and $_.Current.Name -ne '' -and !$_.Current.IsOffscreen}|ForEach-Object {$_.Current.Name})
 function Snapshot {
  $elements=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
  $controls=@(foreach($e in $elements){try{if($e.Current.IsOffscreen){continue};$name=$e.Current.Name;$type=$e.Current.ControlType.ProgrammaticName;if($type -notin @('ControlType.CheckBox','ControlType.Button')){continue};$toggle=$null;$p=$null;if($e.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern,[ref]$p)){$toggle=$p.Current.ToggleState.ToString()};[pscustomobject]@{name=$name;type=$type;enabled=$e.Current.IsEnabled;toggle=$toggle;element=$e}}catch{}})
  return ,$controls
 }
 $controls=Snapshot
 if($Action -like 'maa-*'){
  if($modals.Count){throw ('MAA有弹窗阻挡，请先在电脑上处理：'+($modals -join '、'))}
  if($Action -in @('maa-rogue-on','maa-rogue-off')){
   $matches=@($controls|Where-Object {$_.name -eq '自动肉鸽' -and $_.type -eq 'ControlType.CheckBox'})
   if($matches.Count -ne 1 -or !$matches[0].enabled){throw '自动肉鸽控件不唯一或当前不可操作'}
   $desired=if($Action -eq 'maa-rogue-on'){'On'}else{'Off'}
   if($matches[0].toggle -notin @('On','Off')){throw '无法读取勾选状态，未执行切换'}
   if($matches[0].toggle -ne $desired){$p=$matches[0].element.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern);$p.Toggle()}
  }else{
   $names=if($Action -eq 'maa-start'){@('Link Start!','开始任务','开始')}else{@('停止','停止任务','Stop','Stop!','等待 & 停止')}
   $matches=@($controls|Where-Object {$_.type -eq 'ControlType.Button' -and $_.name -in $names -and $_.enabled})
   if($matches.Count -ne 1){throw '当前没有唯一且可用的对应按钮，未点击'}
   $matches[0].element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
  }
  Start-Sleep -Milliseconds 500;$controls=Snapshot
 }
 $rogue=@($controls|Where-Object {$_.name -eq '自动肉鸽' -and $_.type -eq 'ControlType.CheckBox'})
 $run='unknown';if(@($controls|Where-Object {$_.name -in @('停止','停止任务','Stop','Stop!','等待 & 停止') -and $_.enabled}).Count){$run='running'}elseif(@($controls|Where-Object {$_.name -in @('Link Start!','开始任务','开始') -and $_.enabled}).Count){$run='stopped'}
 $toggle=if($rogue.Count -eq 1){$rogue[0].toggle}else{$null}
 $screenshot=$null
 if($OutputFile){
  if([WhaleWindowCapture]::IsIconic($handle)){throw '程序窗口已最小化；请恢复窗口后再截图，避免发送空白图'}
  $rect=[WhaleWindowCapture+RECT]::new();if(![WhaleWindowCapture]::GetWindowRect($handle,[ref]$rect)){throw '无法读取窗口范围'}
  $w=$rect.Right-$rect.Left;$h=$rect.Bottom-$rect.Top;if($w -lt 50 -or $h -lt 50 -or $w*$h -gt 20000000){throw '窗口截图尺寸异常'}
  $bitmap=[Drawing.Bitmap]::new($w,$h);$g=[Drawing.Graphics]::FromImage($bitmap);$dc=$g.GetHdc()
  try{$ok=[WhaleWindowCapture]::PrintWindow($handle,$dc,2)}finally{$g.ReleaseHdc($dc);$g.Dispose()}
  try{if(!$ok){throw '窗口不支持后台截图'};$light=0;for($x=10;$x -lt $w;$x+=40){for($y=10;$y -lt $h;$y+=40){$c=$bitmap.GetPixel($x,$y);if($c.R+$c.G+$c.B -gt 24){$light++}}};if($light -lt 8){throw '窗口截图为空白，未发送'};$bitmap.Save($OutputFile,[Drawing.Imaging.ImageFormat]::Png);$screenshot=$OutputFile}finally{$bitmap.Dispose()}
 }
 @{ok=$true;running=$true;processes=$summary;taskState=$run;roguelike=$toggle;window=$root.Current.Name;modals=$modals;screenshot=$screenshot;action=$Action;at=[DateTimeOffset]::Now.ToString('o')}|ConvertTo-Json -Depth 5 -Compress
}catch{@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress;exit 1}
