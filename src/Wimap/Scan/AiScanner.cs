using System.Text.Json;
using System.Text.RegularExpressions;

namespace Wimap.Scan;

/// <summary>
/// AI tools: MCP servers, plugins, skills, agents, commands, memory files and known projects.
/// Only names and safe descriptors are read. Env values, headers, tokens and auth files are never touched.
/// </summary>
public static class AiScanner
{
    private static readonly string Home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    private static readonly string Roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
    private static readonly string Local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

    private static string H(params string[] parts) => Path.Combine(new[] { Home }.Concat(parts).ToArray());

    public static Node Build(List<AppsScanner.App> apps, IconStore icons)
    {
        var cat = new Node("AI", "cat") { CatKey = "ai" };
        void Tool(Node? n) { if (n != null) cat.Add(n); }

        Tool(ClaudeCode());
        Tool(ClaudeDesktop());
        Tool(Codex());
        Tool(Gemini());
        Tool(Simple("Cursor", H(".cursor"), mcp: new[] { (H(".cursor", "mcp.json"), "mcpServers") },
            skills: new[] { H(".cursor", "skills"), H(".cursor", "skills-cursor") }, pluginsDir: H(".cursor", "plugins", "local")));
        Tool(Simple("GitHub Copilot CLI", H(".copilot"), mcp: new[] { (H(".copilot", "mcp-config.json"), "mcpServers") }, skills: new[] { H(".copilot", "skills") }));
        Tool(Simple("Windsurf", H(".codeium", "windsurf"), mcp: new[] { (H(".codeium", "windsurf", "mcp_config.json"), "mcpServers") }, skills: new[] { H(".codeium", "windsurf", "skills") }));
        Tool(Simple("VS Code (MCP)", Path.Combine(Roaming, "Code", "User", "mcp.json"), mcp: new[] { (Path.Combine(Roaming, "Code", "User", "mcp.json"), "servers") }));
        Tool(Simple("Cline", Path.Combine(Roaming, "Code", "User", "globalStorage", "saoudrizwan.claude-dev"),
            mcp: new[] { (Path.Combine(Roaming, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"), "mcpServers") }));
        Tool(Simple("Kiro", H(".kiro"), mcp: new[] { (H(".kiro", "settings", "mcp.json"), "mcpServers") }, skills: new[] { H(".kiro", "skills") }));
        Tool(Simple("Qwen Code", H(".qwen"), mcp: new[] { (H(".qwen", "settings.json"), "mcpServers") }));
        Tool(Simple("opencode", H(".config", "opencode"), mcp: new[] { (H(".config", "opencode", "opencode.json"), "mcp") }));
        Tool(Simple("Continue", H(".continue"), mcp: new[] { (H(".continue", "config.json"), "mcpServers") }));
        Tool(Ollama());
        Tool(LmStudio());

        // Desktop AI apps found in the app scan (ChatGPT, Grok, Perplexity...), unless already covered above.
        var covered = new HashSet<string>(cat.Children?.Select(c => c.Name) ?? Enumerable.Empty<string>(), StringComparer.OrdinalIgnoreCase);
        var aiApps = apps.Where(a => AppsScanner.GroupOf(a.Name, a.Publisher) == "AI and assistants" && !covered.Contains(a.Name)).ToList();
        if (aiApps.Count > 0)
        {
            var g = new Node("Desktop AI apps", "group");
            foreach (var a in aiApps.OrderBy(a => a.Name))
                g.Add(new Node(a.Name, a.Kind) { Version = a.Version, By = a.Publisher, Path = a.Location, Icon = a.IconKey, Url = a.Url });
            cat.Add(g);
        }
        return cat;
    }

    private static Node? ClaudeCode()
    {
        var dir = H(".claude");
        if (!Directory.Exists(dir)) return null;
        var tool = new Node("Claude Code", "ai") { Path = dir, Url = "https://claude.com/claude-code", Detail = "Anthropic's coding agent for the terminal and desktop" };
        var cfg = H(".claude.json");

        var mcp = new Node("MCP servers", "group");
        mcp.AddRange(Mcp(cfg, "mcpServers"));
        mcp.AddRange(Mcp(Path.Combine(dir, "settings.json"), "mcpServers"));
        tool.Add(mcp.NullIfEmpty() ?? new Node("No MCP servers", "more"));

        var plugins = new Node("Plugins", "group");
        var installed = Path.Combine(dir, "plugins", "installed_plugins.json");
        foreach (var (id, path, version) in ClaudePlugins(installed))
        {
            var p = new Node(id.Split('@')[0], "plugin") { Path = path, Version = version, Detail = id.Contains('@') ? "from " + id.Split('@')[1] : null };
            p.Detail = PluginDescription(path) ?? p.Detail;
            PluginContents(p, path);
            plugins.Add(p);
        }
        tool.Add(plugins.NullIfEmpty());

        tool.Add(Skills("Skills", Path.Combine(dir, "skills")));
        tool.Add(MdItems("Agents", Path.Combine(dir, "agents"), "agent"));
        tool.Add(MdItems("Commands", Path.Combine(dir, "commands"), "cmd"));
        tool.Add(Docs(Path.Combine(dir, "CLAUDE.md")));
        tool.Add(Projects(JsonKeys(cfg, "projects")));
        return tool;
    }

    private static Node? ClaudeDesktop()
    {
        var cfgs = new List<string> { Path.Combine(Roaming, "Claude", "claude_desktop_config.json") };
        try
        {
            foreach (var pkg in Directory.EnumerateDirectories(Path.Combine(Local, "Packages"), "Claude_*"))
                cfgs.Add(Path.Combine(pkg, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
        }
        catch { }
        var existing = cfgs.Where(File.Exists).ToList();
        if (existing.Count == 0 && !Directory.Exists(Path.Combine(Roaming, "Claude"))) return null;

        var tool = new Node("Claude desktop", "ai") { Path = Path.Combine(Roaming, "Claude"), Url = "https://claude.ai/download" };
        var mcp = new Node("MCP servers", "group");
        foreach (var c in existing) mcp.AddRange(Mcp(c, "mcpServers"));
        Dedupe(mcp);
        tool.Add(mcp.NullIfEmpty() ?? new Node("No MCP servers", "more"));

        var extDir = Path.Combine(Roaming, "Claude", "Claude Extensions");
        if (Directory.Exists(extDir))
        {
            var ex = new Node("Extensions", "group");
            foreach (var d in SafeDirs(extDir))
            {
                var (name, desc, ver) = Manifest(Path.Combine(d, "manifest.json"), "display_name", "name");
                ex.Add(new Node(name ?? Path.GetFileName(d), "plugin") { Path = d, Detail = desc, Version = ver });
            }
            tool.Add(ex.NullIfEmpty());
        }
        return tool;
    }

    private static Node? Codex()
    {
        var dir = H(".codex");
        if (!Directory.Exists(dir)) return null;
        var tool = new Node("Codex", "ai") { Path = dir, Url = "https://openai.com/codex", Detail = "OpenAI's coding agent" };
        var toml = Path.Combine(dir, "config.toml");
        var sections = TomlSections(toml);

        var mcp = new Node("MCP servers", "group");
        foreach (var (name, body) in sections.Where(s => s.name.StartsWith("mcp_servers.")))
        {
            var id = Unquote(name["mcp_servers.".Length..]);
            if (id.Contains('.')) continue; // sub-tables like mcp_servers.x.env
            var cmd = Regex.Match(body, "^\\s*command\\s*=\\s*\"([^\"]+)\"", RegexOptions.Multiline);
            var url = Regex.Match(body, "^\\s*url\\s*=\\s*\"([^\"]+)\"", RegexOptions.Multiline);
            mcp.Add(new Node(id, "mcp") { Detail = cmd.Success ? Launcher(cmd.Groups[1].Value) : url.Success ? "remote · " + HostOf(url.Groups[1].Value) : null });
        }
        tool.Add(mcp.NullIfEmpty() ?? new Node("No MCP servers", "more"));

        var plugins = new Node("Plugins", "group");
        var cache = Path.Combine(dir, "plugins", "cache");
        foreach (var (name, body) in sections.Where(s => s.name.StartsWith("plugins.")))
        {
            var id = Unquote(name["plugins.".Length..]);
            var parts = id.Split('@');
            var p = new Node(parts[0], "plugin") { Detail = parts.Length > 1 ? "from " + parts[1] : null };
            if (Regex.IsMatch(body, @"enabled\s*=\s*false")) p.Detail = (p.Detail + " · off").Trim(' ', '·');
            var pdir = parts.Length > 1 ? Path.Combine(cache, parts[1], parts[0]) : null;
            if (pdir != null && Directory.Exists(pdir))
            {
                var ver = SafeDirs(pdir).OrderByDescending(Directory.GetLastWriteTimeUtc).FirstOrDefault() ?? pdir;
                p.Path = ver;
                PluginContents(p, ver);
            }
            plugins.Add(p);
        }
        tool.Add(plugins.NullIfEmpty());
        tool.Add(Skills("Skills", Path.Combine(dir, "skills")));
        tool.Add(Docs(Path.Combine(dir, "AGENTS.md")));
        tool.Add(Projects(sections.Where(s => s.name.StartsWith("projects.")).Select(s => Unquote(s.name["projects.".Length..]))));
        return tool;
    }

    private static Node? Gemini()
    {
        var dir = H(".gemini");
        if (!Directory.Exists(dir)) return null;
        var tool = new Node("Gemini CLI", "ai") { Path = dir, Url = "https://github.com/google-gemini/gemini-cli", Detail = "Google's agent for the terminal" };
        var mcp = new Node("MCP servers", "group");
        mcp.AddRange(Mcp(Path.Combine(dir, "settings.json"), "mcpServers"));
        tool.Add(mcp.NullIfEmpty() ?? new Node("No MCP servers", "more"));
        var extDir = Path.Combine(dir, "extensions");
        if (Directory.Exists(extDir))
        {
            var ex = new Node("Extensions", "group");
            foreach (var d in SafeDirs(extDir))
            {
                var (name, desc, ver) = Manifest(Path.Combine(d, "gemini-extension.json"), "name", "name");
                var e = new Node(name ?? Path.GetFileName(d), "plugin") { Path = d, Detail = desc, Version = ver };
                e.AddRange(Mcp(Path.Combine(d, "gemini-extension.json"), "mcpServers"));
                ex.Add(e);
            }
            tool.Add(ex.NullIfEmpty());
        }
        tool.Add(Skills("Skills", Path.Combine(dir, "skills")));
        tool.Add(Docs(Path.Combine(dir, "GEMINI.md")));
        if (Directory.Exists(Path.Combine(dir, "antigravity")))
            tool.Add(new Node("Antigravity", "ai") { Path = Path.Combine(dir, "antigravity"), Detail = "Google's agent IDE data" });
        return tool;
    }

    private static Node? Simple(string name, string marker, (string file, string key)[]? mcp = null, string[]? skills = null, string? pluginsDir = null)
    {
        if (!Directory.Exists(marker) && !File.Exists(marker)) return null;
        var tool = new Node(name, "ai") { Path = marker };
        if (mcp != null)
        {
            var g = new Node("MCP servers", "group");
            foreach (var (f, k) in mcp) g.AddRange(Mcp(f, k));
            tool.Add(g.NullIfEmpty() ?? new Node("No MCP servers", "more"));
        }
        if (pluginsDir != null && Directory.Exists(pluginsDir))
        {
            var g = new Node("Plugins", "group");
            foreach (var d in SafeDirs(pluginsDir)) { var p = new Node(Path.GetFileName(d), "plugin") { Path = d }; PluginContents(p, d); g.Add(p); }
            tool.Add(g.NullIfEmpty());
        }
        foreach (var s in skills ?? Array.Empty<string>())
            tool.Add(Skills(Path.GetFileName(s) == "skills" ? "Skills" : Path.GetFileName(s), s));
        return tool;
    }

    private static Node? Ollama()
    {
        var root = Environment.GetEnvironmentVariable("OLLAMA_MODELS") ?? H(".ollama", "models");
        var lib = Path.Combine(root, "manifests", "registry.ollama.ai");
        if (!Directory.Exists(lib)) return null;
        var tool = new Node("Ollama", "ai") { Path = root, Url = "https://ollama.com" };
        var g = new Node("Models", "group");
        foreach (var ns in SafeDirs(lib))
            foreach (var model in SafeDirs(ns))
                foreach (var tag in SafeFilesIn(model))
                {
                    var prefix = Path.GetFileName(ns) == "library" ? "" : Path.GetFileName(ns) + "/";
                    var n = new Node($"{prefix}{Path.GetFileName(model)}:{Path.GetFileName(tag)}", "model") { Url = "https://ollama.com/library/" + Path.GetFileName(model) };
                    try
                    {
                        using var doc = JsonDocument.Parse(File.ReadAllText(tag));
                        n.Size = doc.RootElement.GetProperty("layers").EnumerateArray().Sum(l => l.GetProperty("size").GetInt64());
                    }
                    catch { }
                    g.Add(n);
                }
        tool.Add(g.NullIfEmpty() ?? new Node("No models", "more"));
        return tool;
    }

    private static Node? LmStudio()
    {
        var root = new[] { H(".lmstudio", "models"), H(".cache", "lm-studio", "models") }.FirstOrDefault(Directory.Exists);
        if (root == null) return null;
        var tool = new Node("LM Studio", "ai") { Path = root, Url = "https://lmstudio.ai" };
        var g = new Node("Models", "group");
        foreach (var pub in SafeDirs(root))
            foreach (var model in SafeDirs(pub))
            {
                long size = 0;
                try { size = new DirectoryInfo(model).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length); } catch { }
                g.Add(new Node($"{Path.GetFileName(pub)}/{Path.GetFileName(model)}", "model") { Path = model, Size = size });
            }
        tool.Add(g.NullIfEmpty() ?? new Node("No models", "more"));
        return tool;
    }

    // ---------- shared readers ----------

    /// <summary>MCP servers from a JSON file. Records the name, plus the launcher or the remote host. Never env, headers or tokens.</summary>
    public static IEnumerable<Node> Mcp(string file, string key)
    {
        var list = new List<Node>();
        if (!File.Exists(file)) return list;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file), new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
            if (!doc.RootElement.TryGetProperty(key, out var servers) || servers.ValueKind != JsonValueKind.Object) return list;
            foreach (var s in servers.EnumerateObject())
                list.Add(new Node(s.Name, "mcp") { Detail = Describe(s.Value) });
        }
        catch { }
        return list;
    }

    private static readonly Regex Secretish = new(@"(sk-|key|token|secret|pat_|ghp_|gho_|xox|bearer|password|=)", RegexOptions.IgnoreCase);

    private static string? Describe(JsonElement s)
    {
        if (s.ValueKind != JsonValueKind.Object) return null;
        if (s.TryGetProperty("url", out var u) && u.ValueKind == JsonValueKind.String) return "remote · " + HostOf(u.GetString()!);
        if (s.TryGetProperty("serverUrl", out var su) && su.ValueKind == JsonValueKind.String) return "remote · " + HostOf(su.GetString()!);
        string? cmd = null;
        if (s.TryGetProperty("command", out var c))
            cmd = c.ValueKind == JsonValueKind.String ? c.GetString() : c.ValueKind == JsonValueKind.Array ? c.EnumerateArray().FirstOrDefault().ToString() : null;
        var launcher = Launcher(cmd);
        if (launcher == null) return null;
        // A package name in args tells the user what to reinstall; anything that smells like a secret is skipped.
        if (s.TryGetProperty("args", out var args) && args.ValueKind == JsonValueKind.Array)
        {
            var pkg = args.EnumerateArray().Where(a => a.ValueKind == JsonValueKind.String).Select(a => a.GetString()!).FirstOrDefault(IsPackageName);
            if (pkg != null) return $"{launcher} · {pkg}";
        }
        return launcher;
    }

    /// <summary>
    /// The program name from a command, never its arguments: "docker run -e TOKEN=x img" gives "docker".
    /// Returns null when even the program name looks like a secret.
    /// </summary>
    public static string? Launcher(string? command)
    {
        if (string.IsNullOrWhiteSpace(command)) return null;
        var c = command.Trim();
        string first;
        var exe = Regex.Match(c, @"^(.+?\.(exe|cmd|bat|ps1|py|js))(\s|$)", RegexOptions.IgnoreCase);
        if (c.StartsWith('"')) { var end = c.IndexOf('"', 1); first = end > 0 ? c[1..end] : c.Trim('"'); }
        else if (exe.Success) first = exe.Groups[1].Value; // "C:\Program Files\nodejs\node.exe" keeps its spaces
        else first = c.Split((char[]?)null, 2, StringSplitOptions.RemoveEmptyEntries)[0];
        var name = Path.GetFileNameWithoutExtension(first.Replace('/', '\\').TrimEnd('\\'));
        return name.Length == 0 || name.Length > 40 || Secretish.IsMatch(name) ? null : name;
    }

    /// <summary>An npm or PyPI style package name such as "@modelcontextprotocol/server-github" or "mcp-server-time", not a key or ID.</summary>
    public static bool IsPackageName(string a)
    {
        if (a.StartsWith('-') || a.Length > 60 || Secretish.IsMatch(a)) return false;
        if (!Regex.IsMatch(a, @"^@?[a-z0-9][\w.-]*(/[\w.-]+)?(@[\w.^~-]+)?$", RegexOptions.IgnoreCase)) return false;
        if (!(a.Contains('/') || a.Contains('-') || a.Contains('@'))) return false;
        // Keys and IDs: UUIDs, long hex or base64-like runs, or mostly digits.
        if (Regex.IsMatch(a, @"[0-9a-f]{8}-[0-9a-f]{4}-", RegexOptions.IgnoreCase)) return false;
        var name = a.Split('@', StringSplitOptions.RemoveEmptyEntries)[0];
        foreach (var part in name.Split('/', '-', '_', '.'))
            if (part.Length >= 16 && !Regex.IsMatch(part, "^[a-z]+$", RegexOptions.IgnoreCase)) return false;
        return name.Count(char.IsDigit) * 3 <= name.Length;
    }

    private static string HostOf(string url) => Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.Host : "remote";

    private static Node? Skills(string label, string dir)
    {
        if (!Directory.Exists(dir)) return null;
        var g = new Node(label, "group") { Path = dir };
        foreach (var d in SafeDirs(dir))
        {
            var md = Path.Combine(d, "SKILL.md");
            if (File.Exists(md)) g.Add(Skill(md, d));
            else if (Path.GetFileName(d).StartsWith('.')) // e.g. Codex keeps built-ins in .system
                foreach (var inner in SafeDirs(d).Where(x => File.Exists(Path.Combine(x, "SKILL.md"))))
                    g.Add(Skill(Path.Combine(inner, "SKILL.md"), inner, "built-in"));
        }
        g.SortChildren();
        return g.NullIfEmpty();
    }

    private static Node Skill(string md, string dir, string? tag = null)
    {
        var (name, desc) = FrontMatter(md);
        return new Node(name ?? Path.GetFileName(dir), "skill") { Path = dir, Detail = tag != null && desc != null ? $"{tag} · {desc}" : desc ?? tag };
    }

    private static Node? MdItems(string label, string dir, string kind)
    {
        if (!Directory.Exists(dir)) return null;
        var g = new Node(label, "group") { Path = dir };
        foreach (var f in SafeFilesIn(dir).Where(f => f.EndsWith(".md", StringComparison.OrdinalIgnoreCase)))
        {
            var (name, desc) = FrontMatter(f);
            g.Add(new Node(name ?? Path.GetFileNameWithoutExtension(f), kind) { Path = f, Detail = desc });
        }
        return g.NullIfEmpty();
    }

    /// <summary>Skills, agents, commands and bundled MCP servers inside one plugin folder.</summary>
    private static void PluginContents(Node p, string dir)
    {
        if (!Directory.Exists(dir)) return;
        var skillRoots = new[] { Path.Combine(dir, "skills"), Path.Combine(dir, ".claude", "skills") };
        foreach (var sr in skillRoots.Where(Directory.Exists))
            foreach (var d in SafeDirs(sr).Where(d => File.Exists(Path.Combine(d, "SKILL.md"))))
                p.Add(Skill(Path.Combine(d, "SKILL.md"), d));
        foreach (var (sub, kind) in new[] { ("agents", "agent"), ("commands", "cmd") })
        {
            var d = Path.Combine(dir, sub);
            foreach (var f in SafeFilesIn(d).Where(f => f.EndsWith(".md", StringComparison.OrdinalIgnoreCase)))
            {
                var (name, desc) = FrontMatter(f);
                p.Add(new Node(name ?? Path.GetFileNameWithoutExtension(f), kind) { Path = f, Detail = desc });
            }
        }
        p.AddRange(Mcp(Path.Combine(dir, ".mcp.json"), "mcpServers"));
    }

    private static string? PluginDescription(string dir)
    {
        foreach (var f in new[] { Path.Combine(dir, ".claude-plugin", "plugin.json"), Path.Combine(dir, ".codex-plugin", "plugin.json"), Path.Combine(dir, "plugin.json") })
        {
            var (_, desc, _) = Manifest(f, "name", "name");
            if (desc != null) return desc;
        }
        return null;
    }

    private static IEnumerable<(string id, string path, string? version)> ClaudePlugins(string file)
    {
        var list = new List<(string, string, string?)>();
        if (!File.Exists(file)) return list;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file));
            if (!doc.RootElement.TryGetProperty("plugins", out var plugins)) return list;
            foreach (var p in plugins.EnumerateObject())
            {
                // Several installs may exist (user and project scope); prefer the user-scope, newest one.
                var entries = p.Value.ValueKind == JsonValueKind.Array ? p.Value.EnumerateArray().ToList() : new List<JsonElement> { p.Value };
                var e = entries.OrderByDescending(x => x.TryGetProperty("scope", out var s) && s.GetString() == "user")
                               .ThenByDescending(x => x.TryGetProperty("lastUpdated", out var t) ? t.GetString() : "").FirstOrDefault();
                if (e.ValueKind != JsonValueKind.Object) continue;
                var path = e.TryGetProperty("installPath", out var ip) ? ip.GetString() : null;
                var ver = e.TryGetProperty("version", out var v) ? v.GetString() : null;
                if (path != null) list.Add((p.Name, path, ver is { Length: 12 } && Regex.IsMatch(ver, "^[0-9a-f]+$") ? ver[..7] : ver));
            }
        }
        catch { }
        return list;
    }

    private static Node? Docs(params string[] files)
    {
        var ex = files.Where(File.Exists).ToList();
        if (ex.Count == 0) return null;
        var g = new Node("Memory files", "group");
        foreach (var f in ex) g.Add(new Node(Path.GetFileName(f), "doc") { Path = f, Size = new FileInfo(f).Length });
        return g;
    }

    private static Node? Projects(IEnumerable<string> paths)
    {
        var g = new Node("Projects it knows", "group");
        foreach (var p in paths.Select(p => p.Replace('/', '\\').TrimEnd('\\')).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (p.Length < 3) continue;
            g.Add(new Node(Path.GetFileName(p) is { Length: > 0 } n ? n : p, "folder") { Path = p, Detail = Directory.Exists(p) ? null : "folder no longer exists" });
        }
        g.SortChildren();
        return g.NullIfEmpty();
    }

    private static IEnumerable<string> JsonKeys(string file, string key)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file));
            if (doc.RootElement.TryGetProperty(key, out var o) && o.ValueKind == JsonValueKind.Object)
                return o.EnumerateObject().Select(p => p.Name).ToList();
        }
        catch { }
        return Array.Empty<string>();
    }

    /// <summary>Reads TOML table headers and their raw bodies. Enough for names, not a full parser.</summary>
    private static List<(string name, string body)> TomlSections(string file)
    {
        var list = new List<(string, string)>();
        if (!File.Exists(file)) return list;
        string? cur = null; var body = new System.Text.StringBuilder();
        foreach (var line in File.ReadLines(file))
        {
            var m = Regex.Match(line, @"^\s*\[([^\[\]]+)\]\s*$");
            if (m.Success)
            {
                if (cur != null) list.Add((cur, body.ToString()));
                cur = m.Groups[1].Value.Trim(); body.Clear();
            }
            else body.AppendLine(line);
        }
        if (cur != null) list.Add((cur, body.ToString()));
        return list;
    }

    private static string Unquote(string s) => s.Trim().Trim('"', '\'');

    private static (string? name, string? desc) FrontMatter(string md)
    {
        try
        {
            using var r = new StreamReader(md);
            if (r.ReadLine()?.Trim() != "---") return (null, null);
            string? name = null, desc = null;
            for (int i = 0; i < 40; i++)
            {
                var line = r.ReadLine();
                if (line == null || line.Trim() == "---") break;
                var m = Regex.Match(line, @"^(name|description):\s*(.*)$");
                if (!m.Success) continue;
                var v = m.Groups[2].Value.Trim().Trim('"', '\'');
                if (v is ">" or "|" or ">-" or "|-") v = r.ReadLine()?.Trim() ?? "";
                if (m.Groups[1].Value == "name") name = v; else desc = Clip(v);
            }
            return (string.IsNullOrWhiteSpace(name) ? null : name, string.IsNullOrWhiteSpace(desc) ? null : desc);
        }
        catch { return (null, null); }
    }

    public static (string? name, string? desc, string? version) Manifest(string file, string nameKey, string fallbackKey)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file));
            var r = doc.RootElement;
            string? S(string k) => r.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            return (S(nameKey) ?? S(fallbackKey), Clip(S("description")), S("version"));
        }
        catch { return (null, null, null); }
    }

    private static string? Clip(string? s) => s == null ? null : s.Length > 180 ? s[..177].TrimEnd() + "…" : s;

    private static void Dedupe(Node g)
    {
        if (g.Children == null) return;
        g.Children = g.Children.GroupBy(c => c.Name).Select(x => x.First()).ToList();
    }

    public static IEnumerable<string> SafeDirs(string dir)
    {
        try { return Directory.EnumerateDirectories(dir).OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList(); }
        catch { return Array.Empty<string>(); }
    }

    public static IEnumerable<string> SafeFilesIn(string dir)
    {
        try { return Directory.Exists(dir) ? Directory.EnumerateFiles(dir).OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList() : Array.Empty<string>(); }
        catch { return Array.Empty<string>(); }
    }
}
