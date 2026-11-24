using System.Text;
using Wimap.Scan;
using Xunit;

namespace Wimap.Tests;

public sealed class TempDir : IDisposable
{
    public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "wimap-test-" + Guid.NewGuid().ToString("N"));
    public TempDir() => Directory.CreateDirectory(Path);
    public string File(string rel, int bytes)
    {
        var full = System.IO.Path.Combine(Path, rel);
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(full)!);
        System.IO.File.WriteAllBytes(full, new byte[bytes]);
        return full;
    }
    public void Dispose() { try { Directory.Delete(Path, true); } catch { } }
}

public class FolderWalkerTests
{
    [Fact]
    public void Sizes_include_every_level_but_only_drawn_levels_become_nodes()
    {
        using var t = new TempDir();
        t.File("a/one.bin", 100);
        t.File("a/deep/deeper/two.bin", 50);
        t.File("b/three.bin", 10);
        var node = new FolderWalker(new Progress(), CancellationToken.None).Walk(t.Path, 1, "root");

        Assert.Equal(160, node.Size);
        Assert.Equal(new[] { "a", "b" }, node.Children!.Select(c => c.Name)); // largest first
        Assert.Null(node.Children![0].Children); // depth 1: grandchildren are counted, not drawn
        Assert.Equal(150, node.Children[0].Size);
    }

    [Fact]
    public void Extra_folders_and_files_are_summarised()
    {
        using var t = new TempDir();
        for (int i = 0; i < 5; i++) t.File($"d{i}/x.bin", 10 + i);
        for (int i = 0; i < 4; i++) t.File($"f{i}.bin", 1);
        var node = new FolderWalker(new Progress(), CancellationToken.None) { MaxFolders = 2, MaxFiles = 1 }.Walk(t.Path, 2);

        var more = node.Children!.Where(c => c.Kind == "more").Select(c => c.Name).ToList();
        Assert.Contains("3 more folders", more);
        Assert.Contains("3 more files", more);
        Assert.Equal(5 * 10 + 10 + 4, node.Size);
    }

    [Fact]
    public void Excluded_folders_are_skipped_entirely()
    {
        using var t = new TempDir();
        t.File("keep/a.bin", 5);
        t.File("skip/b.bin", 500);
        var skip = System.IO.Path.Combine(t.Path, "skip");
        var node = new FolderWalker(new Progress(), CancellationToken.None) { Exclude = new HashSet<string>(new[] { skip }, StringComparer.OrdinalIgnoreCase) }.Walk(t.Path, 2);

        Assert.Equal(5, node.Size);
        Assert.DoesNotContain(node.Children!, c => c.Name == "skip");
    }

    [Fact]
    public void Shallow_walks_list_names_without_sizes()
    {
        using var t = new TempDir();
        t.File("a/b/c.bin", 999);
        var node = new FolderWalker(new Progress(), CancellationToken.None) { Shallow = true }.Walk(t.Path, 1);
        Assert.Null(node.Size);
        Assert.Equal("a", node.Children!.Single().Name);
    }

    [Fact]
    public void Budget_marks_sizes_as_lower_bounds()
    {
        using var t = new TempDir();
        for (int i = 0; i < 20; i++) t.File($"f{i}.bin", 1);
        var node = new FolderWalker(new Progress(), CancellationToken.None) { Budget = 5 }.Walk(t.Path, 1);
        Assert.True(node.Approx);
    }

    [Fact]
    public void Cancellation_stops_the_walk()
    {
        using var t = new TempDir();
        t.File("a.bin", 1);
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        Assert.Throws<OperationCanceledException>(() => new FolderWalker(new Progress(), cts.Token).Walk(t.Path, 1));
    }
}

public class AiScannerTests
{
    [Fact]
    public void Mcp_keeps_names_and_launchers_but_never_secrets()
    {
        using var t = new TempDir();
        var file = System.IO.Path.Combine(t.Path, "mcp.json");
        System.IO.File.WriteAllText(file, """
        {
          "mcpServers": {
            "github": { "command": "C:\\tools\\npx.cmd", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "ghp_supersecret" } },
            "leaky": { "command": "node", "args": ["sk-abcdefghijklmnop", "--key=hunter2"] },
            "remote": { "url": "https://mcp.example.com/sse?token=abc", "headers": { "Authorization": "Bearer xyz" } }
          }
        }
        """);
        var nodes = AiScanner.Mcp(file, "mcpServers").ToDictionary(n => n.Name, n => n.Detail);

        Assert.Equal("npx · @modelcontextprotocol/server-github", nodes["github"]);
        Assert.Equal("node", nodes["leaky"]);
        Assert.Equal("remote · mcp.example.com", nodes["remote"]);
        var all = string.Join("|", nodes.Values);
        Assert.DoesNotContain("ghp_", all);
        Assert.DoesNotContain("sk-", all);
        Assert.DoesNotContain("hunter2", all);
        Assert.DoesNotContain("token", all);
    }

