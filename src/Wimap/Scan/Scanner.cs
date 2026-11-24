using System.Diagnostics;

namespace Wimap.Scan;

/// <summary>Runs every branch scan in parallel and reports each branch as soon as it is ready.</summary>
public sealed class Scanner
{
    public static readonly string[] Order = { "apps", "ai", "browsers", "files", "drives", "dev", "system" };

    public Progress Progress { get; } = new();
    public IconStore Icons { get; } = new();

    /// <param name="onBranch">Called from worker threads with (key, node) when a branch finishes, or (key, null) when it fails.</param>
    /// <param name="onStage">Called with (key, "running") as a branch starts.</param>
    public async Task<ScanResult> RunAsync(ScanOptions opt, Action<string, Node?> onBranch, Action<string, string> onStage, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var result = new ScanResult { Os = SystemScanner.OsName() };
        var branches = new Dictionary<string, Node>();
        long appsListMs = 0;

        Task Run(string key, bool enabled, Func<Node> work) => !enabled ? Task.CompletedTask : Task.Run(() =>
        {
            onStage(key, "running");
            var t = Stopwatch.StartNew();
            Node? n = null;
            try { n = work(); }
            catch (OperationCanceledException) { }
            catch (Exception e) { Log.Error($"scan branch {key}", e); }
            lock (branches)
            {
                if (n != null) branches[key] = n;
                result.Timings[key] = t.ElapsedMilliseconds + (key == "apps" ? appsListMs : 0);
            }
            onBranch(key, n);
        }, CancellationToken.None);

        // Branches that do not need the app list start right away.
        var independent = new[]
        {
            Run("browsers", opt.Browsers, () => BrowserScanner.Build(Icons)),
            Run("dev", opt.Dev, () => SystemScanner.Dev(Icons)),
            Run("system", opt.System, () => SystemScanner.SystemBits(Icons)),
            Run("files", opt.Files, () => FilesScanner.UserFolders(opt, Progress, ct)),
            Run("drives", opt.Drives, () => FilesScanner.Drives(Progress, ct)),
        };

        // The app list feeds both the Apps and AI branches, so they wait for it.
        List<AppsScanner.App> apps = new();
        if (opt.Apps || opt.Ai)
        {
            onStage("apps", "running");
            try { apps = await Task.Run(() => AppsScanner.ReadAll(Icons, ct), ct); }
            catch (OperationCanceledException) { }
        }
        appsListMs = sw.ElapsedMilliseconds;

        await Task.WhenAll(independent.Concat(new[]
        {
            Run("ai", opt.Ai, () => AiScanner.Build(apps, Icons)),
            Run("apps", opt.Apps, () => AppsScanner.Build(apps, opt, Progress, ct)),
        }));

        foreach (var key in Order)
            if (branches.TryGetValue(key, out var b)) result.Root.Add(b);
        result.Root.Size = branches.TryGetValue("drives", out var d) ? d.Size : null;
        result.Icons = Icons.Snapshot();
        result.DurationMs = sw.ElapsedMilliseconds;
        return result;
    }
}
