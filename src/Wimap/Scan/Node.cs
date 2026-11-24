using System.Text.Json.Serialization;

namespace Wimap.Scan;

/// <summary>One point on the map. Short JSON keys keep exported files small.</summary>
public sealed class Node
{
    [JsonPropertyName("n")] public string Name { get; set; }
    /// <summary>Kind: root, cat, group, app, store, game, folder, file, exe, more, ai, mcp, plugin, skill, agent, cmd, doc, model, browser, profile, bmf, bm, ext, drive, runtime, pkg, vsx, startup, font, wsl</summary>
    [JsonPropertyName("k")] public string Kind { get; set; }
    [JsonPropertyName("s")] public long? Size { get; set; }
    [JsonPropertyName("p")] public string? Path { get; set; }
    [JsonPropertyName("u")] public string? Url { get; set; }
    [JsonPropertyName("d")] public string? Detail { get; set; }
    [JsonPropertyName("v")] public string? Version { get; set; }
    [JsonPropertyName("b")] public string? By { get; set; }
    [JsonPropertyName("t")] public string? Date { get; set; }
    [JsonPropertyName("i")] public string? Icon { get; set; }
    /// <summary>Set when the size walk hit its budget, so Size is a lower bound.</summary>
    [JsonPropertyName("a")] public bool? Approx { get; set; }
    /// <summary>Category key that colors this branch (only on cat nodes).</summary>
    [JsonPropertyName("ck")] public string? CatKey { get; set; }
    [JsonPropertyName("c")] public List<Node>? Children { get; set; }

    public Node(string name, string kind) { Name = name; Kind = kind; }

    public void Add(Node? child) { if (child != null) (Children ??= new()).Add(child); }

    public void AddRange(IEnumerable<Node> kids) { foreach (var k in kids) Add(k); }

    /// <summary>Drop empty group nodes so the map never shows a branch with nothing in it.</summary>
    public Node? NullIfEmpty() => Children is { Count: > 0 } ? this : null;

    public void SortChildren(bool bySize = false)
    {
        if (Children == null) return;
        Children = bySize
            ? Children.OrderByDescending(c => c.Size ?? 0).ThenBy(c => c.Name, StringComparer.OrdinalIgnoreCase).ToList()
            : Children.OrderBy(c => c.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }
}

/// <summary>Shared, thread-safe store of small PNG icons (data URIs) keyed by content hash.</summary>
public sealed class IconStore
{
    private readonly Dictionary<string, string> _icons = new();
    private readonly object _lock = new();

    public string Put(byte[] png)
    {
        var key = Convert.ToHexString(System.Security.Cryptography.SHA1.HashData(png))[..12].ToLowerInvariant();
        lock (_lock) _icons.TryAdd(key, "data:image/png;base64," + Convert.ToBase64String(png));
        return key;
    }

    public Dictionary<string, string> Snapshot() { lock (_lock) return new(_icons); }

    private readonly HashSet<string> _taken = new();

    /// <summary>Icons added since the last call; used to stream icons without resending them.</summary>
    public Dictionary<string, string> TakeNew()
    {
        lock (_lock)
        {
            var fresh = _icons.Where(kv => _taken.Add(kv.Key)).ToDictionary(kv => kv.Key, kv => kv.Value);
            return fresh;
        }
    }
}

public sealed class ScanOptions
{
    public bool Apps { get; set; } = true;
    public bool Ai { get; set; } = true;
    public bool Browsers { get; set; } = true;
    public bool Files { get; set; } = true;
    public bool Drives { get; set; } = true;
    public bool Dev { get; set; } = true;
    public bool System { get; set; } = true;
    /// <summary>How many folder levels below an app or user folder are drawn.</summary>
    public int Depth { get; set; } = 3;
}

public sealed class ScanResult
{
    [JsonPropertyName("v")] public int Version { get; set; } = 1;
    [JsonPropertyName("machine")] public string Machine { get; set; } = Environment.MachineName;
    [JsonPropertyName("user")] public string User { get; set; } = Environment.UserName;
    [JsonPropertyName("home")] public string Home { get; set; } = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    [JsonPropertyName("os")] public string Os { get; set; } = "";
    [JsonPropertyName("at")] public string At { get; set; } = DateTimeOffset.Now.ToString("o");
    [JsonPropertyName("ms")] public long DurationMs { get; set; }
    /// <summary>Milliseconds each branch took, by branch key.</summary>
    [JsonPropertyName("timings")] public Dictionary<string, long> Timings { get; set; } = new();
    [JsonPropertyName("root")] public Node Root { get; set; } = new(Environment.MachineName, "root");
    [JsonPropertyName("icons")] public Dictionary<string, string> Icons { get; set; } = new();
}
