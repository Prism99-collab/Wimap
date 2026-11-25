using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Wimap.Scan;

namespace Wimap;

/// <summary>Native shell: a dark window hosting the web UI, plus the bridge for scanning, saving and opening things.</summary>
public sealed class MainForm : Form
{
    private const string Origin = "https://wimap.local";
    private const string Host = Origin + "/";
    private const long MaxOpenBytes = 256L * 1024 * 1024;

    // The app's own pages may only run their own scripts.
    private const string AppCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
                                  "connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
    // Export previews run in a sandbox with no network and no access to the app.
    private const string PreviewCsp = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; " +
                                      "script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

    private static readonly Color Bg = Color.FromArgb(0x0E, 0x0F, 0x11);
    private static readonly Dictionary<string, (string filter, string ext)> SaveKinds = new()
    {
        ["html"] = ("Web page (*.html)|*.html", ".html"),
        ["json"] = ("Wimap map data (*.json)|*.json", ".json"),
        ["png"] = ("PNG image (*.png)|*.png", ".png"),
        ["jpeg"] = ("JPEG image (*.jpg)|*.jpg;*.jpeg", ".jpg"),
        ["svg"] = ("SVG image (*.svg)|*.svg", ".svg"),
    };

    private readonly WebView2 _web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Bg };
    private readonly string _lastScan = Path.Combine(Program.DataDir, "last-scan.json");
    private readonly string _windowFile = Path.Combine(Program.DataDir, "window.json");
    private readonly HashSet<string> _savedThisSession = new(StringComparer.OrdinalIgnoreCase);
    private CancellationTokenSource? _scanCts;
    private int _scanId;
    private string _preview = "";
    private int _previewId;

    public MainForm()
    {
        Text = "Wimap";
        BackColor = Bg;
        MinimumSize = new Size(960, 640);
        Size = new Size(1440, 920);
        StartPosition = FormStartPosition.CenterScreen;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        RestorePlacement();
        Controls.Add(_web);
        Load += async (_, _) => await InitAsync();
        FormClosing += (_, _) => { _scanCts?.Cancel(); SavePlacement(); };
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // Dark title bar tinted to the app background, so the window reads as one surface.
        // Older Windows builds ignore attributes they do not know.
        int on = 1; DwmSetWindowAttribute(Handle, 20, ref on, 4);
        int color = Bg.R | (Bg.G << 8) | (Bg.B << 16); DwmSetWindowAttribute(Handle, 35, ref color, 4);
        int text = 0xD6 | (0xD6 << 8) | (0xDA << 16); DwmSetWindowAttribute(Handle, 36, ref text, 4);
    }

    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    private async Task InitAsync()
    {
        Directory.CreateDirectory(Program.DataDir);
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.DataDir, "WebView2"));
            await _web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show("Wimap needs the Microsoft Edge WebView2 Runtime. Install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 and open Wimap again.",
                "Wimap", MessageBoxButtons.OK, MessageBoxIcon.Information);
            Close();
            return;
        }
        catch (Exception ex)
        {
            // Any other start-up failure (a locked or unwritable data folder, a broken runtime) must not leave a blank window.
            Log.Error("webview start", ex);
            MessageBox.Show($"Wimap could not start its window.{Environment.NewLine}{Environment.NewLine}{ex.Message}{Environment.NewLine}{Environment.NewLine}Details are in {Log.FilePath}",
                "Wimap", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            Close();
            return;
        }
        var core = _web.CoreWebView2;
#if DEBUG
        var dev = Debugger.IsAttached || Environment.GetEnvironmentVariable("WIMAP_DEVTOOLS") == "1";
#else
        const bool dev = false; // release builds never expose developer tools
#endif
        core.Settings.AreDevToolsEnabled = dev;
        core.Settings.AreHostObjectsAllowed = false; // pages talk to the app only through checked web messages
        core.Settings.IsSwipeNavigationEnabled = false;
        core.Settings.IsReputationCheckingRequired = false; // only local pages are shown, so no URL checks go to Microsoft
        core.Settings.AreDefaultContextMenusEnabled = dev;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.IsGeneralAutofillEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = dev; // keeps Ctrl+P, Ctrl+R and friends from acting on the app shell
        // The export preview is a sandboxed iframe, which some PCs run in its own process. Only this overload
        // routes such iframe requests here; without it they hit real DNS and fail ("wimap.local could not be found").
        try { core.AddWebResourceRequestedFilter(Host + "*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All); }
        catch (Exception e) when (e is NotImplementedException or InvalidCastException or COMException)
        {
            Log.Write("old WebView2 runtime: iframe request filter unavailable, using the basic one");
            core.AddWebResourceRequestedFilter(Host + "*", CoreWebView2WebResourceContext.All);
        }
        core.WebResourceRequested += ServeUi;
        core.WebMessageReceived += OnMessage;
        // Wimap never needs the camera, microphone, location, notifications or downloads; refuse them all.
        core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
        core.DownloadStarting += (_, e) => e.Cancel = true;
        // Links open in the user's browser, never inside the app.
        core.NewWindowRequested += (_, e) => { e.Handled = true; OpenUrl(e.Uri); };
        core.NavigationStarting += (_, e) => { if (!e.Uri.StartsWith(Host, StringComparison.Ordinal)) { e.Cancel = true; OpenUrl(e.Uri); } };
        core.FrameNavigationStarting += (_, e) =>
        {
            if (e.Uri.StartsWith(Host, StringComparison.Ordinal) || e.Uri == "about:blank") return;
            e.Cancel = true;
            OpenUrl(e.Uri);
        };
        core.Navigate(Host + "index.html");
    }

    /* ---------- serving the UI ---------- */

    private void ServeUi(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var env = _web.CoreWebView2.Environment;
        var rel = Uri.UnescapeDataString(new Uri(e.Request.Uri).AbsolutePath.TrimStart('/'));
        if (rel.Length == 0) rel = "index.html";

        if (rel == "__preview.html")
        {
            var bytes = new MemoryStream(Encoding.UTF8.GetBytes(_preview));
            e.Response = env.CreateWebResourceResponse(bytes, 200, "OK", Headers("text/html; charset=utf-8", PreviewCsp));
            return;
        }

        var stream = OpenUiFile(rel);
        if (stream == null) { e.Response = env.CreateWebResourceResponse(null, 404, "Not found", ""); return; }
        var mime = Path.GetExtension(rel).ToLowerInvariant() switch
        {
            ".html" => "text/html; charset=utf-8", ".js" => "text/javascript; charset=utf-8", ".css" => "text/css; charset=utf-8",
            ".svg" => "image/svg+xml", ".png" => "image/png", ".json" => "application/json", _ => "application/octet-stream",
        };
        e.Response = env.CreateWebResourceResponse(stream, 200, "OK", Headers(mime, mime.StartsWith("text/html") ? AppCsp : null));
    }

    private static string Headers(string mime, string? csp) =>
        $"Content-Type: {mime}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff" + (csp != null ? $"\r\nContent-Security-Policy: {csp}" : "");

    private static Stream? OpenUiFile(string rel)
    {
#if DEBUG
        // During development WIMAP_UI points at the ui folder, so edits show without a rebuild.
        // Release builds only ever serve the interface embedded in the exe.
        var devDir = Environment.GetEnvironmentVariable("WIMAP_UI");
        if (devDir != null)
        {
            var root = Path.GetFullPath(devDir) + Path.DirectorySeparatorChar;
            var full = Path.GetFullPath(Path.Combine(root, rel));
            if (full.StartsWith(root, StringComparison.OrdinalIgnoreCase) && File.Exists(full)) return File.OpenRead(full);
        }
#endif
        return Assembly.GetExecutingAssembly().GetManifestResourceStream("ui/" + rel);
    }

    /* ---------- messages from the UI ---------- */

    private void Post(object msg) => PostRaw(JsonSerializer.Serialize(msg, Program.Json));

    /// <summary>Safe from any thread and while the window is closing.</summary>
    private void PostRaw(string json)
    {
        if (IsDisposed || !IsHandleCreated) return;
        try { BeginInvoke(() => { if (!IsDisposed) _web.CoreWebView2?.PostWebMessageAsJson(json); }); }
        catch (InvalidOperationException) { /* the window is going away */ }
    }

    private async void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // Only the app's own top-level page may drive the host.
        if (!e.Source.StartsWith(Host, StringComparison.Ordinal) || e.Source.StartsWith(Host + "__preview", StringComparison.Ordinal)) return;
        JsonNode? m;
        try { m = JsonNode.Parse(e.WebMessageAsJson); } catch { return; }
        var type = Str(m, "type");
        try
        {
            switch (type)
            {
                case "hello": await HelloAsync(); break;
                case "scan": await ScanAsync(ReadOptions(m)); break;
                case "cancel": _scanCts?.Cancel(); break;
                case "reveal": Reveal(Str(m, "path")); break;
                case "url": OpenUrl(Str(m, "url")); break;
                case "openFile": OpenSavedFile(Str(m, "path")); break;
                case "saveFile": await SaveFileAsync(m!); break;
                case "openMap": await OpenMapAsync(); break;
                case "preview":
                    _preview = Str(m, "html") ?? "";
                    Post(new { type = "previewReady", id = ++_previewId });
                    break;
                case "forget":
                    if (File.Exists(_lastScan)) File.Delete(_lastScan);
                    Post(new { type = "forgotten" });
                    break;
                case "exit": Close(); break;
            }
        }
        catch (Exception ex)
        {
            Log.Error($"message {type}", ex);
            Post(new { type = "error", message = ex.Message });
        }
    }

    private static string? Str(JsonNode? m, string key) => m?[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static ScanOptions ReadOptions(JsonNode? m)
    {
        ScanOptions? opt = null;
        try { opt = m?["options"]?.Deserialize<ScanOptions>(new JsonSerializerOptions { PropertyNameCaseInsensitive = true }); } catch (JsonException) { }
        opt ??= new ScanOptions();
        opt.Depth = Math.Clamp(opt.Depth, 1, 6);
        return opt;
    }

    private async Task HelloAsync()
    {
        string? last = null;
        if (File.Exists(_lastScan))
        {
            try
            {
                last = await File.ReadAllTextAsync(_lastScan);
                using var _ = JsonDocument.Parse(last); // a damaged file is ignored instead of breaking the UI
            }
            catch (Exception ex) { Log.Error("read last scan", ex); last = null; }
        }
        var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "1.0.0";
        // Raw JSON is spliced in so a multi-megabyte scan is not parsed and re-serialized.
        PostRaw($"{{\"type\":\"hello\",\"machine\":{JsonSerializer.Serialize(Environment.MachineName)},\"user\":{JsonSerializer.Serialize(Environment.UserName)},\"version\":\"{version}\",\"last\":{last ?? "null"}}}");
    }

    /* ---------- scanning ---------- */

    private async Task ScanAsync(ScanOptions opt)
    {
        _scanCts?.Cancel();
        var cts = _scanCts = new CancellationTokenSource();
        var id = ++_scanId;
        bool Current() => id == _scanId;
        var scanner = new Scanner();
        using var timer = new System.Threading.Timer(_ =>
        {
            if (!Current()) return;
            var (files, bytes, path) = scanner.Progress.Read();
            Post(new { type = "tick", files, bytes, path });
        }, null, 0, 150);

        ScanResult result;
        try
        {
            result = await scanner.RunAsync(opt,
                // Each branch carries only the icons the UI has not received yet.
                (key, node) => { if (Current()) Post(new { type = "branch", key, node, icons = scanner.Icons.TakeNew() }); },
                (key, state) => { if (Current()) Post(new { type = "stage", key, state }); },
                cts.Token);
        }
        finally { timer.Change(Timeout.Infinite, Timeout.Infinite); }
        if (!Current()) return;

        var cancelled = cts.IsCancellationRequested;
        var json = await Task.Run(() => JsonSerializer.Serialize(result, Program.Json));
        if (!cancelled)
        {
            try
            {
                // Written to a temp file first so a crash never leaves half a map behind.
                var tmp = _lastScan + ".tmp";
                await File.WriteAllTextAsync(tmp, json);
                File.Move(tmp, _lastScan, overwrite: true);
            }
            catch (Exception ex)
            {
                // The map still opens; it just will not be there next time.
                Log.Error("save last scan", ex);
                Post(new { type = "error", message = "The map could not be kept for next time: " + ex.Message });
            }
        }
        PostRaw($"{{\"type\":\"done\",\"cancelled\":{(cancelled ? "true" : "false")},\"data\":{json}}}");
    }

    /* ---------- files ---------- */

    private async Task SaveFileAsync(JsonNode m)
    {
        var kind = Str(m, "kind") ?? "";
        if (!SaveKinds.TryGetValue(kind, out var spec)) throw new InvalidOperationException($"Unknown file kind \"{kind}\".");
        var data = Str(m, "data") ?? "";
        byte[] bytes = Str(m, "encoding") == "base64" ? Convert.FromBase64String(data) : new UTF8Encoding(false).GetBytes(data);

        var name = string.Concat((Str(m, "name") ?? "wimap").Split(Path.GetInvalidFileNameChars())).Trim();
        using var dlg = new SaveFileDialog
        {
            Title = "Save",
            Filter = spec.filter,
            FileName = (name.Length > 0 ? name : "wimap") + spec.ext,
            InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
            AddExtension = true,
            OverwritePrompt = true,
        };
        if (dlg.ShowDialog(this) != DialogResult.OK) { Post(new { type = "saved", kind, path = (string?)null }); return; }
        await File.WriteAllBytesAsync(dlg.FileName, bytes);
        _savedThisSession.Add(dlg.FileName);

        string? wingetPath = null, wingetError = null;
        if (kind == "html" && m["winget"]?.GetValue<bool>() == true)
        {
            Post(new { type = "saving", step = "winget" });
            wingetPath = Path.ChangeExtension(dlg.FileName, null) + "-winget.json";
            wingetError = await WingetExportAsync(wingetPath);
            if (wingetError != null) wingetPath = null; else _savedThisSession.Add(wingetPath);
        }
        Post(new { type = "saved", kind, path = dlg.FileName, winget = wingetPath, wingetError });
    }

    /// <summary>Opens a saved map: a Wimap .json file, or an exported .html (its data block is read out in the UI).</summary>
    private async Task OpenMapAsync()
    {
        using var dlg = new OpenFileDialog
        {
            Title = "Open map",
            Filter = "Wimap maps (*.html;*.json)|*.html;*.htm;*.json|All files (*.*)|*.*",
            InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
        };
        if (dlg.ShowDialog(this) != DialogResult.OK) { Post(new { type = "opened", cancelled = true }); return; }
        if (new FileInfo(dlg.FileName).Length > MaxOpenBytes) throw new InvalidOperationException("That file is larger than 256 MB, which is too big to be a Wimap map.");
        var text = await File.ReadAllTextAsync(dlg.FileName);
        Post(new { type = "opened", name = Path.GetFileNameWithoutExtension(dlg.FileName), text });
    }

    /// <summary>winget writes a file that <c>winget import</c> reinstalls on the new PC.</summary>
    private static async Task<string?> WingetExportAsync(string path)
    {
        try
        {
            // A full path, so a winget.exe dropped next to Wimap.exe (say in Downloads) is never the one that runs.
            var winget = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WindowsApps", "winget.exe");
            if (!File.Exists(winget)) return "winget is not installed";
            var psi = new ProcessStartInfo(winget) { CreateNoWindow = true, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var a in new[] { "export", "-o", path, "--accept-source-agreements", "--disable-interactivity" }) psi.ArgumentList.Add(a);
            using var p = Process.Start(psi)!;
            var drain = Task.WhenAll(p.StandardOutput.ReadToEndAsync(), p.StandardError.ReadToEndAsync());
            using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(3));
            try { await p.WaitForExitAsync(cts.Token); }
            catch (OperationCanceledException) { try { p.Kill(true); } catch { } return "winget took longer than 3 minutes"; }
            await drain;
            return File.Exists(path) ? null : "winget did not write the file";
        }
        catch (System.ComponentModel.Win32Exception) { return "winget is not installed"; }
        catch (Exception e) { Log.Error("winget", e); return e.Message; }
    }

    /// <summary>
    /// Shows a file or folder in Explorer. Only paths on this PC's own drives: a map from someone else could point at
    /// a network share (\\server\share), and opening it would send this user's Windows credentials to that server.
    /// </summary>
    private static void Reveal(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        path = Environment.ExpandEnvironmentVariables(path);
        if (!IsLocalPath(path)) return;
        var psi = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe")) { UseShellExecute = false };
        if (File.Exists(path)) psi.ArgumentList.Add("/select," + path);
        else if (Directory.Exists(path)) psi.ArgumentList.Add(path);
        else return;
        Process.Start(psi);
    }

    public static bool IsLocalPath(string path)
    {
        if (path.Length < 3 || path.StartsWith(@"\\") || path.StartsWith("//") || path.Contains("..")) return false;
        if (!char.IsAsciiLetter(path[0]) || path[1] != ':' || (path[2] != '\\' && path[2] != '/')) return false;
        try { return new DriveInfo(path[..1]).DriveType is DriveType.Fixed or DriveType.Removable; }
        catch { return false; }
    }

    /// <summary>Only files this window saved can be opened, so the page can never launch arbitrary programs.</summary>
    private void OpenSavedFile(string? path)
    {
        if (path != null && _savedThisSession.Contains(path) && File.Exists(path))
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
    }

    private static void OpenUrl(string? url)
    {
        // Only web links leave the app; file:, javascript: and custom schemes are ignored.
        if (url != null && Uri.TryCreate(url, UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeHttp) && u.Host != "wimap.local")
            Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true });
    }

    /* ---------- window placement ---------- */

    private sealed record Placement(int X, int Y, int W, int H, bool Max);

    private void RestorePlacement()
    {
        try
        {
            if (!File.Exists(_windowFile)) return;
            var p = JsonSerializer.Deserialize<Placement>(File.ReadAllText(_windowFile));
            if (p == null || p.W < MinimumSize.Width || p.H < MinimumSize.Height) return;
            var rect = new Rectangle(p.X, p.Y, p.W, p.H);
            // Skip a position that is no longer on any screen (a monitor was unplugged).
            if (!Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(rect))) return;
            StartPosition = FormStartPosition.Manual;
            Bounds = rect;
            if (p.Max) WindowState = FormWindowState.Maximized;
        }
        catch (Exception e) { Log.Error("restore window", e); }
    }

    private void SavePlacement()
    {
        try
        {
            var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            Directory.CreateDirectory(Program.DataDir);
            File.WriteAllText(_windowFile, JsonSerializer.Serialize(new Placement(b.X, b.Y, b.Width, b.Height, WindowState == FormWindowState.Maximized)));
        }
        catch (Exception e) { Log.Error("save window", e); }
    }
}
