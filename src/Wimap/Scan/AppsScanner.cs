using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Wimap.Scan;

/// <summary>Installed desktop apps (registry), Store apps, Steam and Epic games, grouped by what they are.</summary>
public static class AppsScanner
{
    public sealed record App(string Name, string Kind)
    {
        public string? Version, Publisher, Location, IconSpec, Url, Date, IconKey;
        public long? EstimatedBytes;
    }

    // Order matters: the first group whose pattern matches wins.
    private static readonly (string group, Regex rx)[] Groups =
    {
        ("Runtimes and frameworks", R(@"redistributable|\bruntime\b|\.net |\.net$|directx|webview2|vcredist|visual c\+\+|\bjava\b|\bjdk\b|\bjre\b|framework|windows app sdk|windows sdk|desktop runtime|vs_|microsoft update health|windows software development")),
        ("AI and assistants", R(@"\bclaude\b|chatgpt|openai|\bcodex\b|\bgemini\b|\bgrok\b|copilot|perplexity|ollama|lm studio|\bjan\b|msty|anythingllm|superwhisper|wispr")),
        ("Browsers", R(@"\bchrome\b|firefox|\bedge\b|\bbrave\b|\bopera\b|vivaldi|\barc\b|tor browser|zen browser|chromium|librewolf|floorp|thorium|yandex")),
        ("Code and dev", R(@"visual studio|vs ?code|\bcursor\b|windsurf|\bgit\b|github|python|node\.?js|jetbrains|intellij|pycharm|webstorm|rider|android studio|docker|postman|insomnia|\bwsl\b|terminal|powershell|cmake|\bunity\b|unreal|sublime|notepad\+\+|heidisql|dbeaver|mysql|postgres|mongodb|filezilla|putty|winscp|\bkiro\b|\bzed\b|anaconda|miniconda|\brust\b|golang|\bgo programming")),
        ("Games and launchers", R(@"\bsteam\b|epic games|riot|valorant|league of legends|battle\.net|ubisoft|\bea app\b|electronic arts|origin|\bgog\b|xbox|minecraft|\bgame\b|games|rockstar|roblox|fortnite|counter-strike|dota|genshin|hoyoplay|playnite|faceit|medal|overwolf|aimlab|bluestacks|ldplayer")),
        ("Design and creative", R(@"adobe|photoshop|illustrator|premiere|after effects|lightroom|blender|figma|davinci|\bobs\b|capcut|canva|krita|\bgimp\b|inkscape|affinity|audacity|fl studio|ableton|cinema 4d|maxon|autodesk|sketchup|clip studio|paint\.net|shotcut|kdenlive|handbrake|vegas|filmora|substance|zbrush|houdini|spline")),
        ("Music and video", R(@"\bvlc\b|spotify|netflix|itunes|potplayer|mpc-|media player|k-lite|plex|deezer|tidal|apple music|kodi|stremio|mpv|aimp|foobar|winamp|codec")),
        ("Chat and calls", R(@"discord|whatsapp|telegram|slack|\bzoom\b|teams|skype|signal|messenger|viber|element|thunderbird|outlook|mailbird|anydesk|teamviewer|rustdesk|parsec")),
        ("Office and notes", R(@"microsoft 365|\boffice\b|\bword\b|excel|powerpoint|onenote|notion|obsidian|libreoffice|acrobat|pdf|evernote|todoist|logseq|wps|foxit|calibre|anki|grammarly|xmind|miro")),
        ("Files, cloud and downloads", R(@"onedrive|dropbox|google drive|7-zip|winrar|\bmega\b|icloud|internet download manager|\bidm\b|qbittorrent|utorrent|bittorrent|everything|teracopy|free download manager|jdownloader|nanazip|peazip|bandizip|syncthing|veeam|macrium|acronis")),
        ("Security and privacy", R(@"\bvpn\b|antivirus|defender|malwarebytes|avast|\bavg\b|kaspersky|bitdefender|nordpass|nordvpn|1password|bitwarden|norton|proton|mcafee|eset|keepass|dashlane|windscribe|surfshark|expressvpn|cloudflare warp|glasswire|simplewall")),
        ("Drivers and hardware", R(@"nvidia|\bamd\b|radeon|\bintel\b|realtek|\basus\b|armoury|logitech|razer|corsair|\bmsi\b|steelseries|driver|chipset|bluetooth|synaptics|\belan\b|dolby|\bhp\b|lenovo|\bdell\b|thunderbolt|\bacer\b|gigabyte|hyperx|wacom|epson|canon|brother|samsung|qualcomm|mediatek|killer|dts|nahimic|sonic studio|aura|g hub|icue|myasus|glidex|rog ")),
        ("Tools and utilities", R(@"powertoys|sharex|greenshot|lightshot|flux|ccleaner|revo|geek uninstaller|wiztree|treesize|cpu-z|gpu-z|hwinfo|hwmonitor|crystal|rufus|ventoy|balena|autohotkey|ditto|wox|flow launcher|raycast|keypirinha|eartrumpet|translucenttb|rainmeter|wallpaper engine|lively|f\.lux|nexus|startallback|open-shell|explorerpatcher|winaero|o&o|bulk rename|files app|directory opus|total commander")),
    };

