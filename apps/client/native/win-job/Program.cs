using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

// Standalone, native-AOT Windows foreground/background process supervisor.
// CREATE_SUSPENDED -> AssignProcessToJobObject -> ResumeThread prevents a child
// from escaping between creation and the Job Object assignment.
// Holding this process alive keeps the Job handle open; terminating the helper
// or closing its handle terminates all descendant processes in the job.
internal sealed class LaunchRequest
{
    public string File { get; set; } = "";
    public string[] Args { get; set; } = Array.Empty<string>();
    public string Cwd { get; set; } = "";
    public int ParentPid { get; set; }
}
[JsonSerializable(typeof(LaunchRequest))]
internal partial class LaunchJsonContext : JsonSerializerContext { }
internal static class Program
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint SYNCHRONIZE = 0x00100000;

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars;
        public int dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateJobObjectW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr security, string? name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(string? appName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags, IntPtr environment, string? currentDirectory,
        ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(out IntPtr read, out IntPtr write,
        ref SECURITY_ATTRIBUTES security, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint millis);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    private static void Check(bool success, string call)
    {
        if (!success) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), call);
    }
    private static string Quote(string value)
    {
        if (value.Length > 0 && !value.Any(c => c == '"' || char.IsWhiteSpace(c))) return value;
        var b = new StringBuilder("\"");
        int slashes = 0;
        foreach (var ch in value)
        {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') { b.Append('\\', slashes * 2 + 1); b.Append('"'); slashes = 0; continue; }
            b.Append('\\', slashes); slashes = 0; b.Append(ch);
        }
        b.Append('\\', slashes * 2);
        return b.Append('"').ToString();
    }
    private static string ResolveExecutable(string program, string cwd)
    {
        if (string.IsNullOrWhiteSpace(program)) throw new ArgumentException("Empty program");
        var paths = program.Contains('\\') || program.Contains('/')
            ? new[] { Path.IsPathRooted(program) ? program : Path.Combine(cwd, program) }
            : (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries)
                .Select(dir => Path.Combine(dir.Trim('"'), program));
        foreach (var path in paths)
        {
            // PATHEXT always takes priority over extensionless POSIX shell shims.
            // Windows installations of pnpm contain both pnpm and pnpm.cmd.
            if (!Path.HasExtension(path))
            {
                foreach (var ext in new[] { ".exe", ".com", ".cmd", ".bat" })
                    if (File.Exists(path + ext)) return Path.GetFullPath(path + ext);
            }
            if (File.Exists(path)) return Path.GetFullPath(path);
        }
        throw new FileNotFoundException("Program not found", program);
    }
    private static (string exe, string command) BuildLaunch(LaunchRequest request)
    {
        var exe = ResolveExecutable(request.File, request.Cwd);
        if (!exe.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase)
            && !exe.EndsWith(".bat", StringComparison.OrdinalIgnoreCase))
            return (exe, Quote(exe) + " " + string.Join(" ", request.Args.Select(Quote)));
        // Batch shims such as pnpm.cmd need cmd.exe. Reject metacharacters rather
        // than promising arbitrary shell-safe argument escaping.
        if (request.Args.Any(a => a.IndexOfAny(new[] { '"','%','!','^','&','|','<','>','\r','\n' }) >= 0))
            throw new ArgumentException("Unsafe batch argument; use an explicit shell profile instead");
        var cmd = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        var line = "\"\"" + exe + "\" " + string.Join(" ", request.Args.Select(Quote)) + "\"";
        return (cmd, Quote(cmd) + " /d /s /c " + line);
    }
    public static async Task<int> Main(string[] args)
    {
        if (args.Length != 1) { Console.Error.WriteLine("Usage: deskbeacon-job <base64-JSON>"); return 125; }
        try
        {
            var req = JsonSerializer.Deserialize(Convert.FromBase64String(args[0]), LaunchJsonContext.Default.LaunchRequest)
                      ?? throw new ArgumentException("Missing request");
            if (string.IsNullOrWhiteSpace(req.Cwd)) req.Cwd = Environment.CurrentDirectory;
            req.Cwd = Path.GetFullPath(req.Cwd);
            if (!Directory.Exists(req.Cwd)) throw new DirectoryNotFoundException(req.Cwd);
            if (req.ParentPid <= 0) throw new ArgumentException("ParentPid is mandatory");
            return await Run(req);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("DESKBEACON_JOB_ERROR: " + ex.ToString());
            return 125;
        }
    }

    private static async Task<int> Run(LaunchRequest request)
    {
        var (exe, line) = BuildLaunch(request);
        IntPtr job = IntPtr.Zero, processHandle = IntPtr.Zero, threadHandle = IntPtr.Zero;
        IntPtr parentHandle = IntPtr.Zero;
        IntPtr stdinRead = IntPtr.Zero, stdinWrite = IntPtr.Zero;
        IntPtr stdoutRead = IntPtr.Zero, stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero, stderrWrite = IntPtr.Zero;
        try
        {
            parentHandle = OpenProcess(SYNCHRONIZE, false, (uint)request.ParentPid);
            Check(parentHandle != IntPtr.Zero, "OpenProcess(daemon)");
            var monitoredHandle = parentHandle;
            _ = Task.Run(() => {
                var result = WaitForSingleObject(monitoredHandle, INFINITE);
                if (result == 0) Environment.Exit(125); // daemon died: close Job handle
            });
            job = CreateJobObject(IntPtr.Zero, null);
            Check(job != IntPtr.Zero, "CreateJobObject");
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            limits.BasicLimitInformation.ActiveProcessLimit = 128;
            Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                ref limits, (uint)Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()),
                "SetInformationJobObject");

            var attr = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf<SECURITY_ATTRIBUTES>(),
                bInheritHandle = true };
            Check(CreatePipe(out stdinRead, out stdinWrite, ref attr, 0), "CreatePipe(stdin)");
            Check(CreatePipe(out stdoutRead, out stdoutWrite, ref attr, 0), "CreatePipe(stdout)");
            Check(CreatePipe(out stderrRead, out stderrWrite, ref attr, 0), "CreatePipe(stderr)");
            Check(SetHandleInformation(stdinWrite, HANDLE_FLAG_INHERIT, 0), "SetHandleInformation(stdin)");
            Check(SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0), "SetHandleInformation(stdout)");
            Check(SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0), "SetHandleInformation(stderr)");

            var startup = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>(),
                dwFlags = (int)STARTF_USESTDHANDLES,
                hStdInput = stdinRead, hStdOutput = stdoutWrite, hStdError = stderrWrite };
            Check(CreateProcess(exe, new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                IntPtr.Zero, request.Cwd, ref startup, out var child), "CreateProcess");
            processHandle = child.hProcess;
            threadHandle = child.hThread;

            // Critical: the child cannot run even its first instruction until it
            // belongs to our kill-on-close Job Object.
            Check(AssignProcessToJobObject(job, processHandle), "AssignProcessToJobObject");
            if (ResumeThread(threadHandle) == uint.MaxValue)
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");
            CloseHandle(threadHandle); threadHandle = IntPtr.Zero;
            CloseHandle(stdinRead); stdinRead = IntPtr.Zero;
            CloseHandle(stdoutWrite); stdoutWrite = IntPtr.Zero;
            CloseHandle(stderrWrite); stderrWrite = IntPtr.Zero;

            using var stdinPipe = new FileStream(new SafeFileHandle(stdinWrite, true), FileAccess.Write, 65536, false);
            using var stdoutPipe = new FileStream(new SafeFileHandle(stdoutRead, true), FileAccess.Read, 65536, false);
            using var stderrPipe = new FileStream(new SafeFileHandle(stderrRead, true), FileAccess.Read, 65536, false);
            stdinWrite = stdoutRead = stderrRead = IntPtr.Zero; // SafeFileHandle now owns them.
            var copyOut = CopySilently(stdoutPipe, Console.OpenStandardOutput());
            var copyErr = CopySilently(stderrPipe, Console.OpenStandardError());
            _ = Task.Run(async () => { try { await Console.OpenStandardInput().CopyToAsync(stdinPipe); }
                                       catch (IOException) { } catch (ObjectDisposedException) { } });
            var wait = await Task.Run(() => WaitForSingleObject(processHandle, INFINITE));
            if (wait != 0) throw new InvalidOperationException("WaitForSingleObject returned " + wait);
            Check(GetExitCodeProcess(processHandle, out var exitCode), "GetExitCodeProcess");
            CloseHandle(job); job = IntPtr.Zero; // Kill any descendants still running after root exits.
            await Task.WhenAll(copyOut, copyErr).WaitAsync(TimeSpan.FromSeconds(5));
            return unchecked((int)exitCode);
        }
        finally
        {
            if (job != IntPtr.Zero) CloseHandle(job);
            // Parent process handle is intentionally held until process shutdown;
            // the watchdog is still waiting on it on a background thread.
            if (processHandle != IntPtr.Zero) CloseHandle(processHandle);
            if (threadHandle != IntPtr.Zero) { if (processHandle != IntPtr.Zero) TerminateProcess(processHandle, 125); CloseHandle(threadHandle); }
            foreach (var h in new[] { stdinRead, stdinWrite, stdoutRead, stdoutWrite, stderrRead, stderrWrite })
                if (h != IntPtr.Zero) CloseHandle(h);
        }
    }
    private static async Task CopySilently(Stream from, Stream to)
    {
        try { await from.CopyToAsync(to); await to.FlushAsync(); }
        catch (IOException) { } catch (ObjectDisposedException) { }
    }
}