    [Fact]
    public void Mcp_tolerates_missing_and_broken_files()
    {
        Assert.Empty(AiScanner.Mcp(@"Z:\does\not\exist.json", "mcpServers"));
        using var t = new TempDir();
        var file = System.IO.Path.Combine(t.Path, "bad.json");
        System.IO.File.WriteAllText(file, "{ not json");
        Assert.Empty(AiScanner.Mcp(file, "mcpServers"));
    }
}

public class AppGroupTests
{
    [Theory]
    [InlineData("Microsoft Visual C++ 2015-2022 Redistributable (x64)", "Microsoft Corporation", "Runtimes and frameworks")]
    [InlineData("Visual Studio Code", "Microsoft Corporation", "Code and dev")]
    [InlineData("Claude", "Anthropic, PBC", "AI and assistants")]
    [InlineData("Brave", "Brave Software Inc", "Browsers")]
    [InlineData("NVIDIA App", "NVIDIA Corporation", "Drivers and hardware")]
    [InlineData("Some Tool", "NVIDIA Corporation", "Drivers and hardware")]
    [InlineData("Some Tool", "Contoso", "Other apps")]
    public void Apps_land_in_the_expected_group(string name, string publisher, string group) =>
        Assert.Equal(group, AppsScanner.GroupOf(name, publisher));
}

public class MozLz4Tests
{
    [Fact]
    public void Decodes_literals_and_overlapping_matches()
    {
        // "abc" as literals, then a 9-byte match at offset 3: "abcabcabcabc".
        var block = new byte[] { 0x35, (byte)'a', (byte)'b', (byte)'c', 0x03, 0x00 };
        var file = Encoding.ASCII.GetBytes("mozLz40\0").Concat(BitConverter.GetBytes(12)).Concat(block).ToArray();
        Assert.Equal("abcabcabcabc", Encoding.ASCII.GetString(BrowserScanner.MozLz4(file)));
    }

    [Fact]
    public void Rejects_other_files()
    {
        Assert.Throws<InvalidDataException>(() => BrowserScanner.MozLz4(Encoding.ASCII.GetBytes("not a mozlz4 file")));
    }
}

public class IconStoreTests
{
    [Fact]
    public void Same_image_is_stored_once()
    {
        var store = new IconStore();
        var a = store.Put(new byte[] { 1, 2, 3 });
        var b = store.Put(new byte[] { 1, 2, 3 });
        Assert.Equal(a, b);
        Assert.Single(store.Snapshot());
        Assert.StartsWith("data:image/png;base64,", store.Snapshot()[a]);
    }
}

public class SecretTests
{
    [Theory]
    [InlineData("docker run -e GITHUB_TOKEN=ghp_x image", "docker")]
    [InlineData("npx -y @x/server-github --token ghp_x", "npx")]
    [InlineData(@"C:\Program Files\nodejs\node.exe", "node")]
    [InlineData(@"""C:\tools\uv x.exe"" run server", "uv x")]
    [InlineData("/usr/bin/python3", "python3")]
    [InlineData("sk-live-abcdef", null)]
    [InlineData("", null)]
    public void Launcher_is_the_program_name_only(string command, string? expected) =>
        Assert.Equal(expected, AiScanner.Launcher(command));

    [Theory]
    [InlineData("@modelcontextprotocol/server-github", true)]
    [InlineData("mcp-server-time", true)]
    [InlineData("@playwright/mcp@latest", true)]
    [InlineData("123e4567-e89b-12d3-a456-426614174000", false)]
    [InlineData("a1b2c3d4e5f6a7b8c9d0e1f2-x", false)]
    [InlineData("12345-67890", false)]
    [InlineData("my-api-key", false)]
    [InlineData("--port", false)]
    [InlineData("plainword", false)]
    public void Package_names_are_told_apart_from_keys(string arg, bool expected) =>
        Assert.Equal(expected, AiScanner.IsPackageName(arg));

    [Theory]
    [InlineData("https://www.youtube.com/watch?v=abc", "https://www.youtube.com/watch?v=abc")]
    [InlineData("https://example.com/page#intro", "https://example.com/page#intro")]
    [InlineData("https://example.com/share?id=7&token=SECRET", "https://example.com/share?id=7")]
    [InlineData("https://example.com/cb#access_token=SECRET&state=1", "https://example.com/cb#state=1")]
    [InlineData("https://user:pass@example.com/", "https://example.com/")]
    [InlineData("https://s3.example.com/f?X-Amz-Signature=abc&api_key=k&size=2", "https://s3.example.com/f?size=2")]
    [InlineData("javascript:alert(1)", "javascript:alert(1)")]
    public void Bookmark_urls_lose_secrets_but_keep_working(string url, string expected) =>
        Assert.Equal(expected, BrowserScanner.CleanUrl(url));

    [Theory]
    [InlineData(@"\attacker.com@SSL\share", false)]
    [InlineData(@"\?\C:\Windows", false)]
    [InlineData("//server/share", false)]
    [InlineData(@"C:\Users\..\Windows", false)]
    [InlineData(@"relative\path", false)]
    [InlineData(@"C:\Windows", true)]
    public void Only_local_drive_paths_can_be_revealed(string path, bool expected) =>
        Assert.Equal(expected, MainForm.IsLocalPath(path));
}