    private static Regex R(string p) => new(p, RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Groups where the publisher alone is a reliable signal (an NVIDIA app is a driver tool whatever it is called).
    private static readonly HashSet<string> PublisherGroups = new() { "Drivers and hardware", "Games and launchers", "Runtimes and frameworks" };

    public static string GroupOf(string name, string? publisher)
    {
        foreach (var (group, rx) in Groups)
        {
            if (rx.IsMatch(name)) return group;
            if (publisher != null && PublisherGroups.Contains(group) && rx.IsMatch(publisher)) return group;
        }
        return "Other apps";
    }

    public static List<App> ReadAll(IconStore icons, CancellationToken ct)
    {
        var apps = new List<App>();
        apps.AddRange(ReadRegistry());
        apps.AddRange(ReadSteam());
        apps.AddRange(ReadEpic());
        apps.AddRange(ReadStore(icons));

        // De-duplicate by name: the same app is often registered under HKLM and HKCU, or by Steam and the registry.
        var merged = apps
            // Only architecture and install-scope suffixes are ignored; "Python 3.11" and "Python 3.12" stay two apps.
            .GroupBy(a => Regex.Replace(a.Name.ToLowerInvariant(), @"\s*\((x64|x86|arm64|64-bit|32-bit|user|machine|per-user|all users)\)\s*", " ").Trim())
            .Select(g => g.OrderByDescending(a => a.Location != null).ThenByDescending(a => a.IconSpec != null).First())
            .ToList();

        Parallel.ForEach(merged, new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = ct }, a =>
        {
            if (a.IconKey != null) return;
            a.IconKey = Icons.FromDisplayIcon(icons, a.IconSpec);
            if (a.IconKey == null && a.Location != null && Directory.Exists(a.Location))
            {
                var exe = SafeFiles(a.Location, "*.exe").OrderByDescending(f => Similarity(f, a.Name)).FirstOrDefault();
                if (exe != null) a.IconKey = Icons.FromFile(icons, exe);
            }
        });
        return merged;
    }

    private static int Similarity(string exePath, string appName)
    {
        var f = Path.GetFileNameWithoutExtension(exePath).ToLowerInvariant();
        if (f.Contains("unins") || f.Contains("update") || f.Contains("crash") || f.Contains("helper")) return -10;
        var words = appName.ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        return words.Count(w => w.Length > 2 && f.Contains(w)) * 3 - f.Length / 10;
    }

    private static IEnumerable<string> SafeFiles(string dir, string pattern)
    {
        try { return Directory.EnumerateFiles(dir, pattern, new EnumerationOptions { IgnoreInaccessible = true }).ToList(); }
        catch { return Array.Empty<string>(); }
    }

