using System.Text;
using System.Text.Json;

namespace Wimap.Scan;

/// <summary>Bookmarks and extensions for Chromium and Gecko browsers, per profile. History, cookies and passwords are never read.</summary>
public static class BrowserScanner
{
    private static readonly string Local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    private static readonly string Roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);

    private static readonly (string name, string dir, bool single, string store)[] Chromium =
    {
        ("Chrome", Path.Combine(Local, @"Google\Chrome\User Data"), false, "chrome"),
        ("Edge", Path.Combine(Local, @"Microsoft\Edge\User Data"), false, "edge"),
        ("Brave", Path.Combine(Local, @"BraveSoftware\Brave-Browser\User Data"), false, "chrome"),
        ("Vivaldi", Path.Combine(Local, @"Vivaldi\User Data"), false, "chrome"),
        ("Opera", Path.Combine(Roaming, @"Opera Software\Opera Stable"), true, "chrome"),
        ("Opera GX", Path.Combine(Roaming, @"Opera Software\Opera GX Stable"), true, "chrome"),
        ("Chromium", Path.Combine(Local, @"Chromium\User Data"), false, "chrome"),
        ("Yandex", Path.Combine(Local, @"Yandex\YandexBrowser\User Data"), false, "chrome"),
        ("Thorium", Path.Combine(Local, @"Thorium\User Data"), false, "chrome"),
        ("Arc", Path.Combine(Local, @"Packages\TheBrowserCompany.Arc_ttt1ap7aakyb4\LocalCache\Local\Arc\User Data"), false, "chrome"),
        ("Comet", Path.Combine(Local, @"Perplexity\Comet\User Data"), false, "chrome"),
    };

    private static readonly (string name, string dir)[] Gecko =
    {
        ("Firefox", Path.Combine(Roaming, @"Mozilla\Firefox")),
        ("Zen", Path.Combine(Roaming, "zen")),
        ("LibreWolf", Path.Combine(Roaming, "librewolf")),
        ("Floorp", Path.Combine(Roaming, "Floorp")),
        ("Waterfox", Path.Combine(Roaming, "Waterfox")),
    };

    public static Node Build(IconStore icons)
    {
        var cat = new Node("Browsers", "cat") { CatKey = "browsers" };
        foreach (var b in Chromium)
        {
            if (!Directory.Exists(b.dir)) continue;
            var node = new Node(b.name, "browser") { Path = b.dir };
            var profiles = b.single ? new List<(string, string)> { (b.dir, "Default") } : ChromiumProfiles(b.dir);
            foreach (var (dir, label) in profiles)
            {
                var p = new Node(label, "profile") { Path = dir };
                p.Add(ChromiumBookmarks(Path.Combine(dir, "Bookmarks")));
                p.Add(ChromiumExtensions(Path.Combine(dir, "Extensions"), b.store, icons));
                if (p.Children != null) node.Add(p);
            }
            Flatten(node);
            cat.Add(node);
        }
        foreach (var g in Gecko)
        {
            var ini = Path.Combine(g.dir, "profiles.ini");
            if (!File.Exists(ini)) continue;
            var node = new Node(g.name, "browser") { Path = g.dir };
            foreach (var (dir, label) in GeckoProfiles(ini, g.dir))
            {
                var p = new Node(label, "profile") { Path = dir };
                p.Add(GeckoBookmarks(dir));
                p.Add(GeckoExtensions(dir, icons));
                if (p.Children != null) node.Add(p);
            }
            Flatten(node);
            cat.Add(node);
        }
        return cat;
    }

    /// <summary>One profile adds a needless ring; lift its contents to the browser.</summary>
    private static void Flatten(Node browser)
    {
        if (browser.Children is { Count: 1 } && browser.Children[0].Kind == "profile")
        {
            var only = browser.Children[0];
            browser.Detail = "Profile: " + only.Name;
            browser.Children = only.Children;
        }
    }

    private static List<(string dir, string label)> ChromiumProfiles(string userData)
    {
        var list = new List<(string, string)>();
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(userData, "Local State")));
            if (doc.RootElement.TryGetProperty("profile", out var p) && p.TryGetProperty("info_cache", out var cache))
                foreach (var e in cache.EnumerateObject())
                {
                    var dir = Path.Combine(userData, e.Name);
                    if (!Directory.Exists(dir)) continue;
                    var name = e.Value.TryGetProperty("name", out var n) ? n.GetString() : e.Name;
                    list.Add((dir, string.IsNullOrWhiteSpace(name) ? e.Name : name!));
                }
        }
        catch { }
        if (list.Count == 0)
            foreach (var d in AiScanner.SafeDirs(userData).Where(d => Path.GetFileName(d) is "Default" || Path.GetFileName(d).StartsWith("Profile ")))
                list.Add((d, Path.GetFileName(d)));
        return list;
    }

    private static Node? ChromiumBookmarks(string file)
    {
        if (!File.Exists(file)) return null;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file));
            var roots = doc.RootElement.GetProperty("roots");
            var g = new Node("Bookmarks", "group");
            foreach (var key in new[] { "bookmark_bar", "other", "synced" })
                if (roots.TryGetProperty(key, out var r))
                {
                    var n = ChromiumFolder(r);
                    if (n.Children is { Count: > 0 }) g.Add(n);
                }
            // A lone bookmarks bar adds nothing as its own ring.
            if (g.Children is { Count: 1 }) { g.Children = g.Children[0].Children; }
            return g.NullIfEmpty();
        }
        catch { return null; }
    }

    private static Node ChromiumFolder(JsonElement e)
    {
        var name = e.TryGetProperty("name", out var n) ? n.GetString() ?? "Folder" : "Folder";
        var node = new Node(name, "bmf");
        if (!e.TryGetProperty("children", out var kids)) return node;
        foreach (var c in kids.EnumerateArray())
        {
            var type = c.TryGetProperty("type", out var t) ? t.GetString() : null;
            if (type == "folder") { var f = ChromiumFolder(c); if (f.Children != null) node.Add(f); }
            else if (type == "url")
            {
                var url = c.GetProperty("url").GetString();
                var title = c.TryGetProperty("name", out var tn) ? tn.GetString() : null;
                node.Add(new Node(string.IsNullOrWhiteSpace(title) ? url ?? "Bookmark" : title!, "bm") { Url = CleanUrl(url) });
            }
        }
        return node;
    }

    private static Node? ChromiumExtensions(string dir, string store, IconStore icons)
    {
        if (!Directory.Exists(dir)) return null;
        var g = new Node("Extensions", "group");
        foreach (var idDir in AiScanner.SafeDirs(dir))
        {
            var id = Path.GetFileName(idDir);
            if (id == "Temp") continue;
            var ver = AiScanner.SafeDirs(idDir).OrderByDescending(Directory.GetLastWriteTimeUtc).FirstOrDefault();
            if (ver == null) continue;
            var manifest = Path.Combine(ver, "manifest.json");
            if (!File.Exists(manifest)) continue;
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(manifest), new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
                var r = doc.RootElement;
                var name = Msg(ver, r, r.TryGetProperty("name", out var nm) ? nm.GetString() : id) ?? id;
                var desc = Msg(ver, r, r.TryGetProperty("description", out var ds) ? ds.GetString() : null);
                var n = new Node(name, "ext")
                {
                    Path = ver,
                    Version = r.TryGetProperty("version", out var v) ? v.GetString() : null,
                    Detail = desc is { Length: > 180 } ? desc[..177] + "…" : desc,
                    Url = store == "edge" ? $"https://microsoftedge.microsoft.com/addons/detail/{id}" : $"https://chromewebstore.google.com/detail/{id}",
                };
                if (r.TryGetProperty("icons", out var ic) && ic.ValueKind == JsonValueKind.Object)
                {
                    var best = ic.EnumerateObject().Select(p => (size: int.TryParse(p.Name, out var s) ? s : 0, path: p.Value.GetString()))
                        .Where(p => p.path != null).OrderBy(p => Math.Abs(p.size - 48)).FirstOrDefault();
                    if (best.path != null) n.Icon = Icons.FromFile(icons, Path.Combine(ver, best.path.TrimStart('/').Replace('/', '\\')));
                }
                g.Add(n);
            }
            catch { }
        }
        g.SortChildren();
        return g.NullIfEmpty();
    }

    /// <summary>Resolve <c>__MSG_key__</c> names through the extension's locale files.</summary>
    private static string? Msg(string extDir, JsonElement manifest, string? value)
    {
        if (value == null || !value.StartsWith("__MSG_")) return value;
        var key = value[6..^2];
        var loc = manifest.TryGetProperty("default_locale", out var dl) ? dl.GetString() : "en";
        foreach (var l in new[] { "en", "en_US", loc }.Distinct())
        {
            var f = Path.Combine(extDir, "_locales", l ?? "en", "messages.json");
            if (!File.Exists(f)) continue;
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(f), new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
                foreach (var p in doc.RootElement.EnumerateObject())
                    if (p.Name.Equals(key, StringComparison.OrdinalIgnoreCase) && p.Value.TryGetProperty("message", out var m))
                        return m.GetString();
            }
            catch { }
        }
        return null;
    }

    private static List<(string dir, string label)> GeckoProfiles(string ini, string root)
    {
        var list = new List<(string, string)>();
        string? name = null, path = null; bool rel = true;
        void Flush()
        {
            if (path != null)
            {
                var dir = rel ? Path.Combine(root, path.Replace('/', '\\')) : path;
                if (Directory.Exists(dir)) list.Add((dir, name ?? Path.GetFileName(dir)));
            }
            name = null; path = null; rel = true;
        }
        foreach (var raw in File.ReadAllLines(ini))
        {
            var line = raw.Trim();
            if (line.StartsWith('[')) { Flush(); continue; }
            if (line.StartsWith("Name=")) name = line[5..];
            else if (line.StartsWith("Path=")) path = line[5..];
            else if (line.StartsWith("IsRelative=")) rel = line.EndsWith('1');
        }
        Flush();
        return list.DistinctBy(x => x.Item1.ToLowerInvariant()).ToList();
    }

    private static Node? GeckoExtensions(string profile, IconStore icons)
    {
        var f = Path.Combine(profile, "extensions.json");
        if (!File.Exists(f)) return null;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(f));
            var g = new Node("Extensions", "group");
            foreach (var a in doc.RootElement.GetProperty("addons").EnumerateArray())
            {
                if (a.TryGetProperty("location", out var loc) && loc.GetString() != "app-profile") continue;
                if (a.TryGetProperty("type", out var t) && t.GetString() is not ("extension" or "theme")) continue;
                var lp = a.TryGetProperty("defaultLocale", out var d) && d.ValueKind == JsonValueKind.Object ? d : a;
                var name = lp.TryGetProperty("name", out var n) ? n.GetString() : a.GetProperty("id").GetString();
                var id = a.GetProperty("id").GetString();
                g.Add(new Node(name ?? id ?? "Add-on", "ext")
                {
                    Version = a.TryGetProperty("version", out var v) ? v.GetString() : null,
                    Detail = lp.TryGetProperty("description", out var ds) ? ds.GetString() : null,
                    Url = $"https://addons.mozilla.org/firefox/addon/{Uri.EscapeDataString(id ?? "")}",
                });
            }
            g.SortChildren();
            return g.NullIfEmpty();
        }
        catch { return null; }
    }

    /// <summary>Reads the newest bookmark backup (mozLz4 compressed JSON), so the locked places.sqlite is never opened.</summary>
    private static Node? GeckoBookmarks(string profile)
    {
        var dir = Path.Combine(profile, "bookmarkbackups");
        var latest = AiScanner.SafeFilesIn(dir).Where(f => f.EndsWith(".jsonlz4") || f.EndsWith(".json")).OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault();
        if (latest == null) return null;
        try
        {
            var bytes = File.ReadAllBytes(latest);
            var json = latest.EndsWith(".jsonlz4") ? Encoding.UTF8.GetString(MozLz4(bytes)) : Encoding.UTF8.GetString(bytes);
            using var doc = JsonDocument.Parse(json);
            var g = new Node("Bookmarks", "group");
            if (doc.RootElement.TryGetProperty("children", out var roots))
                foreach (var r in roots.EnumerateArray())
                {
                    var n = GeckoFolder(r);
                    if (n.Children is { Count: > 0 }) g.Add(n);
                }
            return g.NullIfEmpty();
        }
        catch { return null; }
    }

    private static Node GeckoFolder(JsonElement e)
    {
        var title = e.TryGetProperty("title", out var t) ? t.GetString() : null;
        var guid = e.TryGetProperty("guid", out var gu) ? gu.GetString() : null;
        title = guid switch { "toolbar_____" => "Bookmarks toolbar", "menu________" => "Bookmarks menu", "unfiled_____" => "Other bookmarks", "mobile______" => "Mobile", _ => title };
        var node = new Node(string.IsNullOrWhiteSpace(title) ? "Folder" : title!, "bmf");
        if (!e.TryGetProperty("children", out var kids)) return node;
        foreach (var c in kids.EnumerateArray())
        {
            var type = c.TryGetProperty("type", out var ty) ? ty.GetString() : null;
            if (type == "text/x-moz-place-container") { var f = GeckoFolder(c); if (f.Children != null) node.Add(f); }
            else if (type == "text/x-moz-place" && c.TryGetProperty("uri", out var u))
            {
                var url = u.GetString();
                if (url == null || url.StartsWith("place:")) continue;
                var tt = c.TryGetProperty("title", out var ct) ? ct.GetString() : null;
                node.Add(new Node(string.IsNullOrWhiteSpace(tt) ? url : tt!, "bm") { Url = CleanUrl(url) });
            }
        }
        return node;
    }

    private static readonly System.Text.RegularExpressions.Regex SensitiveParam = new(
        @"^(.*[_-])?(token|access_token|id_token|refresh_token|auth|authorization|key|api_?key|secret|password|passwd|pwd|sig|signature|session|sessionid|sid|code|credential|ticket|otp)$",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>
    /// Keeps a bookmark usable but drops what should never travel in a shared map:
    /// user:password@ parts and query or fragment values whose names mean a secret (token, key, sig, session...).
    /// </summary>
    public static string? CleanUrl(string? url)
    {
        if (string.IsNullOrEmpty(url) || !Uri.TryCreate(url, UriKind.Absolute, out var u) || (u.Scheme != "http" && u.Scheme != "https")) return url;
        static string Filter(string part, char lead)
        {
            if (part.Length <= 1) return part;
            var kept = part[1..].Split('&').Where(p =>
            {
                var name = Uri.UnescapeDataString(p.Split('=')[0]);
                return !SensitiveParam.IsMatch(name);
            }).ToList();
            return kept.Count == 0 ? "" : lead + string.Join('&', kept);
        }
        var b = new UriBuilder(u) { UserName = "", Password = "" };
        var query = Filter(u.Query, '?');
        // A fragment is only parsed as parameters when it looks like them (#access_token=...); #section stays.
        var fragment = u.Fragment.Contains('=') ? Filter(u.Fragment, '#') : u.Fragment;
        b.Query = query.TrimStart('?');
        b.Fragment = fragment.TrimStart('#');
        var clean = b.Uri.AbsoluteUri;
        // UriBuilder adds a default port and trailing pieces only when they differ; keep the original when nothing was removed.
        return query == u.Query && fragment == u.Fragment && string.IsNullOrEmpty(u.UserInfo) ? url : clean;
    }

    /// <summary>mozLz4: "mozLz40\0", uint32 decompressed size, then one raw LZ4 block.</summary>
    public static byte[] MozLz4(byte[] src)
    {
        if (src.Length < 12 || Encoding.ASCII.GetString(src, 0, 8) != "mozLz40\0") throw new InvalidDataException("not mozLz4");
        int outLen = BitConverter.ToInt32(src, 8);
        var dst = new byte[outLen];
        int s = 12, d = 0;
        while (s < src.Length)
        {
            int token = src[s++];
            int lit = token >> 4;
            if (lit == 15) { int b; do { b = src[s++]; lit += b; } while (b == 255); }
            Buffer.BlockCopy(src, s, dst, d, lit); s += lit; d += lit;
            if (s >= src.Length) break;
            int offset = src[s] | (src[s + 1] << 8); s += 2;
            int len = token & 15;
            if (len == 15) { int b; do { b = src[s++]; len += b; } while (b == 255); }
            len += 4;
            for (int i = 0; i < len; i++, d++) dst[d] = dst[d - offset]; // byte-wise: matches may overlap
        }
        return dst;
    }
}
