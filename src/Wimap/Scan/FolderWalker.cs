namespace Wimap.Scan;

/// <summary>
/// Walks a folder once: every file counts toward sizes, but only the first
/// <c>depth</c> levels become map nodes, and each folder keeps its largest children.
/// </summary>
public sealed class FolderWalker
{
    private static readonly EnumerationOptions Opts = new()
    {
        IgnoreInaccessible = true,
        RecurseSubdirectories = false,
        // Nothing is skipped by attribute: OneDrive files that live only in the cloud are reparse points too,
        // and their sizes count. Links to other folders are skipped below instead.
        AttributesToSkip = FileAttributes.None,
        ReturnSpecialDirectories = false,
    };

    private readonly Progress _progress;
    private readonly CancellationToken _ct;

    public int MaxFolders { get; init; } = 40;
    /// <summary>Files shown as leaves per folder (largest first). 0 shows none.</summary>
    public int MaxFiles { get; init; }
    /// <summary>Only show .exe files as leaves, and only near the top of the tree.</summary>
    public bool ExeOnly { get; init; }
    /// <summary>Stop counting after this many entries so one huge folder cannot stall the scan.</summary>
    public long Budget { get; init; } = 400_000;
    /// <summary>List the drawn levels only, without walking below them. Folder sizes are then unknown (null).</summary>
    public bool Shallow { get; init; }
    /// <summary>Folders mapped elsewhere (for example Documents inside OneDrive), skipped so nothing is counted twice.</summary>
    public IReadOnlySet<string>? Exclude { get; init; }

    public FolderWalker(Progress progress, CancellationToken ct) { _progress = progress; _ct = ct; }

    /// <summary>True for junctions and symbolic links; false for cloud placeholders, which are reparse points but hold real content.</summary>
    private static bool IsLink(DirectoryInfo d)
    {
        try { return d.LinkTarget != null; }
        catch { return true; } // unreadable reparse data: safer to skip than to loop
    }

    public Node Walk(string path, int depth, string? name = null, string kind = "folder")
    {
        long seen = 0;
        var node = WalkDir(new DirectoryInfo(path), 0, depth, ref seen);
        node.Name = name ?? node.Name;
        node.Kind = kind;
        if (seen >= Budget) node.Approx = true;
        return node;
    }

    private Node WalkDir(DirectoryInfo dir, int level, int depth, ref long seen)
    {
        var node = new Node(dir.Name.Length > 0 ? dir.Name : dir.FullName, "folder") { Path = dir.FullName };
        long size = 0;
        var folders = new List<Node>();
        var files = new List<(string name, string path, long len)>();
        bool materialize = level < depth;
        if (!materialize && Shallow) return node;

        try
        {
            foreach (var e in dir.EnumerateFileSystemInfos("*", Opts))
            {
                _ct.ThrowIfCancellationRequested();
                if (++seen > Budget) { node.Approx = true; break; }
                if (e is FileInfo f)
                {
                    long len = 0;
                    try { len = f.Length; } catch { }
                    size += len;
                    _progress.Files(1, len);
                    if (materialize && (MaxFiles > 0 || ExeOnly)) files.Add((f.Name, f.FullName, len));
                }
                else if (e is DirectoryInfo d)
                {
                    if (Exclude != null && Exclude.Contains(d.FullName)) continue;
                    // Junctions and symbolic links would loop back or count a folder twice.
                    if (d.Attributes.HasFlag(FileAttributes.ReparsePoint) && IsLink(d)) continue;
                    var child = WalkDir(d, level + 1, depth, ref seen);
                    size += child.Size ?? 0;
                    if (child.Approx == true) node.Approx = true;
                    if (materialize) folders.Add(child);
                }
            }
        }
        catch (OperationCanceledException) { throw; }
        catch { /* access denied mid-walk: keep what we have */ }

        node.Size = Shallow ? null : size;
        if (level % 2 == 0) _progress.Path(dir.FullName);
        if (!materialize) return node;

        if (Shallow) folders.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
        else folders.Sort((a, b) => (b.Size ?? 0).CompareTo(a.Size ?? 0));
        foreach (var f in folders.Take(MaxFolders)) node.Add(f);
        if (folders.Count > MaxFolders)
        {
            var rest = folders.Skip(MaxFolders).ToList();
            node.Add(new Node($"{rest.Count} more folders", "more") { Size = rest.Sum(r => r.Size ?? 0) });
        }

        IEnumerable<(string name, string path, long len)> shown = files;
        int cap = MaxFiles;
        if (ExeOnly)
        {
            shown = level <= 1 ? files.Where(f => f.name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) : Enumerable.Empty<(string, string, long)>();
            cap = 12;
        }
        var list = shown.OrderByDescending(f => f.len).ToList();
        foreach (var f in list.Take(cap))
            node.Add(new Node(f.name, ExeOnly ? "exe" : "file") { Path = f.path, Size = f.len });
        if (!ExeOnly && list.Count > cap)
        {
            var rest = list.Skip(cap).ToList();
            node.Add(new Node($"{rest.Count} more files", "more") { Size = rest.Sum(r => r.len) });
        }
        return node;
    }
}

/// <summary>Thread-safe progress counters, polled by the host on a timer.</summary>
public sealed class Progress
{
    private long _files, _bytes;
    private volatile string _path = "";
    public void Files(long n, long bytes) { Interlocked.Add(ref _files, n); Interlocked.Add(ref _bytes, bytes); }
    public void Path(string p) => _path = p;
    public (long files, long bytes, string path) Read() => (Interlocked.Read(ref _files), Interlocked.Read(ref _bytes), _path);
}
