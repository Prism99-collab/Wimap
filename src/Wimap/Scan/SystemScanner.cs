using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Wimap.Scan;

/// <summary>Dev kit (runtimes, global packages, editor extensions, WSL) and system bits worth carrying over (startup items, fonts).</summary>
public static class SystemScanner
{
    private static readonly string Home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    private static readonly string Roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
    private static readonly string Local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

    public static Node Dev(IconStore icons)
    {
        var cat = new Node("Dev kit", "cat") { CatKey = "dev" };

        var rt = new Node("Runtimes on PATH", "group");
        var tools = new (string label, string[] exes, string url)[]
        {
            ("Node.js", new[] { "node.exe" }, "https://nodejs.org"),
            ("Python", new[] { "python.exe", "py.exe" }, "https://python.org"),
            ("Git", new[] { "git.exe" }, "https://git-scm.com"),
            (".NET", new[] { "dotnet.exe" }, "https://dot.net"),
            ("Java", new[] { "java.exe" }, "https://adoptium.net"),
            ("Go", new[] { "go.exe" }, "https://go.dev"),
            ("Rust", new[] { "rustc.exe", "cargo.exe" }, "https://rustup.rs"),
            ("Bun", new[] { "bun.exe" }, "https://bun.sh"),
            ("Deno", new[] { "deno.exe" }, "https://deno.com"),
            ("PHP", new[] { "php.exe" }, "https://php.net"),
            ("Ruby", new[] { "ruby.exe" }, "https://ruby-lang.org"),
            ("Docker", new[] { "docker.exe" }, "https://docker.com"),
            ("PowerShell 7", new[] { "pwsh.exe" }, "https://aka.ms/powershell"),
            ("GitHub CLI", new[] { "gh.exe" }, "https://cli.github.com"),
            ("winget", new[] { "winget.exe" }, "https://aka.ms/winget"),
            ("ffmpeg", new[] { "ffmpeg.exe" }, "https://ffmpeg.org"),
            ("uv", new[] { "uv.exe" }, "https://docs.astral.sh/uv"),
            ("pnpm", new[] { "pnpm.exe", "pnpm.cmd" }, "https://pnpm.io"),
            ("Yarn", new[] { "yarn.cmd" }, "https://yarnpkg.com"),
        };
        var pathDirs = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries)
            .Select(p => Environment.ExpandEnvironmentVariables(p.Trim().Trim('"'))).Where(p => p.Length > 2).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        foreach (var t in tools)
        {
            var hit = t.exes.SelectMany(e => pathDirs.Select(d => Path.Combine(d, e))).FirstOrDefault(File.Exists);
            if (hit == null) continue;
            string? ver = null;
            try { var fv = FileVersionInfo.GetVersionInfo(hit); ver = fv.ProductVersion?.Split('+', ' ')[0]; } catch { }
            rt.Add(new Node(t.label, "runtime") { Path = hit, Version = string.IsNullOrWhiteSpace(ver) ? null : ver, Url = t.url, Icon = hit.EndsWith(".exe") ? Icons.FromFile(icons, hit) : null });
        }
        cat.Add(rt.NullIfEmpty());

