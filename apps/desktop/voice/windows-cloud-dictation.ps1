# Cloud dictation recorder (owner-approved audio upload mode).
# Records one utterance from the default microphone with NAudio, normalises the gain, and reports the
# WAV path. The host decides whether uploading is allowed; this helper never uploads anything itself.
# Protocol: JSON lines on stdout -- {"kind":"ready"} / {"kind":"recorded","path":..,"seconds":..,"peak":..}
#           / {"kind":"error","reason":"cloud_dictation_*"}. English-only source to stay safe on PS 5.1.
param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [int]$MaxSeconds = 20,
  [int]$SilenceMs = 1500,
  [int]$MinSpeechMs = 400,
  [string]$NaudioPath
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-ProtocolEvent($Packet) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $Packet -Compress -Depth 4))
  [Console]::Out.Flush()
}

try {
  if ($MaxSeconds -lt 1 -or $MaxSeconds -gt 30) { throw 'cloud_dictation_request_invalid' }
  if ($SilenceMs -lt 300 -or $SilenceMs -gt 10000) { throw 'cloud_dictation_request_invalid' }
  if ($MinSpeechMs -lt 0 -or $MinSpeechMs -gt 5000) { throw 'cloud_dictation_request_invalid' }
  if (-not $NaudioPath) { $NaudioPath = Join-Path $PSScriptRoot 'NAudio.dll' }
  if (-not (Test-Path -LiteralPath $NaudioPath)) { throw 'cloud_dictation_naudio_missing' }
  # Internet-downloaded assemblies cannot be LoadFrom'ed in this host, so load from bytes.
  [void][Reflection.Assembly]::Load([IO.File]::ReadAllBytes($NaudioPath))

  $source = @'
using System;
using System.IO;
using System.Threading;
using NAudio.Wave;

public static class NuanbanCloudRecorder
{
    public static string Record(string path, int maxSeconds, int silenceMs, int minSpeechMs)
    {
        var format = new WaveFormat(16000, 16, 1);
        double peak = 0, rms = 0, seconds = 0;
        int speechMs = 0, silenceRunMs = 0, peakPercent = 0;
        using (var capture = new WaveInEvent())
        {
            capture.WaveFormat = format;
            capture.BufferMilliseconds = 100;
            using (var writer = new WaveFileWriter(path, format))
            {
                double sumSq = 0;
                long total = 0;
                var started = DateTime.UtcNow;
                capture.DataAvailable += (sender, args) =>
                {
                    writer.Write(args.Buffer, 0, args.BytesRecorded);
                    double bufferPeak = 0;
                    double bufferSum = 0;
                    for (int i = 0; i + 1 < args.BytesRecorded; i += 2)
                    {
                        short sample = (short)(args.Buffer[i] | (args.Buffer[i + 1] << 8));
                        double value = sample / 32768.0;
                        double magnitude = Math.Abs(value);
                        if (magnitude > bufferPeak) bufferPeak = magnitude;
                        if (magnitude > peak) peak = magnitude;
                        bufferSum += value * value;
                        sumSq += value * value;
                        total++;
                    }
                    double bufferRms = args.BytesRecorded > 0 ? Math.Sqrt(bufferSum / (args.BytesRecorded / 2)) : 0;
                    int milliseconds = args.BytesRecorded / 32;
                    // Speech gate: treat a buffer as speech when it is clearly above the noise floor.
                    if (bufferRms > 0.004 || bufferPeak > 0.05)
                    {
                        speechMs += milliseconds;
                        silenceRunMs = 0;
                        if ((int)(bufferPeak * 100) > peakPercent) peakPercent = (int)(bufferPeak * 100);
                    }
                    else if (speechMs >= minSpeechMs)
                    {
                        silenceRunMs += milliseconds;
                    }
                };
                capture.StartRecording();
                while ((DateTime.UtcNow - started).TotalSeconds < maxSeconds)
                {
                    Thread.Sleep(50);
                    if (speechMs >= minSpeechMs && silenceRunMs >= silenceMs) break;
                }
                capture.StopRecording();
                seconds = (DateTime.UtcNow - started).TotalSeconds;
                rms = total > 0 ? Math.Sqrt(sumSq / total) : 0;
            }
        }
        if (seconds < 0.3 || peak <= 0) throw new InvalidOperationException("cloud_dictation_no_speech");
        // Normalise to about -3 dBFS so weak laptop-array audio still reaches the recogniser.
        string normalised = path + ".normalised.wav";
        Normalise(path, normalised, peak);
        return string.Format("{{\"path\":{0},\"seconds\":{1:0.00},\"peak\":{2:0.0000},\"rms\":{3:0.0000},\"gain\":{4:0.0}}}",
            Quote(normalised), seconds, peak, rms, Math.Min(0.9 / peak, 20.0));
    }

    static string Quote(string value) { return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }

    static void Normalise(string input, string output, double peak)
    {
        double gain = peak > 0 ? Math.Min(0.9 / peak, 20.0) : 1.0;
        using (var reader = new WaveFileReader(input))
        using (var writer = new WaveFileWriter(output, reader.WaveFormat))
        {
            var buffer = new byte[reader.WaveFormat.AverageBytesPerSecond];
            int read;
            while ((read = reader.Read(buffer, 0, buffer.Length)) > 0)
            {
                for (int i = 0; i + 1 < read; i += 2)
                {
                    short sample = (short)(buffer[i] | (buffer[i + 1] << 8));
                    int scaled = (int)Math.Round(sample * gain);
                    if (scaled > 32767) scaled = 32767;
                    if (scaled < -32768) scaled = -32768;
                    buffer[i] = (byte)(scaled & 0xff);
                    buffer[i + 1] = (byte)((scaled >> 8) & 0xff);
                }
                writer.Write(buffer, 0, read);
            }
        }
  }
}
'@
  Add-Type -TypeDefinition $source -ReferencedAssemblies $NaudioPath -Language CSharp
  Write-ProtocolEvent @{ kind = 'ready' }
  $summary = [NuanbanCloudRecorder]::Record($OutFile, $MaxSeconds, $SilenceMs, $MinSpeechMs)
  Write-ProtocolEvent @{ kind = 'recorded'; detail = (ConvertFrom-Json -InputObject $summary) }
} catch {
  $reason = 'cloud_dictation_failed'
  $message = $_.Exception.Message
  if ($message -match '^cloud_dictation_[a-z_]{1,40}$') { $reason = $message }
  elseif ($message -match 'cloud_dictation_no_speech') { $reason = 'cloud_dictation_no_speech' }
  try { Write-ProtocolEvent @{ kind = 'error'; reason = $reason } } catch {}
  exit 2
}