namespace Wimap.Scan;

/// <summary>The user's own folders and every drive.</summary>
public static class FilesScanner
{
    public static Node UserFolders(ScanOptions opt, Progress progress, CancellationToken ct)
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var known = new List<(string name, string? path)>
        {
            ("Desktop", Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory)),
            ("Documents", Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)),
            ("Downloads", KnownFolder(new Guid("374DE290-123F-4565-9164-39C4925E467B")) ?? Path.Combine(home, "Downloads")),
            ("Pictures", Environment.GetFolderPath(Environment.SpecialFolder.MyPictures)),
            ("Music", Environment.GetFolderPath(Environment.SpecialFolder.MyMusic)),
            ("Videos", Environment.GetFolderPath(Environment.SpecialFolder.MyVideos)),
        };
        var od = Environment.GetEnvironmentVariable("OneDrive");
        if (od != null) known.Add(("OneDrive", od));

        var cat = new Node("Your files", "cat") { CatKey = "files", Path = home };
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var targets = known.Where(k => !string.IsNullOrEmpty(k.path) && Directory.Exists(k.path) && seen.Add(k.path!)).ToList();
        // Known folders are often redirected inside OneDrive; each is mapped once, under its own name.
        var mapped = new HashSet<string>(targets.Select(t => Path.TrimEndingDirectorySeparator(Path.GetFullPath(t.path!))), StringComparer.OrdinalIgnoreCase);
        var nodes = new Node?[targets.Count];
        Parallel.For(0, targets.Count, new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = ct }, i =>
        {
            var self = Path.TrimEndingDirectorySeparator(Path.GetFullPath(targets[i].path!));
            var others = new HashSet<string>(mapped.Where(p => !p.Equals(self, StringComparison.OrdinalIgnoreCase)), StringComparer.OrdinalIgnoreCase);
            var walker = new FolderWalker(progress, ct) { MaxFolders = 30, MaxFiles = 12, Budget = 600_000, Exclude = others };
            try { nodes[i] = walker.Walk(targets[i].path!, opt.Depth, targets[i].name, "folder"); }
            catch (OperationCanceledException) { throw; }
            catch { }
        });
        foreach (var n in nodes) cat.Add(n);
        cat.Size = cat.Children?.Sum(c => c.Size ?? 0);
        return cat;
    }

    public static Node Drives(Progress progress, CancellationToken ct)
    {
        var cat = new Node("Drives", "cat") { CatKey = "drives" };
        var drives = DriveInfo.GetDrives().Where(d => d.IsReady && d.DriveType is DriveType.Fixed or DriveType.Removable).ToList();
        var nodes = new Node?[drives.Count];
        Parallel.For(0, drives.Count, new ParallelOptions { CancellationToken = ct }, i =>
        {
            var d = drives[i];
            // Two levels of names only. Walking a whole drive for folder sizes takes minutes; used and free space come from the volume.
            var walker = new FolderWalker(progress, ct) { MaxFolders = 40, MaxFiles = 8, Shallow = true };
            Node n;
            try { n = walker.Walk(d.RootDirectory.FullName, 2, null, "drive"); }
            catch (OperationCanceledException) { throw; }
            catch { n = new Node(d.Name, "drive"); }
            n.Name = d.Name.TrimEnd('\\');
            n.Path = d.RootDirectory.FullName;
            n.Approx = null;
            try
            {
                // A USB stick pulled out mid-scan throws here; the drive keeps its letter and loses only the details.
                var label = string.IsNullOrWhiteSpace(d.VolumeLabel) ? (d.DriveType == DriveType.Removable ? "Removable" : "Local disk") : d.VolumeLabel;
                n.Name = $"{label} ({d.Name.TrimEnd('\\')})";
                n.Detail = $"{d.DriveFormat} · {Fmt(d.TotalSize - d.TotalFreeSpace)} used of {Fmt(d.TotalSize)} · {Fmt(d.TotalFreeSpace)} free";
                n.Size = d.TotalSize - d.TotalFreeSpace; // true used space beats the walk, which skips protected folders
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            nodes[i] = n;
        });
        foreach (var n in nodes) cat.Add(n);
        cat.Size = cat.Children?.Sum(c => c.Size ?? 0);
        return cat;
    }

    public static string Fmt(long b)
    {
        string[] u = { "B", "KB", "MB", "GB", "TB" };
        double v = b; int i = 0;
        while (v >= 1024 && i < u.Length - 1) { v /= 1024; i++; }
        return i == 0 ? $"{b} B" : $"{v:0.#} {u[i]}";
    }

    [System.Runtime.InteropServices.DllImport("shell32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern int SHGetKnownFolderPath([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPStruct)] Guid id, uint flags, IntPtr token, out string path);

    private static string? KnownFolder(Guid id) => SHGetKnownFolderPath(id, 0, IntPtr.Zero, out var p) == 0 ? p : null;
}
