using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Wimap.Scan;

namespace Wimap;

static class Program
{
    public static readonly JsonSerializerOptions Json = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public static readonly string DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Wimap");

    [STAThread]
    static int Main(string[] args)
    {
        // Headless mode for testing and scripting: Wimap.exe --scan out.json
        if (args.Length >= 2 && args[0] == "--scan")
        {
            try
            {
                var res = new Scanner().RunAsync(new ScanOptions(), (_, _) => { }, (_, _) => { }, CancellationToken.None).GetAwaiter().GetResult();
                File.WriteAllText(Path.GetFullPath(args[1]), JsonSerializer.Serialize(res, Json));
                return 0;
            }
            catch (Exception e) { Log.Error("headless scan", e); return 1; }
        }

        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => Crash(e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Crash(e.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, e) => { Log.Error("unobserved task", e.Exception); e.SetObserved(); };

        // The installer looks for this name (AppMutex) to ask the user to close Wimap before updating or removing it.
        using var running = new Mutex(false, "Wimap.App.Running");
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
        return 0;
    }

    private static void Crash(Exception? e)
    {
        Log.Error("unhandled", e);
        MessageBox.Show($"Wimap hit an unexpected error and may need to restart.\n\n{e?.Message}\n\nDetails are in {Log.FilePath}",
            "Wimap", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }
}

/// <summary>Plain-text log in %LOCALAPPDATA%\Wimap\wimap.log, trimmed when it grows past 1 MB.</summary>
static class Log
{
    public static readonly string FilePath = Path.Combine(Program.DataDir, "wimap.log");
    private static readonly object Gate = new();

    public static void Error(string where, Exception? e) => Write($"ERROR {where}: {e}");

    public static void Write(string line)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(Program.DataDir);
                var info = new FileInfo(FilePath);
                if (info.Exists && info.Length > 1_000_000) info.Delete();
                File.AppendAllText(FilePath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {line}{Environment.NewLine}");
            }
        }
        catch { /* logging must never take the app down */ }
    }
}
