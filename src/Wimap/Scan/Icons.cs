using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace Wimap.Scan;

/// <summary>Turns exe/ico/png sources into 32px PNGs for the map.</summary>
public static class Icons
{
    private const int Px = 32;

    /// <summary>Registry DisplayIcon looks like <c>"C:\x\app.exe",0</c> or <c>C:\x\app.ico</c>.</summary>
    public static string? FromDisplayIcon(IconStore store, string? spec)
    {
        if (string.IsNullOrWhiteSpace(spec)) return null;
        var s = Environment.ExpandEnvironmentVariables(spec.Trim());
        int index = 0;
        var comma = s.LastIndexOf(',');
        if (comma > 2 && int.TryParse(s[(comma + 1)..].Trim(), out var ix)) { index = ix; s = s[..comma]; }
        s = s.Trim().Trim('"');
        return FromFile(store, s, index);
    }

    public static string? FromFile(IconStore store, string? path, int index = 0)
    {
        if (string.IsNullOrEmpty(path) || !File.Exists(path)) return null;
        try
        {
            var ext = System.IO.Path.GetExtension(path).ToLowerInvariant();
            if (ext is ".png" or ".jpg" or ".jpeg" or ".bmp" or ".gif")
            {
                using var img = Image.FromFile(path);
                return Store(store, img);
            }
            if (ext == ".ico")
            {
                using var ico = new Icon(path, Px, Px);
                using var bmp = ico.ToBitmap();
                return Store(store, bmp);
            }
            using var icon = index != 0 ? Icon.ExtractIcon(path, index, Px) : (Icon.ExtractIcon(path, 0, Px) ?? Icon.ExtractAssociatedIcon(path));
            if (icon == null) return null;
            using var b = icon.ToBitmap();
            return Store(store, b);
        }
        catch { return null; }
    }

    private static string? Store(IconStore store, Image src)
    {
        using var bmp = new Bitmap(Px, Px, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.SmoothingMode = SmoothingMode.HighQuality;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.Clear(Color.Transparent);
            g.DrawImage(src, 0, 0, Px, Px);
        }
        if (IsBlank(bmp)) return null;
        using var ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Png);
        return store.Put(ms.ToArray());
    }

    /// <summary>Some exes return a fully transparent placeholder; treat it as no icon.</summary>
    private static bool IsBlank(Bitmap b)
    {
        for (int y = 0; y < b.Height; y += 3)
            for (int x = 0; x < b.Width; x += 3)
                if (b.GetPixel(x, y).A > 24) return false;
        return true;
    }
}
