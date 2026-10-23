$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$script:ProtocolToken = $null
$script:ProtocolGeneration = 0
# C2: advisory microphone signal state. Audio callbacks only write these variables; the main polling
# loop emits throttled `signal` events, so protocol lines stay single-threaded and never interleave.
$script:SignalLevel = 0
$script:SignalProblem = ''
$script:SignalEmittedLevel = -1
$script:SignalEmittedProblem = ''
$script:SignalNextEmitAt = [DateTime]::MinValue
$script:SignalProblems = @('none', 'TooNoisy', 'NoSignal', 'TooLoud', 'TooSoft', 'TooFast', 'TooSlow', 'Unknown')
$script:WakePhrases = @(
  (-join @([char]0x6696, [char]0x4F34)),
  (-join @([char]0x6696, [char]0x4F34, [char]0x6696, [char]0x4F34)),
  (-join @([char]0x5C0F, [char]0x6696))
)

function Write-ProtocolEvent($Packet) {
  $Packet.token = $script:ProtocolToken
  $Packet.generation = $script:ProtocolGeneration
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $Packet -Compress -Depth 4))
  [Console]::Out.Flush()
}

function New-WakeGrammar($Culture) {
  $choices = New-Object System.Speech.Recognition.Choices
  foreach ($phrase in $script:WakePhrases) { [void]$choices.Add($phrase) }
  $builder = New-Object System.Speech.Recognition.GrammarBuilder
  $builder.Culture = $Culture
  [void]$builder.Append($choices)
  $grammar = New-Object System.Speech.Recognition.Grammar($builder)
  $grammar.Name = 'NuanbanLocalWake'
  return $grammar
}

function Reset-WakeGrammar {
  $script:Mode = 'wake'
  $script:QuestionId = $null
  if ($null -ne $script:DictationGrammar) { $script:DictationGrammar.Enabled = $false }
  $script:WakeGrammar.Enabled = $true
}

function Complete-DirectDictation($Recognition) {
  $questionId = $script:QuestionId
  $script:Mode = 'finished'
  $script:DictationGrammar.Enabled = $false
  if ($null -eq $Recognition -or $Recognition.Confidence -lt 0.78) {
    Write-ProtocolEvent @{ kind = 'uncertain'; questionId = $questionId }
    return
  }
  $text = ([string]$Recognition.Text).Trim()
  if ($text.Length -gt 500) { $text = $text.Substring(0, 500); if ([char]::IsHighSurrogate($text[$text.Length - 1])) { $text = $text.Substring(0, $text.Length - 1) } }
  if ($text.Length -gt 0) { Write-ProtocolEvent @{ kind = 'question'; questionId = $questionId; text = $text } }
  else { Write-ProtocolEvent @{ kind = 'uncertain'; questionId = $questionId } }
  $text = $null
}