    private static IEnumerable<App> ReadRegistry()
    {
        var roots = new (RegistryKey hive, string path)[]
        {
            (Registry.LocalMachine, @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
            (Registry.LocalMachine, @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
            (Registry.CurrentUser, @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        };
        foreach (var (hive, path) in roots)
        {
            using var key = hive.OpenSubKey(path);
            if (key == null) continue;
            foreach (var sub in key.GetSubKeyNames())
            {
                using var k = key.OpenSubKey(sub);
                if (k == null) continue;
                var name = (k.GetValue("DisplayName") as string)?.Trim();
                if (string.IsNullOrEmpty(name)) continue;
                if (k.GetValue("SystemComponent") is int sc && sc == 1) continue;
                if (k.GetValue("ParentKeyName") != null) continue;
                var rt = k.GetValue("ReleaseType") as string;
                if (rt is "Update" or "Hotfix" or "Security Update") continue;
                if (Regex.IsMatch(name, @"^(KB\d+|Update for|Security Update)")) continue;

                var app = new App(name, "app")
                {
                    Version = k.GetValue("DisplayVersion") as string,
                    Publisher = (k.GetValue("Publisher") as string)?.Trim(),
                    IconSpec = k.GetValue("DisplayIcon") as string,
                    Url = Url(k.GetValue("URLInfoAbout") as string) ?? Url(k.GetValue("HelpLink") as string) ?? Url(k.GetValue("URLUpdateInfo") as string),
                    Date = FormatDate(k.GetValue("InstallDate") as string),
                };
                if (k.GetValue("EstimatedSize") is int kb && kb > 0) app.EstimatedBytes = kb * 1024L;
                app.Location = CleanDir(k.GetValue("InstallLocation") as string)
                               ?? DirOf(app.IconSpec)
                               ?? DirOf(k.GetValue("UninstallString") as string);
                yield return app;
            }
        }
    }

    private static string? Url(string? s) =>
        s != null && (s.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || s.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) ? s.Trim() : null;

    private static string? FormatDate(string? yyyymmdd) =>
        yyyymmdd is { Length: 8 } && DateTime.TryParseExact(yyyymmdd, "yyyyMMdd", null, System.Globalization.DateTimeStyles.None, out var d)
            ? d.ToString("yyyy-MM-dd") : null;

    private static string? CleanDir(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = Environment.ExpandEnvironmentVariables(s.Trim().Trim('"')).TrimEnd('\\');
        return Directory.Exists(s) && !IsSystemDir(s) ? s : null;
    }

    /// <summary>Folder of the exe in an icon or uninstall command, unless it points into Windows itself.</summary>
    private static string? DirOf(string? cmd)
    {
        if (string.IsNullOrWhiteSpace(cmd)) return null;
        var s = Environment.ExpandEnvironmentVariables(cmd.Trim());
        string exe;
        if (s.StartsWith('"')) { var end = s.IndexOf('"', 1); exe = end > 0 ? s[1..end] : s.Trim('"'); }
        else
        {
            var m = Regex.Match(s, @"^(.+?\.(exe|ico|dll))", RegexOptions.IgnoreCase);
            exe = m.Success ? m.Groups[1].Value : s.Split(',')[0];
        }
        try
        {
            var dir = Path.GetDirectoryName(exe);
            if (dir == null || !Directory.Exists(dir) || IsSystemDir(dir)) return null;
            // Uninstallers often live in a subfolder; climb out of obvious ones.
            var leaf = Path.GetFileName(dir).ToLowerInvariant();
            if (leaf is "uninstall" or "uninst" or "_uninstaller" or "uninstaller") dir = Path.GetDirectoryName(dir);
            return dir;
        }
        catch { return null; }
    }

    private static bool IsSystemDir(string dir)
    {
        var win = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var pd = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        dir = dir.TrimEnd('\\');
        return dir.StartsWith(win, StringComparison.OrdinalIgnoreCase)
               || dir.Equals(pd, StringComparison.OrdinalIgnoreCase)
               || dir.Contains(@"\Package Cache\", StringComparison.OrdinalIgnoreCase)
               || dir.EndsWith(@"\Package Cache", StringComparison.OrdinalIgnoreCase)
               || dir.Length <= 3
               || dir.Equals(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), StringComparison.OrdinalIgnoreCase)
               || dir.Equals(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), StringComparison.OrdinalIgnoreCase);
    }

    private static IEnumerable<App> ReadSteam()
    {
        var steam = Registry.GetValue(@"HKEY_CURRENT_USER\Software\Valve\Steam", "SteamPath", null) as string;
        if (steam == null) yield break;
        steam = steam.Replace('/', '\\');
        var vdf = Path.Combine(steam, "steamapps", "libraryfolders.vdf");
        var libs = new List<string> { steam };
        if (File.Exists(vdf))
            foreach (Match m in Regex.Matches(File.ReadAllText(vdf), "\"path\"\\s+\"([^\"]+)\""))
                libs.Add(m.Groups[1].Value.Replace(@"\\", @"\"));
        foreach (var lib in libs.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var apps = Path.Combine(lib, "steamapps");
            if (!Directory.Exists(apps)) continue;
            foreach (var acf in SafeFiles(apps, "appmanifest_*.acf"))
            {
                string text;
                try { text = File.ReadAllText(acf); } catch { continue; }
                string? V(string key) { var m = Regex.Match(text, $"\"{key}\"\\s+\"([^\"]*)\"", RegexOptions.IgnoreCase); return m.Success ? m.Groups[1].Value : null; }
                var name = V("name");
                if (name == null || name.StartsWith("Steamworks", StringComparison.OrdinalIgnoreCase) || name.Contains("Redistributable")) continue;
                var dir = Path.Combine(apps, "common", V("installdir") ?? name);
                var app = new App(name, "game")
                {
                    Publisher = "Steam",
                    Location = Directory.Exists(dir) ? dir : null,
                    Url = V("appid") is { } id ? $"https://store.steampowered.com/app/{id}" : null,
                };
                if (long.TryParse(V("SizeOnDisk"), out var sz) && sz > 0) app.EstimatedBytes = sz;
                yield return app;
            }
        }
    }

    private static IEnumerable<App> ReadEpic()
    {
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), @"Epic\EpicGamesLauncher\Data\Manifests");
        foreach (var item in SafeFiles(dir, "*.item"))
        {
            App? app = null;
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(item));
                var r = doc.RootElement;
                var name = r.TryGetProperty("DisplayName", out var n) ? n.GetString() : null;
                if (name != null)
                {
                    app = new App(name, "game") { Publisher = "Epic Games", Location = r.TryGetProperty("InstallLocation", out var l) ? l.GetString() : null };
                    if (r.TryGetProperty("InstallSize", out var s) && s.TryGetInt64(out var sz)) app.EstimatedBytes = sz;
                    if (r.TryGetProperty("LaunchExecutable", out var le) && app.Location != null) app.IconSpec = Path.Combine(app.Location, le.GetString() ?? "");
                }
            }
            catch { }
            if (app != null) yield return app;
        }
    }