        cat.Add(NpmGlobals());
        foreach (var (label, dir) in new[] { ("VS Code extensions", Path.Combine(Home, ".vscode", "extensions")), ("Cursor extensions", Path.Combine(Home, ".cursor", "extensions")), ("Windsurf extensions", Path.Combine(Home, ".windsurf", "extensions")), ("VSCodium extensions", Path.Combine(Home, ".vscode-oss", "extensions")) })
            cat.Add(EditorExtensions(label, dir, icons));
        cat.Add(Wsl());
        return cat;
    }

    private static Node? NpmGlobals()
    {
        var dir = Path.Combine(Roaming, "npm", "node_modules");
        if (!Directory.Exists(dir)) return null;
        var g = new Node("Global npm packages", "group") { Path = dir };
        foreach (var d in AiScanner.SafeDirs(dir))
        {
            var name = Path.GetFileName(d);
            if (name.StartsWith('.')) continue;
            var pkgs = name.StartsWith('@') ? AiScanner.SafeDirs(d).ToList() : new List<string> { d };
            foreach (var p in pkgs)
            {
                var (n, desc, ver) = AiScanner.Manifest(Path.Combine(p, "package.json"), "name", "name");
                n ??= name.StartsWith('@') ? $"{name}/{Path.GetFileName(p)}" : name;
                g.Add(new Node(n, "pkg") { Path = p, Version = ver, Detail = desc, Url = "https://www.npmjs.com/package/" + n });
            }
        }
        return g.NullIfEmpty();
    }

    private static Node? EditorExtensions(string label, string dir, IconStore icons)
    {
        if (!Directory.Exists(dir)) return null;
        var g = new Node(label, "group") { Path = dir };
        foreach (var d in AiScanner.SafeDirs(dir))
        {
            var pj = Path.Combine(d, "package.json");
            if (!File.Exists(pj)) continue;
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(pj));
                var r = doc.RootElement;
                string? S(string k) => r.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
                var id = $"{S("publisher")}.{S("name")}";
                var display = S("displayName");
                if (display == null || display.StartsWith('%')) display = S("name") ?? id;
                var n = new Node(display, "vsx") { Path = d, Version = S("version"), Detail = id, Url = $"https://marketplace.visualstudio.com/items?itemName={id}" };
                if (S("icon") is { } icon) n.Icon = Icons.FromFile(icons, Path.Combine(d, icon.Replace('/', '\\')));
                g.Add(n);
            }
            catch { }
        }
        // Several versions of one extension can sit side by side; keep one row per id.
        if (g.Children != null) g.Children = g.Children.GroupBy(c => c.Detail).Select(x => x.OrderByDescending(c => Version.TryParse(c.Version, out var v) ? v : new Version()).First()).OrderBy(c => c.Name, StringComparer.OrdinalIgnoreCase).ToList();
        return g.NullIfEmpty();
    }

    private static Node? Wsl()
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Lxss");
        if (key == null) return null;
        var g = new Node("WSL distros", "group");
        foreach (var sub in key.GetSubKeyNames())
        {
            using var k = key.OpenSubKey(sub);
            var name = k?.GetValue("DistributionName") as string;
            if (name == null) continue;
            var path = k!.GetValue("BasePath") as string;
            if (path != null && path.StartsWith(@"\\?\")) path = path[4..];
            long? size = null;
            try { var vhd = Path.Combine(path ?? "", "ext4.vhdx"); if (File.Exists(vhd)) size = new FileInfo(vhd).Length; } catch { }
            g.Add(new Node(name, "wsl") { Path = path, Size = size });
        }
        return g.NullIfEmpty();
    }

    public static Node SystemBits(IconStore icons)
    {
        var cat = new Node("System", "cat") { CatKey = "system" };

        var su = new Node("Starts with Windows", "group");
        foreach (var (hive, label) in new[] { (Registry.CurrentUser, "you"), (Registry.LocalMachine, "all users") })
            foreach (var path in new[] { @"Software\Microsoft\Windows\CurrentVersion\Run", @"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run" })
            {
                using var k = hive.OpenSubKey(path);
                if (k == null) continue;
                foreach (var name in k.GetValueNames())
                {
                    var cmd = k.GetValue(name) as string;
                    if (string.IsNullOrWhiteSpace(name)) continue;
                    var exe = ExeOf(cmd);
                    su.Add(new Node(name, "startup") { Path = exe, Detail = "for " + label, Icon = Icons.FromFile(icons, exe) });
                }
            }
        foreach (var dir in new[] { Environment.GetFolderPath(Environment.SpecialFolder.Startup), Environment.GetFolderPath(Environment.SpecialFolder.CommonStartup) })
            foreach (var f in AiScanner.SafeFilesIn(dir).Where(f => !f.EndsWith("desktop.ini", StringComparison.OrdinalIgnoreCase)))
                su.Add(new Node(Path.GetFileNameWithoutExtension(f), "startup") { Path = f, Detail = "Startup folder" });
        if (su.Children != null) su.Children = su.Children.DistinctBy(c => c.Name.ToLowerInvariant()).OrderBy(c => c.Name).ToList();
        cat.Add(su.NullIfEmpty());

        // Fonts the user installed themselves: these are the ones lost on a new PC.
        var fonts = new Node("Fonts you installed", "group");
        var fontDir = Path.Combine(Local, @"Microsoft\Windows\Fonts");
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using (var fk = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows NT\CurrentVersion\Fonts"))
            if (fk != null)
                foreach (var name in fk.GetValueNames())
                {
                    var file = fk.GetValue(name) as string;
                    // Per-user font entries are usually full paths; bare names live in the Windows Fonts folder.
                    if (!string.IsNullOrEmpty(file) && !Path.IsPathRooted(file)) file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Fonts), file);
                    var clean = Regex.Replace(name, @"\s*\((TrueType|OpenType)\)$", "");
                    if (seen.Add(clean)) fonts.Add(new Node(clean, "font") { Path = file, Size = File.Exists(file) ? new FileInfo(file!).Length : null });
                }
        var listed = new HashSet<string>(fonts.Children?.Select(c => c.Path ?? "") ?? Enumerable.Empty<string>(), StringComparer.OrdinalIgnoreCase);
        foreach (var f in AiScanner.SafeFilesIn(fontDir))
            if (!listed.Contains(f) && seen.Add(Path.GetFileNameWithoutExtension(f)))
                fonts.Add(new Node(Path.GetFileNameWithoutExtension(f), "font") { Path = f, Size = new FileInfo(f).Length });
        fonts.SortChildren();
        cat.Add(fonts.NullIfEmpty());
        return cat;
    }

    private static string? ExeOf(string? cmd)
    {
        if (string.IsNullOrWhiteSpace(cmd)) return null;
        cmd = Environment.ExpandEnvironmentVariables(cmd.Trim());
        if (cmd.StartsWith('"')) { var e = cmd.IndexOf('"', 1); return e > 0 ? cmd[1..e] : null; }
        var m = Regex.Match(cmd, @"^(.+?\.exe)", RegexOptions.IgnoreCase);
        return m.Success ? m.Groups[1].Value : cmd.Split(' ')[0];
    }

    public static string OsName()
    {
        try
        {
            using var k = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
            var product = k?.GetValue("ProductName") as string ?? "Windows";
            var build = k?.GetValue("CurrentBuildNumber") as string;
            var display = k?.GetValue("DisplayVersion") as string;
            // ProductName still says "Windows 10" on Windows 11 builds.
            if (int.TryParse(build, out var b) && b >= 22000) product = product.Replace("Windows 10", "Windows 11");
            return $"{product} {display} · build {build}".Trim();
        }
        catch { return Environment.OSVersion.VersionString; }
    }
}