function Invoke-Command($Command) {
  if ($Command.token -cne $script:ProtocolToken -or $Command.generation -ne $script:ProtocolGeneration) { throw 'wake_command_identity_invalid' }
  if ($Command.op -eq 'stop') { return $false }
  if ($Command.op -ne 'mode') { throw 'wake_command_invalid' }
  if ($Command.mode -eq 'wake') { Reset-WakeGrammar; return $true }
  if ($Command.mode -ne 'question' -or $null -eq $script:DictationGrammar -or $Command.questionId -notmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') { throw 'wake_command_invalid' }
  $script:QuestionId = $Command.questionId
  $script:Mode = 'question'
  $script:QuestionDeadline = [DateTime]::UtcNow.AddMilliseconds($script:QuestionTimeoutMs)
  $script:WakeGrammar.Enabled = $false
  $script:DictationGrammar.Enabled = $true
  return $true
}

$engine = $null
$inputStream = $null
$recognitionId = $null
$completionId = $null
$resultCode = 0

try {
  if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -lt 1) { throw 'wake_powershell_version_unavailable' }
  try { Add-Type -AssemblyName System.Speech } catch { throw 'wake_speech_assembly_unavailable' }
  $inputStream = [Console]::OpenStandardInput()
  $headerBytes = New-Object System.Collections.Generic.List[byte]
  while ($true) {
    $nextByte = $inputStream.ReadByte()
    if ($nextByte -lt 0) { throw 'wake_request_invalid' }
    if ($nextByte -eq 10) { break }
    if ($headerBytes.Count -ge 4096) { throw 'wake_command_limit' }
    $headerBytes.Add([byte]$nextByte)
  }
  $request = ConvertFrom-Json -InputObject ([Text.Encoding]::ASCII.GetString($headerBytes.ToArray()))
  if ($request.token -notmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or $request.generation -lt 1 -or $request.generation -gt 2147483647) { throw 'wake_request_invalid' }
  $script:ProtocolToken = $request.token
  $script:ProtocolGeneration = $request.generation
  if ($request.op -ne 'probe' -and ($request.op -ne 'enable' -or $request.actor -cne 'owner' -or $request.confirmed -ne $true)) { throw 'wake_owner_confirmation_required' }
  $installed = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
  if ($installed.Count -gt 32) { throw 'wake_recognizer_limit' }
  $recognizerInfo = $installed | Where-Object { $_.Culture.Name -match '^zh-(CN|Hans-CN)$' } | Select-Object -First 1
  if ($null -eq $recognizerInfo) { throw 'wake_zh_cn_recognizer_unavailable' }
  try { $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizerInfo) } catch { throw 'wake_recognizer_unavailable' }
  $engine.SetInputToNull()
  $script:WakeGrammar = New-WakeGrammar $recognizerInfo.Culture
  try { $engine.LoadGrammar($script:WakeGrammar) } catch { throw 'wake_grammar_unavailable' }
  $script:DictationGrammar = $null
  try {
    $dictation = New-Object System.Speech.Recognition.DictationGrammar
    $dictation.Name = 'NuanbanLocalDictation'
    $dictation.Enabled = $false
    $engine.LoadGrammar($dictation)
    $script:DictationGrammar = $dictation
  } catch { $script:DictationGrammar = $null }
  if ($request.op -eq 'probe') {
    $records = @($installed | ForEach-Object { @{ culture = $_.Culture.Name; name = $_.Name; id = $_.Id } })
    Write-ProtocolEvent @{ kind = 'probe'; status = 'complete'; recognizers = $records; dictationAvailable = ($null -ne $script:DictationGrammar) }
  } else {
    if ($request.questionTimeoutMs -lt 1000 -or $request.questionTimeoutMs -gt 30000) { throw 'wake_request_invalid' }
    $script:QuestionTimeoutMs = $request.questionTimeoutMs
    $script:Mode = 'wake'
    $script:QuestionId = $null
    if ($request.mode -eq 'dictation') {
      if ($null -eq $script:DictationGrammar) { throw 'wake_dictation_unavailable' }
      [void](Invoke-Command @{ token = $script:ProtocolToken; generation = $script:ProtocolGeneration; op = 'mode'; mode = 'question'; questionId = $request.questionId })
    } elseif ($null -ne $request.mode) { throw 'wake_request_invalid' }
    $recognitionId = 'nuanban-recognized-' + $script:ProtocolToken
    $completionId = 'nuanban-completed-' + $script:ProtocolToken
    [void](Register-ObjectEvent -InputObject $engine -EventName SpeechRecognized -SourceIdentifier $recognitionId)
    [void](Register-ObjectEvent -InputObject $engine -EventName RecognizeCompleted -SourceIdentifier $completionId)
    try { $engine.SetInputToDefaultAudioDevice() } catch {
      if ($_.Exception.ToString().Contains('0x80070005') -or $_.Exception -is [UnauthorizedAccessException] -or $_.Exception.InnerException -is [UnauthorizedAccessException]) { throw 'wake_microphone_access_denied' }
      throw 'wake_microphone_unavailable'
    }
    # C2: observe input level and signal problems. Callbacks must not write to stdout.
    $engine.add_AudioLevelUpdated({ param($sender, $eventArgs) $script:SignalLevel = [int]$eventArgs.AudioLevel })
    $engine.add_AudioSignalProblemOccurred({ param($sender, $eventArgs) $script:SignalProblem = [string]$eventArgs.AudioSignalProblem })
    $script:SignalEmittedLevel = -1
    $script:SignalEmittedProblem = ''
    $script:SignalNextEmitAt = [DateTime]::MinValue
    try {
      if ($request.mode -eq 'dictation') {
        $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(10)
        $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(1200)
        $engine.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(1800)
        $engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Single)
      } else { $engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple) }
    } catch { throw 'wake_recognition_unavailable' }
    Write-ProtocolEvent @{ kind = 'ready'; dictationAvailable = ($null -ne $script:DictationGrammar) }
    $commandBuffer = New-Object byte[] 512
    $commandText = ''
    $readOperation = $inputStream.BeginRead($commandBuffer, 0, $commandBuffer.Length, $null, $null)
    $running = $true
    while ($running) {
      if ($readOperation.IsCompleted) {
        $count = $inputStream.EndRead($readOperation)
        if ($count -eq 0) { break }
        $commandText += [Text.Encoding]::ASCII.GetString($commandBuffer, 0, $count)
        if ($commandText.Length -gt 4096) { throw 'wake_command_limit' }
        $newline = $commandText.IndexOf("`n")
        while ($newline -ge 0 -and $running) {
          $line = $commandText.Substring(0, $newline)
          $commandText = $commandText.Substring($newline + 1)
          $running = Invoke-Command (ConvertFrom-Json -InputObject $line)
          $newline = $commandText.IndexOf("`n")
        }
        if ($running) { $readOperation = $inputStream.BeginRead($commandBuffer, 0, $commandBuffer.Length, $null, $null) }
      }
      if (-not $running) { break }
      if ($script:Mode -eq 'question' -and [DateTime]::UtcNow -ge $script:QuestionDeadline) {
        if ($request.mode -eq 'dictation') { throw 'wake_dictation_timeout' }
        Reset-WakeGrammar
      }
      $queuedEvents = @(Get-Event -ErrorAction SilentlyContinue | Where-Object { $_.SourceIdentifier -eq $recognitionId -or $_.SourceIdentifier -eq $completionId })
      if ($queuedEvents.Count -gt 16) { throw 'wake_event_limit' }
      foreach ($queuedEvent in $queuedEvents) {
        try {
          if ($queuedEvent.SourceIdentifier -eq $completionId) {
            if ($request.mode -eq 'dictation' -and $script:Mode -eq 'question') {
              Complete-DirectDictation $queuedEvent.SourceEventArgs.Result
              $running = $false
              continue
            }
            throw 'wake_recognition_stopped'
          }
          $recognition = $queuedEvent.SourceEventArgs.Result
          if ($script:Mode -eq 'wake' -and $recognition.Grammar.Name -ceq 'NuanbanLocalWake') {
            if ($recognition.Confidence -lt 0.65) { continue }
            $phrase = $recognition.Text
            if ($script:WakePhrases -ccontains $phrase) { Write-ProtocolEvent @{ kind = 'wake'; phrase = $phrase } }
          } elseif ($script:Mode -eq 'question' -and $recognition.Grammar.Name -ceq 'NuanbanLocalDictation') {
            if ($request.mode -eq 'dictation') { continue }
            if ($recognition.Confidence -lt 0.78) {
              Reset-WakeGrammar
            } else {
              $text = $recognition.Text.Trim()
              if ($text.Length -gt 500) { $text = $text.Substring(0, 500); if ([char]::IsHighSurrogate($text[$text.Length - 1])) { $text = $text.Substring(0, $text.Length - 1) } }
              $questionId = $script:QuestionId
              Reset-WakeGrammar
              if ($text.Length -gt 0) { Write-ProtocolEvent @{ kind = 'question'; questionId = $questionId; text = $text } }
              $text = $null
            }
          }
        } finally { Remove-Event -EventIdentifier $queuedEvent.EventIdentifier -ErrorAction SilentlyContinue }
      }
      $recognition = $null
      $queuedEvents = $null
      $now = [DateTime]::UtcNow
      if ($now -ge $script:SignalNextEmitAt) {
        $problem = $script:SignalProblem
        if ([string]::IsNullOrEmpty($problem) -or $problem -ceq 'None') { $problem = 'none' }
        elseif ($script:SignalProblems -notcontains $problem) { $problem = 'Unknown' }
        $level = [int]$script:SignalLevel
        $changed = ($problem -cne $script:SignalEmittedProblem) -or ([Math]::Abs($level - $script:SignalEmittedLevel) -ge 5)
        if ($changed -or ($script:SignalEmittedLevel -lt 0 -and $level -gt 0)) {
          Write-ProtocolEvent @{ kind = 'signal'; level = $level; problem = $problem }
          $script:SignalEmittedLevel = $level
          $script:SignalEmittedProblem = $problem
        }
        $script:SignalNextEmitAt = $now.AddMilliseconds(500)
      }
      Start-Sleep -Milliseconds 20
    }
  }
} catch {
  $reason = 'wake_engine_failed'
  if ($_.Exception.Message -match '^wake_[a-z_]{1,60}$') { $reason = $_.Exception.Message }
  try { Write-ProtocolEvent @{ kind = 'error'; reason = $reason } } catch {}
  $resultCode = 2
} finally {
  foreach ($sourceIdentifier in @($recognitionId, $completionId)) {
    if ($null -ne $sourceIdentifier) {
      Unregister-Event -SourceIdentifier $sourceIdentifier -ErrorAction SilentlyContinue
      Get-Event -SourceIdentifier $sourceIdentifier -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
    }
  }
  if ($null -ne $engine) {
    try { $engine.RecognizeAsyncCancel() } catch {}
    try { $engine.SetInputToNull() } catch {}
    try { $engine.Dispose() } catch {}
  }
}
exit $resultCode