    private static IEnumerable<App> ReadStore(IconStore icons)
    {
        var list = new List<App>();
        try
        {
            var pm = new Windows.Management.Deployment.PackageManager();
            foreach (var p in pm.FindPackagesForUser(""))
            {
                try
                {
                    if (p.IsFramework || p.IsResourcePackage || p.IsBundle) continue;
                    if (p.SignatureKind == Windows.ApplicationModel.PackageSignatureKind.System) continue;
                    var name = p.DisplayName;
                    if (string.IsNullOrWhiteSpace(name) || name.StartsWith("ms-resource", StringComparison.OrdinalIgnoreCase)) continue;
                    var v = p.Id.Version;
                    var app = new App(name, "store")
                    {
                        Publisher = p.PublisherDisplayName,
                        Version = $"{v.Major}.{v.Minor}.{v.Build}.{v.Revision}",
                        Date = p.InstalledDate.Year > 2000 ? p.InstalledDate.ToString("yyyy-MM-dd") : null,
                        Url = $"https://apps.microsoft.com/search?query={Uri.EscapeDataString(name)}",
                    };
                    try { app.Location = p.InstalledLocation?.Path; } catch { }
                    try { app.IconKey = StoreLogo(icons, p.Logo?.LocalPath); } catch { }
                    list.Add(app);
                }
                catch { }
            }
        }
        catch { /* PackageManager unavailable */ }
        return list;
    }

    /// <summary>Package logos are stored with scale qualifiers (Logo.scale-200.png), so match by prefix.</summary>
    private static string? StoreLogo(IconStore icons, string? logo)
    {
        if (logo == null) return null;
        if (File.Exists(logo)) return Icons.FromFile(icons, logo);
        var dir = Path.GetDirectoryName(logo);
        var stem = Path.GetFileNameWithoutExtension(logo);
        if (dir == null || !Directory.Exists(dir)) return null;
        var pick = SafeFiles(dir, stem + "*.png")
            .OrderBy(f => f.Contains("contrast", StringComparison.OrdinalIgnoreCase) ? 1 : 0)
            .ThenByDescending(f => f.Contains("scale-100") || f.Contains("targetsize-32"))
            .FirstOrDefault();
        return pick != null ? Icons.FromFile(icons, pick) : null;
    }

    /// <summary>Build the Apps branch. Folder trees are walked in parallel.</summary>
    public static Node Build(List<App> apps, ScanOptions opt, Progress progress, CancellationToken ct)
    {
        var cat = new Node("Apps", "cat") { CatKey = "apps" };
        var nodes = new Node[apps.Count];
        Parallel.For(0, apps.Count, new ParallelOptions { MaxDegreeOfParallelism = 6, CancellationToken = ct }, i =>
        {
            var a = apps[i];
            Node n;
            bool canWalk = a.Location != null && a.Kind != "store" && Directory.Exists(a.Location);
            if (canWalk)
            {
                var walker = new FolderWalker(progress, ct) { MaxFolders = 24, ExeOnly = true, Budget = 250_000 };
                try { n = walker.Walk(a.Location!, opt.Depth, a.Name, a.Kind); }
                catch (OperationCanceledException) { throw; }
                catch { n = new Node(a.Name, a.Kind) { Path = a.Location }; }
            }
            else n = new Node(a.Name, a.Kind) { Path = a.Location, Size = a.EstimatedBytes };
            if ((n.Size ?? 0) == 0 && a.EstimatedBytes != null) n.Size = a.EstimatedBytes;
            n.Version = a.Version; n.By = a.Publisher; n.Url = a.Url; n.Date = a.Date; n.Icon = a.IconKey;
            nodes[i] = n;
        });

        foreach (var g in nodes.GroupBy(n => n.Kind == "game" ? "Games and launchers" : GroupOf(n.Name, n.By)).OrderBy(g => g.Key == "Other apps" ? 1 : 0).ThenBy(g => g.Key))
        {
            var group = new Node(g.Key, "group");
            group.AddRange(g.OrderBy(n => n.Name, StringComparer.OrdinalIgnoreCase));
            group.Size = group.Children!.Sum(c => c.Size ?? 0);
            cat.Add(group);
        }
        cat.Size = cat.Children?.Sum(c => c.Size ?? 0);
        return cat;
    }
}
