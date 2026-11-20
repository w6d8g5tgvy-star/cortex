# Cortex window capture helper (Windows). Started once by src/windows.js and kept running, so captures don't
# pay PowerShell's start-up cost each frame. Passed with -EncodedCommand (never run as a script file).
# Protocol: one command per line on stdin, one answer line on stdout.
#   LIST                      -> JSON array of top-level app windows
#   CAP <tab> id <tab> path <tab> maxW -> OK | MIN | GONE | ERR ...   (JPEG written to path; works when covered)
#   SCREEN <tab> path <tab> maxW       -> OK | ERR ...                (whole desktop as JPEG)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
$src = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.Diagnostics;
using System.Windows.Forms;

public static class CxWin {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int size);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
  [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr mon, int type, out uint dpiX, out uint dpiY);

  // Apps that don't handle display scaling draw (and PrintWindow) at 96 DPI, smaller than they look on screen.
  // (GetDpiForWindow reports 96 for such windows, so use the monitor's real scaling.)
  static void PrintSize(IntPtr h, ref int w, ref int hh) {
    try {
      if (GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(h)) == 0) {
        uint dx, dy;
        if (GetDpiForMonitor(MonitorFromWindow(h, 2), 0, out dx, out dy) == 0 && dx > 96) {
          w = Math.Max(1, (int)(w * 96L / dx)); hh = Math.Max(1, (int)(hh * 96L / dx));
        }
      }
    } catch { }
  }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  static Dictionary<uint, string> names = new Dictionary<uint, string>();

  public static void Init() {
    // Real pixel sizes on high-DPI screens (otherwise captures come out cropped or blurry).
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
  }

  static string Esc(string s) {
    var b = new StringBuilder();
    foreach (char c in s) {
      if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
      else if (c < 32) b.Append(' ');
      else b.Append(c);
    }
    return b.ToString();
  }

  static string Proc(uint pid) {
    string n;
    if (names.TryGetValue(pid, out n)) return n;
    try { n = Process.GetProcessById((int)pid).ProcessName; } catch { n = ""; }
    names[pid] = n;
    return n;
  }

  public static string List() {
    names.Clear();
    var sb = new StringBuilder("[");
    bool first = true;
    EnumWindows(delegate (IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;            // owned popups/dialogs
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;       // tool windows
      int cloaked = 0;
      DwmGetWindowAttribute(h, 14, out cloaked, 4);
      if (cloaked != 0) return true;                               // hidden UWP / other desktops
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      var t = new StringBuilder(len + 1);
      GetWindowText(h, t, t.Capacity);
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      RECT r;
      GetWindowRect(h, out r);
      if (!first) sb.Append(',');
      first = false;
      sb.Append("{\"id\":\"").Append(h.ToInt64()).Append("\",\"title\":\"").Append(Esc(t.ToString()))
        .Append("\",\"process\":\"").Append(Esc(Proc(pid))).Append("\",\"pid\":").Append(pid)
        .Append(",\"minimized\":").Append(IsIconic(h) ? "true" : "false")
        .Append(",\"w\":").Append(r.R - r.L).Append(",\"h\":").Append(r.B - r.T).Append('}');
      return true;
    }, IntPtr.Zero);
    return sb.Append(']').ToString();
  }

  static ImageCodecInfo Jpeg() {
    foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") return c;
    return null;
  }

  static void SaveJpeg(Bitmap bmp, string path, int maxW) {
    Bitmap outB = bmp;
    if (maxW > 0 && bmp.Width > maxW) {
      int nh = Math.Max(1, (int)((long)bmp.Height * maxW / bmp.Width));
      outB = new Bitmap(maxW, nh);
      using (var g = Graphics.FromImage(outB)) {
        g.InterpolationMode = InterpolationMode.HighQualityBilinear;
        g.DrawImage(bmp, 0, 0, maxW, nh);
      }
    }
    var ep = new EncoderParameters(1);
    ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 72L);
    outB.Save(path, Jpeg(), ep);
    if (outB != bmp) outB.Dispose();
  }

  static bool LooksBlank(Bitmap b) {
    // Some GPU-drawn windows come back all black; sample a grid of pixels.
    int dark = 0, n = 0;
    for (int y = 1; y < 6; y++) for (int x = 1; x < 6; x++) {
      Color c = b.GetPixel(b.Width * x / 6, b.Height * y / 6);
      n++;
      if (c.R < 6 && c.G < 6 && c.B < 6) dark++;
    }
    return dark == n;
  }

  public static string Capture(long id, string path, int maxW) {
    IntPtr h = new IntPtr(id);
    if (!IsWindow(h)) return "GONE";
    if (IsIconic(h)) return "MIN";
    RECT r;
    GetWindowRect(h, out r);
    int w = r.R - r.L, hh = r.B - r.T;
    if (w <= 0 || hh <= 0) return "MIN";
    int sw = w, sh = hh;                                             // on-screen size, for the fallback
    PrintSize(h, ref w, ref hh);
    using (var bmp = new Bitmap(w, hh)) {
      bool printed;
      using (var g = Graphics.FromImage(bmp)) {
        IntPtr dc = g.GetHdc();
        printed = PrintWindow(h, dc, 2);                           // 2 = PW_RENDERFULLCONTENT (works when covered)
        g.ReleaseHdc(dc);
      }
      if (!printed || LooksBlank(bmp)) {
        using (var sb = new Bitmap(sw, sh)) {
          using (var g = Graphics.FromImage(sb)) g.CopyFromScreen(r.L, r.T, 0, 0, new Size(sw, sh));
          SaveJpeg(sb, path, maxW);
        }
        return "OK SCREEN";
      }
      SaveJpeg(bmp, path, maxW);
    }
    return "OK";
  }

  // For tests: average colour of a window's capture ("R,G,B"), so a test can prove it captured the right window.
  public static string Average(long id) {
    IntPtr h = new IntPtr(id);
    if (!IsWindow(h)) return "GONE";
    if (IsIconic(h)) return "MIN";
    RECT r;
    GetWindowRect(h, out r);
    int w = r.R - r.L, hh = r.B - r.T;
    PrintSize(h, ref w, ref hh);
    using (var bmp = new Bitmap(w, hh)) {
      using (var g = Graphics.FromImage(bmp)) { IntPtr dc = g.GetHdc(); PrintWindow(h, dc, 2); g.ReleaseHdc(dc); }
      long R = 0, G = 0, B = 0, n = 0;
      for (int y = hh / 4; y < hh * 3 / 4; y += 7) for (int x = w / 4; x < w * 3 / 4; x += 7) { Color c = bmp.GetPixel(x, y); R += c.R; G += c.G; B += c.B; n++; }
      if (n == 0) return "0,0,0";
      return (R / n) + "," + (G / n) + "," + (B / n);
    }
  }

  public static string Screen(string path, int maxW) {
    var b = SystemInformation.VirtualScreen;
    using (var bmp = new Bitmap(b.Width, b.Height)) {
      using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(b.Left, b.Top, 0, 0, bmp.Size);
      SaveJpeg(bmp, path, maxW);
    }
    return "OK";
  }
}
'@
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing, System.Windows.Forms
[CxWin]::Init()
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $p = $line.Split([char]9)
  $r = ''
  try {
    switch ($p[0]) {
      'LIST' { $r = [CxWin]::List() }
      'CAP' { $r = [CxWin]::Capture([long]$p[1], $p[2], [int]$p[3]) }
      'SCREEN' { $r = [CxWin]::Screen($p[1], [int]$p[2]) }
      'AVG' { $r = [CxWin]::Average([long]$p[1]) }
      'PING' { $r = 'PONG' }
      'QUIT' { exit 0 }
      default { $r = 'ERR unknown command' }
    }
  } catch { $r = 'ERR ' + ($_.Exception.Message -replace '\s+', ' ') }
  [Console]::Out.WriteLine($r)
  [Console]::Out.Flush()
}
