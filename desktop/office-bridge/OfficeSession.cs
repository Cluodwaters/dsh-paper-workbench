using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class OfficeSession
{
    delegate bool EnumCallback(IntPtr hwnd, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr state);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int maximum);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint objectId, ref Guid interfaceId, [MarshalAs(UnmanagedType.Interface)] out object result);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder info, uint size, out uint required);
    public static string DesktopName() { var station = new StringBuilder(512); uint required; GetUserObjectInformation(GetProcessWindowStation(), 2, station, 1024, out required); var text = new StringBuilder(512); GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()), 2, text, 1024, out required); return station.ToString() + "/" + text.ToString(); }
    public static object Active(string application)
    {
        string[] ids = application == "word" ? new[] { "Word.Application" } : new[] { "kwps.Application", "wps.Application" };
        foreach (string id in ids) try { return Marshal.GetActiveObject(id); } catch (COMException) { }
        if (application == "word")
        {
            object found = null; int wordWindows = 0, nativeWindows = 0, lastResult = 0, allWindows = 0; string nativeError = "";
            // Office registers the ROT lazily. Microsoft's Native Object Model API
            // also works for an already open Word window without changing focus.
            EnumWindows(delegate (IntPtr window, IntPtr state)
            {
                allWindows++;
                var topClass = new StringBuilder(256); GetClassName(window, topClass, 256);
                if (topClass.ToString() != "OpusApp") return true;
                wordWindows++;
                EnumChildWindows(window, delegate (IntPtr child, IntPtr unused)
                {
                    var cls = new StringBuilder(256); GetClassName(child, cls, 256); if (cls.ToString() != "_WwG") return true;
                    nativeWindows++;
                    var iid = new Guid("00020400-0000-0000-C000-000000000046"); object native;
                    lastResult = AccessibleObjectFromWindow(child, 0xFFFFFFF0, ref iid, out native);
                    if (lastResult == 0) try { dynamic candidate = ((dynamic)native).Application; if (((string)candidate.Name).IndexOf("Microsoft Word", StringComparison.OrdinalIgnoreCase) >= 0) found = candidate; } catch (Exception e) { nativeError = e.Message; }
                    return found == null;
                }, IntPtr.Zero);
                return found == null;
            }, IntPtr.Zero);
            if (found != null) return found;
            if (Environment.GetEnvironmentVariable("PAPER_WORKBENCH_OFFICE_DIAGNOSTIC") == "1") { Console.Error.WriteLine("Word native diagnostic: " + allWindows + " total windows, " + wordWindows + " top windows, " + nativeWindows + " native windows, HRESULT=" + lastResult + " " + nativeError); foreach (var p in Process.GetProcessesByName("WINWORD")) Console.Error.WriteLine("Word process " + p.Id + " name=" + p.ProcessName + " window=" + p.MainWindowHandle); }
        }
        throw new InvalidOperationException("请先打开 " + (application == "word" ? "Microsoft Word" : "支持 COM 接口的 WPS 文字") + " 和 .docx 文档。若刚打开，请切换到工作台后重新预览；两者需以相同 Windows 用户运行。");
    }
}
