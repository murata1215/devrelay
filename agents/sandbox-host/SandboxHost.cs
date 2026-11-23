// =============================================================================
// DevRelay Sandbox Host（Windows サービス、サイクル SB-1a-1）
// =============================================================================
//
// 役割: 自分の身元（`NT SERVICE\devrelay-sandbox` 仮想アカウント）でプロセスを起動し、
// stdin/stdout/stderr を Agent（開発者の身元・常駐）との名前付きパイプ経由で中継するだけ。
// Plan/Exec ゲート（PreToolUse / canUseTool / disallowedTools / permissionMode /
// strictReadonly）は Agent プロセスに残る。本サービスはツール許可の判断を一切持たない。
//
// 守ること（改訂版 Plan・人間の承認条件）:
//   - シェルを経由しない（ProcessStartInfo.UseShellExecute = false、cmd.exe を挟まない）。
//   - 任意の身元で起動する機能を持たない（CreateProcessAsUser 等は使わず、常に自分自身の
//     既定の身元で子プロセスを起動する。ServiceBase がサービス身元で動いているため、
//     子プロセスも自動的に同じ身元になる）。
//   - 名前付きパイプの ACL を明示する（開発者 SID に ReadWrite|Synchronize、
//     サービス自身の SID には CreateNewInstance のみ＝サンドボックスの子はパイプに
//     クライアントとして繋げない）。
//   - 遮断プローブは「陽性対照」（許可リストの実ホストへの直結）を使う（偽陰性を防ぐ）。
//
// ビルド: 管理者用インストールスクリプト（scripts/install-sandbox-host.ps1）が
// in-box の csc.exe（.NET Framework、NuGet 不可）でビルドする。そのため:
//   - 言語機能は C# 5 相当（文字列補間・式形式メンバ・null 条件演算子等は使わない）。
//   - JSON は NuGet 無しで使える `System.Web.Extensions.dll`
//     （`System.Web.Script.Serialization.JavaScriptSerializer`）を使う。
//   - 署名アルゴリズムは ECDSA（P-256 / SHA-256, IEEE P1363 形式）。Ed25519 は
//     .NET Framework に無く NuGet 無しでは実装できないため、Node.js 側
//     （agents/linux/src/services/sandbox-attest.ts）もこれに合わせている
//     （詳細は同ファイルのコメント参照。Plan からの変更点）。
//
// プロトコル（agents/linux/src/services/sandbox-{protocol,frames}.ts と値を一致させること）:
//   フレーム = [1 byte type][4 bytes length (big-endian)][payload...]
//
// 本ファイルは実機（Windows）でのみビルド・実行確認ができる。Linux 上では構文の目視確認のみ。
// =============================================================================

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace DevRelaySandboxHost
{
    /// <summary>フレーム種別。Node 側 SandboxFrameType と値を一致させること。</summary>
    internal static class FrameType
    {
        public const byte HandshakeRequest = 1;
        public const byte HandshakeResponse = 2;
        public const byte SpawnRequest = 3;
        public const byte SpawnResponse = 4;
        public const byte StdinData = 5;
        public const byte StdinEof = 6;
        public const byte StdoutData = 7;
        public const byte StderrData = 8;
        public const byte Exit = 9;
        public const byte Kill = 10;
        public const byte Error = 11;
    }

    /// <summary>プロトコル定数。Node 側 sandbox-protocol.ts と値を一致させること。</summary>
    internal static class Protocol
    {
        public const int ProtocolVersion = 1;
        public const string PipeName = "devrelay-sandbox-v1";
        public const string ExpectedServiceName = "NT SERVICE\\devrelay-sandbox";
        public const int ProxyPort = 48711;
        public const string PositiveControlHost = "api.anthropic.com";
        public const int PositiveControlPort = 443;
        public const long MaxFrameBytes = 16L * 1024 * 1024;
        public const int ProbeTimeoutMs = 3000;
    }

    /// <summary>フレームの符号化・読み取り（Node 側 sandbox-frames.ts と同じワイヤーフォーマット）。</summary>
    internal static class Frames
    {
        public static void WriteFrame(Stream stream, byte type, byte[] payload)
        {
            if (payload == null) payload = new byte[0];
            if (payload.Length > Protocol.MaxFrameBytes)
            {
                throw new InvalidOperationException("sandbox frame: payload too large");
            }
            byte[] header = new byte[5];
            header[0] = type;
            uint len = (uint)payload.Length;
            header[1] = (byte)((len >> 24) & 0xFF);
            header[2] = (byte)((len >> 16) & 0xFF);
            header[3] = (byte)((len >> 8) & 0xFF);
            header[4] = (byte)(len & 0xFF);
            lock (stream)
            {
                stream.Write(header, 0, header.Length);
                stream.Write(payload, 0, payload.Length);
                stream.Flush();
            }
        }

        /// <summary>
        /// ストリームから 1 フレームを読む（ブロッキング）。接続が切れた場合は null を返す。
        /// </summary>
        public static Frame ReadFrame(Stream stream)
        {
            byte[] header = ReadExact(stream, 5);
            if (header == null) return null;
            byte type = header[0];
            uint length = ((uint)header[1] << 24) | ((uint)header[2] << 16) | ((uint)header[3] << 8) | header[4];
            if (length > Protocol.MaxFrameBytes)
            {
                throw new InvalidOperationException("sandbox frame: declared length exceeds max");
            }
            byte[] payload = length == 0 ? new byte[0] : ReadExact(stream, (int)length);
            if (payload == null) return null;
            return new Frame(type, payload);
        }

        private static byte[] ReadExact(Stream stream, int count)
        {
            byte[] buffer = new byte[count];
            int offset = 0;
            while (offset < count)
            {
                int read = stream.Read(buffer, offset, count - offset);
                if (read <= 0) return null; // 切断
                offset += read;
            }
            return buffer;
        }
    }

    internal class Frame
    {
        public readonly byte Type;
        public readonly byte[] Payload;
        public Frame(byte type, byte[] payload)
        {
            Type = type;
            Payload = payload;
        }
    }

    /// <summary>
    /// 署名対象の正規化バイト列を組み立てる。Node 側 buildSandboxAttestationMessage() と
    /// フィールド順・区切り文字（改行）を完全に一致させること。
    /// </summary>
    internal static class Attestation
    {
        public static byte[] BuildMessage(
            string nonce,
            string serviceName,
            string sid,
            int protocolVersion,
            string claudeExecutablePath,
            string projectPath,
            bool positiveControlBlocked,
            bool loopbackReachable,
            bool claudeExecutableReadable,
            bool projectFolderWritable)
        {
            // Node 側の `fields.positiveControlBlocked` 等は JS の boolean → 文字列化で
            // "true"/"false" になる。C# の bool.ToString() は "True"/"False"（先頭大文字）を
            // 返すため、ToLowerInvariant() で揃える（これを忘れると署名が常に不一致になる）。
            StringBuilder sb = new StringBuilder();
            sb.Append("nonce=").Append(nonce).Append("\n");
            sb.Append("serviceName=").Append(serviceName).Append("\n");
            sb.Append("sid=").Append(sid).Append("\n");
            sb.Append("protocolVersion=").Append(protocolVersion).Append("\n");
            sb.Append("claudeExecutablePath=").Append(claudeExecutablePath).Append("\n");
            sb.Append("projectPath=").Append(projectPath).Append("\n");
            sb.Append("positiveControlBlocked=").Append(positiveControlBlocked.ToString().ToLowerInvariant()).Append("\n");
            sb.Append("loopbackReachable=").Append(loopbackReachable.ToString().ToLowerInvariant()).Append("\n");
            sb.Append("claudeExecutableReadable=").Append(claudeExecutableReadable.ToString().ToLowerInvariant()).Append("\n");
            sb.Append("projectFolderWritable=").Append(projectFolderWritable.ToString().ToLowerInvariant());
            return Encoding.UTF8.GetBytes(sb.ToString());
        }
    }

    /// <summary>
    /// Win32 Job Object の最小ラッパー（kill-on-job-close）。子プロセスとその子孫
    /// （claude が起動する Bash ツールの cmd.exe/node/git 等）を、ハンドルが閉じられた時点で
    /// 確実に道連れにする（孤児プロセスの残留防止。改訂版 Plan のレビュー指摘 B-4 対応）。
    /// 要実機確認: Job Object 生成・AssignProcessToJobObject の実際の挙動。
    /// </summary>
    internal sealed class SandboxJobObject : IDisposable
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll")]
        private static extern bool SetInformationJobObject(IntPtr hJob, int jobObjectInfoClass, ref JobobjectExtendedLimitInformation info, uint infoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr hObject);

        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x2000;

        [StructLayout(LayoutKind.Sequential)]
        private struct JobobjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobobjectExtendedLimitInformation
        {
            public JobobjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        private readonly IntPtr _handle;

        // SB-1a-1.1 (B5) で HandleSpawn() を背景スレッド構成に変更したため、KILL 受信スレッドと
        // 子プロセス終了を待つメインスレッドの双方が Dispose() を呼び得る（従来は同一スレッド内の
        // 逐次呼び出しだったため実害が無かったが、並行呼び出しになると同じハンドル値への
        // CloseHandle() の二重呼び出し＝ハンドル再利用時の破壊的競合になり得る）。
        // そのため Dispose() 自体に一度だけ実行するガードを置く（破棄の順序はどちらのスレッドが
        // 先でも安全になるようにする）。
        private readonly object _disposeLock = new object();
        private bool _disposed;

        public SandboxJobObject()
        {
            _handle = CreateJobObject(IntPtr.Zero, null);
            if (_handle == IntPtr.Zero)
            {
                throw new InvalidOperationException("CreateJobObject failed: " + Marshal.GetLastWin32Error());
            }
            JobobjectExtendedLimitInformation info = new JobobjectExtendedLimitInformation();
            info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            int length = Marshal.SizeOf(typeof(JobobjectExtendedLimitInformation));
            if (!SetInformationJobObject(_handle, JobObjectExtendedLimitInformation, ref info, (uint)length))
            {
                throw new InvalidOperationException("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
            }
        }

        public void Assign(Process process)
        {
            if (!AssignProcessToJobObject(_handle, process.Handle))
            {
                throw new InvalidOperationException("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
            }
        }

        /// <summary>
        /// 一度だけ実行される（2 回目以降の呼び出しは no-op）。どのスレッドから呼ばれても安全。
        /// </summary>
        public void Dispose()
        {
            lock (_disposeLock)
            {
                if (_disposed) return;
                _disposed = true;
                if (_handle != IntPtr.Zero)
                {
                    CloseHandle(_handle); // KillOnJobClose により、ここで子プロセスツリーも終了する
                }
            }
        }
    }

    /// <summary>1 クライアント接続（1 ターン）を処理するハンドラ。</summary>
    internal sealed class ConnectionHandler
    {
        private readonly NamedPipeServerStream _pipe;
        private readonly ECDsaCng _signingKey;
        private readonly string _serviceName;
        private readonly string _sid;
        private readonly JavaScriptSerializer _json;

        public ConnectionHandler(NamedPipeServerStream pipe, ECDsaCng signingKey, string serviceName, string sid)
        {
            _pipe = pipe;
            _signingKey = signingKey;
            _serviceName = serviceName;
            _sid = sid;
            _json = new JavaScriptSerializer();
        }

        public void Run()
        {
            try
            {
                Frame request = Frames.ReadFrame(_pipe);
                if (request == null) return;

                if (request.Type == FrameType.HandshakeRequest)
                {
                    HandleHandshake(request);
                    // ハンドシェイク後、同じ接続で SPAWN_REQUEST が続くことがある
                    Frame next = Frames.ReadFrame(_pipe);
                    if (next != null && next.Type == FrameType.SpawnRequest)
                    {
                        HandleSpawn(next);
                    }
                }
                else if (request.Type == FrameType.SpawnRequest)
                {
                    HandleSpawn(request);
                }
            }
            catch (Exception ex)
            {
                TryWriteError(ex.Message);
            }
            finally
            {
                try { _pipe.Dispose(); } catch (Exception) { }
            }
        }

        private void TryWriteError(string message)
        {
            try
            {
                byte[] payload = Encoding.UTF8.GetBytes(message);
                Frames.WriteFrame(_pipe, FrameType.Error, payload);
            }
            catch (Exception) { }
        }

        private void HandleHandshake(Frame request)
        {
            Dictionary<string, object> req = (Dictionary<string, object>)_json.DeserializeObject(Encoding.UTF8.GetString(request.Payload));
            string nonce = (string)req["nonce"];
            string claudeExecutablePath = req.ContainsKey("claudeExecutablePath") ? (string)req["claudeExecutablePath"] : "";
            string projectPath = req.ContainsKey("projectPath") ? (string)req["projectPath"] : "";

            bool positiveControlBlocked = ProbePositiveControlBlocked();
            bool loopbackReachable = ProbeLoopbackReachable();
            bool claudeExecutableReadable = ProbeFileReadable(claudeExecutablePath);
            bool projectFolderWritable = ProbeFolderWritable(projectPath);

            byte[] message = Attestation.BuildMessage(
                nonce, _serviceName, _sid, Protocol.ProtocolVersion,
                claudeExecutablePath, projectPath,
                positiveControlBlocked, loopbackReachable,
                claudeExecutableReadable, projectFolderWritable);

            // ECDsaCng.SignData の既定出力は IEEE P1363（r||s の連結）。
            // Node 側 verify も dsaEncoding:'ieee-p1363' を明示しているため一致する。
            byte[] signature = _signingKey.SignData(message, HashAlgorithmName.SHA256);

            Dictionary<string, object> resp = new Dictionary<string, object>();
            resp["protocolVersion"] = Protocol.ProtocolVersion;
            resp["serviceName"] = _serviceName;
            resp["sid"] = _sid;
            resp["positiveControlBlocked"] = positiveControlBlocked;
            resp["loopbackReachable"] = loopbackReachable;
            resp["claudeExecutableReadable"] = claudeExecutableReadable;
            resp["projectFolderWritable"] = projectFolderWritable;
            resp["signature"] = Convert.ToBase64String(signature);

            byte[] respPayload = Encoding.UTF8.GetBytes(_json.Serialize(resp));
            Frames.WriteFrame(_pipe, FrameType.HandshakeResponse, respPayload);
        }

        /// <summary>
        /// 陽性対照: 許可リストの実ホストへの直結を試みる。ファイアウォールが効いていれば
        /// 接続は拒否される（はず）。RFC5737 等の到達不能アドレスでは「ファイアウォールが
        /// 無くても失敗する」ため陰性対照にしかならない、という Plan レビュー指摘2への対応。
        /// 要実機確認: Outbound Block 時の実際の SocketErrorCode（想定は AccessDenied=10013）。
        /// </summary>
        private bool ProbePositiveControlBlocked()
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    IAsyncResult result = client.BeginConnect(Protocol.PositiveControlHost, Protocol.PositiveControlPort, null, null);
                    bool completed = result.AsyncWaitHandle.WaitOne(Protocol.ProbeTimeoutMs);
                    if (!completed)
                    {
                        // タイムアウト = 判断できない → fail-closed（blocked とはみなさない）
                        return false;
                    }
                    client.EndConnect(result); // 成功すれば例外を投げない
                    return false; // 接続できた = 遮断されていない
                }
            }
            catch (SocketException ex)
            {
                // 10013 = WSAEACCES。他のエラー（DNS 失敗・ホスト到達不能等）は
                // 「判断できない」として扱い、blocked と断定しない（fail-closed）。
                return ex.SocketErrorCode == SocketError.AccessDenied;
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>Agent の loopback 中継プロキシ（固定ポート）へ到達できるか。プローブが実際に走った証拠。</summary>
        private bool ProbeLoopbackReachable()
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    IAsyncResult result = client.BeginConnect("127.0.0.1", Protocol.ProxyPort, null, null);
                    bool completed = result.AsyncWaitHandle.WaitOne(Protocol.ProbeTimeoutMs);
                    if (!completed) return false;
                    client.EndConnect(result);
                    return true;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        private bool ProbeFileReadable(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            try
            {
                using (FileStream fs = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    return fs.CanRead;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        private bool ProbeFolderWritable(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            string probeFile = Path.Combine(path, ".devrelay-sandbox-probe-" + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                using (FileStream fs = File.Create(probeFile)) { }
                File.Delete(probeFile);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private void HandleSpawn(Frame request)
        {
            Dictionary<string, object> req = (Dictionary<string, object>)_json.DeserializeObject(Encoding.UTF8.GetString(request.Payload));
            string command = (string)req["command"];
            object argsObj = req.ContainsKey("args") ? req["args"] : null;
            string cwd = req.ContainsKey("cwd") ? (string)req["cwd"] : null;
            object envObj = req.ContainsKey("env") ? req["env"] : null;

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = command;
            psi.Arguments = BuildArgumentString(argsObj);
            if (!string.IsNullOrEmpty(cwd)) psi.WorkingDirectory = cwd;
            // シェルを経由しない（UseShellExecute=false かつ cmd.exe を挟まない）。
            psi.UseShellExecute = false;
            psi.RedirectStandardInput = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;

            if (envObj is Dictionary<string, object>)
            {
                // サービス自身の環境をベースにし、Agent から受け取った上書き分だけ merge する
                // （process.env の丸ごと継承ではない。agents/linux/src/services/sandbox-env.ts 参照）。
                Dictionary<string, object> env = (Dictionary<string, object>)envObj;
                foreach (KeyValuePair<string, object> kv in env)
                {
                    if (kv.Value == null)
                    {
                        psi.EnvironmentVariables.Remove(kv.Key);
                    }
                    else
                    {
                        psi.EnvironmentVariables[kv.Key] = Convert.ToString(kv.Value);
                    }
                }
            }

            Process process = new Process();
            process.StartInfo = psi;

            SandboxJobObject job = new SandboxJobObject();
            try
            {
                process.Start();
                job.Assign(process); // プロセスツリーを Job に入れる（孤児化防止）
            }
            catch (Exception ex)
            {
                job.Dispose();
                TryWriteError("spawn failed: " + ex.Message);
                return;
            }

            object killLock = new object();
            bool killed = false;

            Thread stdoutThread = new Thread(delegate ()
            {
                RelayStream(process.StandardOutput.BaseStream, FrameType.StdoutData);
            });
            Thread stderrThread = new Thread(delegate ()
            {
                RelayStream(process.StandardError.BaseStream, FrameType.StderrData);
            });
            stdoutThread.IsBackground = true;
            stderrThread.IsBackground = true;
            stdoutThread.Start();
            stderrThread.Start();

            // Agent → ホスト: STDIN_DATA / STDIN_EOF / KILL を読み続けるスレッド。
            //
            // **SB-1a-1.1 (B5) で背景スレッド化した**: 旧実装はこのループをメインスレッドで回し、
            // ループを抜けてから初めて process.WaitForExit() を呼んでいた。ループの脱出条件は
            // 「例外」「Agent 側の切断（frame == null）」「KILL 受信」のいずれかであり、子プロセスが
            // 自然終了しても Agent が切断するまでループは抜けない。そのため Agent（selftest 等）が
            // stdin を閉じず・KILL も送らずに一定時間待ってから切断する使い方をすると、子プロセス
            // 自体はもっと前に終了していても EXIT フレームが届かず exitCode が取得できなかった
            // （実機確認済み: selftest --spawn で exitCode が常に null）。
            //
            // 本スレッドは「Agent → ホストの中継」の責務のみを持ち、子プロセスの終了判定はメイン
            // スレッドが process.WaitForExit() で独立に行う。KILL を受けたときだけ本スレッドが
            // job.Dispose() を呼び（KillOnJobClose でプロセスツリーを終了させる）、それを合図に
            // メインスレッドの WaitForExit() が返る。job.Dispose() は二重呼び出しに対して安全
            // （SandboxJobObject.Dispose() 側でガード済み。本スレッドが KILL 経由で先に Dispose
            // しても、メインスレッド側で後始末のため再度呼んでも no-op になる）。
            Thread stdinThread = new Thread(delegate ()
            {
                while (true)
                {
                    Frame frame;
                    try
                    {
                        frame = Frames.ReadFrame(_pipe);
                    }
                    catch (Exception)
                    {
                        break; // パイプが閉じられた（Agent 切断 or メインスレッドの後始末）
                    }
                    if (frame == null) break; // Agent 側が切断

                    if (frame.Type == FrameType.StdinData)
                    {
                        try
                        {
                            process.StandardInput.BaseStream.Write(frame.Payload, 0, frame.Payload.Length);
                            process.StandardInput.BaseStream.Flush();
                        }
                        catch (Exception) { }
                    }
                    else if (frame.Type == FrameType.StdinEof)
                    {
                        // stdin EOF は「正常終了の機会を与える」ための signal であり、kill ではない
                        // （改訂版 Plan レビュー指摘 B-4）。
                        try { process.StandardInput.Close(); } catch (Exception) { }
                    }
                    else if (frame.Type == FrameType.Kill)
                    {
                        lock (killLock) { killed = true; }
                        try { job.Dispose(); } catch (Exception) { } // KillOnJobClose によりプロセスツリーごと終了
                        break;
                    }
                    // 未知のフレーム種別は無視する（spawn 中は HANDSHAKE/SPAWN 系は来ない想定）。
                }
            });
            stdinThread.IsBackground = true;
            stdinThread.Start();

            // メインスレッドは子プロセス自身の終了だけを待つ（Agent の切断は待たない）。
            // KILL 経由の場合は上記スレッドの job.Dispose() がプロセスツリーを終了させるため、
            // ここはそのタイミングで返る。
            process.WaitForExit();

            // 子の終了直後、stdin 中継スレッドの後始末を短時間だけ試みる（自然終了の場合、
            // 当該スレッドはまだ Agent からの次フレームをブロック読みしている可能性があるため
            // 長くは待たない。IsBackground のため、残っても後続の _pipe.Dispose()（Run() の
            // finally）で読み取りが例外化し自然に終了する）。
            stdinThread.Join(100);

            stdoutThread.Join(2000);
            stderrThread.Join(2000);

            int exitCode;
            string signal;
            lock (killLock)
            {
                if (killed)
                {
                    exitCode = -1; // JSON では null にする
                    signal = "SIGTERM";
                }
                else
                {
                    exitCode = process.ExitCode;
                    signal = null;
                }
            }

            Dictionary<string, object> exitPayload = new Dictionary<string, object>();
            exitPayload["code"] = killed ? null : (object)exitCode;
            exitPayload["signal"] = signal;
            try
            {
                Frames.WriteFrame(_pipe, FrameType.Exit, Encoding.UTF8.GetBytes(_json.Serialize(exitPayload)));
            }
            catch (Exception) { }

            // 自然終了時はまだ Dispose されていないのでここで行う（KILL 経由なら既に Dispose
            // 済みだが、二重呼び出しは安全なので無条件に呼ぶ）。
            try { job.Dispose(); } catch (Exception) { }
        }

        private void RelayStream(Stream source, byte frameType)
        {
            byte[] buffer = new byte[8192];
            try
            {
                while (true)
                {
                    int read = source.Read(buffer, 0, buffer.Length);
                    if (read <= 0) break;
                    byte[] chunk = new byte[read];
                    Array.Copy(buffer, chunk, read);
                    Frames.WriteFrame(_pipe, frameType, chunk);
                }
            }
            catch (Exception) { }
        }

        private static string BuildArgumentString(object argsObj)
        {
            if (!(argsObj is object[]) && !(argsObj is ArrayList)) return "";
            List<string> parts = new List<string>();
            System.Collections.IEnumerable enumerable = (System.Collections.IEnumerable)argsObj;
            foreach (object item in enumerable)
            {
                string s = Convert.ToString(item);
                parts.Add(QuoteArgument(s));
            }
            return string.Join(" ", parts.ToArray());
        }

        /// <summary>
        /// Windows のコマンドライン引用規則に従って 1 引数を引用する（スペース・引用符を含む場合のみ）。
        /// シェルを経由しないため、シェルのメタ文字は無害（解釈されるのは CreateProcess の
        /// コマンドライン分割規則のみ）。
        /// </summary>
        private static string QuoteArgument(string arg)
        {
            if (arg.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0 && arg.Length > 0)
            {
                return arg;
            }
            StringBuilder sb = new StringBuilder();
            sb.Append('"');
            for (int i = 0; i < arg.Length; i++)
            {
                if (arg[i] == '"') sb.Append('\\');
                sb.Append(arg[i]);
            }
            sb.Append('"');
            return sb.ToString();
        }
    }

    /// <summary>Windows サービス本体。</summary>
    public class SandboxHostService : ServiceBase
    {
        private Thread _acceptThread;
        private volatile bool _stopping;
        private ECDsaCng _signingKey;
        private string _serviceName;
        private string _sid;

        public SandboxHostService()
        {
            ServiceName = "devrelay-sandbox";
        }

        protected override void OnStart(string[] args)
        {
            WindowsIdentity identity = WindowsIdentity.GetCurrent();
            _sid = identity.User.Value;
            _serviceName = identity.Name; // 期待値: "NT SERVICE\devrelay-sandbox"

            _signingKey = SandboxKeyStore.LoadPrivateKey();

            _stopping = false;
            _acceptThread = new Thread(AcceptLoop);
            _acceptThread.IsBackground = true;
            _acceptThread.Start();
        }

        protected override void OnStop()
        {
            _stopping = true;
        }

        private void AcceptLoop()
        {
            while (!_stopping)
            {
                NamedPipeServerStream pipe = null;
                try
                {
                    pipe = CreateSecuredPipe();
                    pipe.WaitForConnection();
                }
                catch (Exception)
                {
                    if (pipe != null) pipe.Dispose();
                    if (_stopping) break;
                    Thread.Sleep(500);
                    continue;
                }

                NamedPipeServerStream connected = pipe;
                Thread worker = new Thread(delegate ()
                {
                    ConnectionHandler handler = new ConnectionHandler(connected, _signingKey, _serviceName, _sid);
                    handler.Run();
                });
                worker.IsBackground = true;
                worker.Start();
            }
        }

        /// <summary>
        /// 名前付きパイプの ACL を明示する: 開発者（Users）に ReadWrite + Synchronize、
        /// サービス自身（CurrentUser = サービス身元）には CreateNewInstance のみを付与する
        /// （サンドボックスの子プロセスはこのパイプへクライアントとして繋げない。要件5）。
        /// 要実機確認: PipeAccessRule の対象（BUILTIN\Users か、インストール時に指定した
        /// 開発者アカウントか）。既定は Users（複数開発者共用機は未対応、SB-2 課題）。
        /// </summary>
        private static NamedPipeServerStream CreateSecuredPipe()
        {
            PipeSecurity security = new PipeSecurity();
            security.AddAccessRule(new PipeAccessRule(
                new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null),
                PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize,
                AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(
                WindowsIdentity.GetCurrent().User,
                PipeAccessRights.CreateNewInstance,
                AccessControlType.Allow));

            return new NamedPipeServerStream(
                Protocol.PipeName,
                PipeDirection.InOut,
                NamedPipeServerStream.MaxAllowedServerInstances,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous,
                0,
                0,
                security);
        }

        public static void Main(string[] args)
        {
            if (Environment.UserInteractive)
            {
                // `devrelay-sandbox-host.exe --console` でデバッグ実行できるようにする（任意）。
                SandboxHostService service = new SandboxHostService();
                service.OnStart(args);
                Console.WriteLine("Sandbox Host running in console mode. Press Enter to stop.");
                Console.ReadLine();
                service.OnStop();
                return;
            }
            ServiceBase.Run(new SandboxHostService());
        }
    }

    /// <summary>
    /// 署名鍵の読み込み。管理者用インストールスクリプトが
    /// `C:\ProgramData\devrelay\sandbox\host-key.priv.blob`（CNG ECCPrivateBlob 形式、
    /// サービス身元のみ読める ACL）を作成する。
    /// </summary>
    internal static class SandboxKeyStore
    {
        public static ECDsaCng LoadPrivateKey()
        {
            string path = "C:\\ProgramData\\devrelay\\sandbox\\host-key.priv.blob";
            byte[] blob = File.ReadAllBytes(path);
            CngKey key = CngKey.Import(blob, CngKeyBlobFormat.EccPrivateBlob);
            return new ECDsaCng(key);
        }
    }
}
