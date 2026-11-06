using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

// Deliberately small transport adapter. Bibliography rules, identifiers and CSL
// formatting live in the application/domain layer, not in Word automation.
class Program
{
    static string Stage = "连接";
    static JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 12000000 };
    static string[] ProgIds(string application) { return application == "word" ? new[] { "Word.Application" } : new[] { "kwps.Application", "wps.Application" }; }
    static dynamic Active(string application)
    {
        return OfficeSession.Active(application);
    }
    static bool Own(string code) { return code.Trim().StartsWith("ADDIN PW_CITE_") || code.Trim().StartsWith("ADDIN PW_BIB_"); }
    static Dictionary<string, object> Map(object obj) { return (Dictionary<string, object>)obj; }
    static string Str(Dictionary<string, object> map, string key) { return map.ContainsKey(key) && map[key] != null ? Convert.ToString(map[key]) : ""; }
    static object[] Arr(Dictionary<string, object> map, string key) { return map.ContainsKey(key) && map[key] != null ? ((System.Collections.IEnumerable)map[key]).Cast<object>().ToArray() : new object[0]; }
    static string Hash(string value) { using (var sha = SHA256.Create()) return Convert.ToBase64String(sha.ComputeHash(Encoding.UTF8.GetBytes(value))); }
    static Dictionary<string, object> Snapshot(dynamic app)
    {
        if ((int)app.Documents.Count == 0) throw new InvalidOperationException("请先在 Word/WPS 中打开或新建文档。");
        dynamic doc = app.ActiveDocument, selection = app.Selection;
        var fields = new List<object>();
        var allCodes = new StringBuilder();
        for (int i = 1; i <= (int)doc.Fields.Count; i++)
        {
            dynamic field = doc.Fields[i]; string code = (string)field.Code.Text;
            allCodes.Append(i).Append(':').Append(code).Append('|');
            if (Own(code)) fields.Add(new { index = i, code = code.Trim(), start = (int)field.Code.Start - 1, end = (int)field.Result.End + 1, text = (string)field.Result.Text });
        }
        string name = (string)doc.Name, fullName = (string)doc.FullName;
        int hwnd = (int)app.ActiveWindow.Hwnd, start = (int)selection.Start, end = (int)selection.End, story = (int)selection.StoryType;
        string signature = Hash(fullName + "|" + hwnd + "|" + start + "|" + end + "|" + story + "|" + (string)doc.Content.Text + "|" + allCodes);
        return new Dictionary<string, object> { { "signature", signature }, { "target", new { name, fullName, hwnd, version = (string)app.Version } }, { "selection", new { start, end, story } }, { "fields", fields } };
    }
    static void WriteField(dynamic doc, dynamic field, Dictionary<string, object> change)
    {
        Stage = "准备引用域";
        string code = Str(change, "code");
        if (!Own(code) || code.Length > 250050) throw new InvalidOperationException("引用标记无效。");
        dynamic result = field.Result;
        Stage = "写入引用标记"; field.Locked = false; field.Code.Text = " " + code + " ";
        var runs = Arr(change, "runs").Select(Map).ToArray();
        string text = String.Concat(runs.Select(r => Str(r, "text")));
        if (text.Length > 1000000) throw new InvalidOperationException("参考文献表超出单次更新上限。");
        Stage = "写入引用正文"; result.Text = text;
        Stage = "设置引用格式"; result.Font.Bold = 0; result.Font.Italic = 0; result.Font.Superscript = 0; result.Font.Subscript = 0; result.Font.SmallCaps = 0;
        int offset = (int)result.Start;
        foreach (var run in runs)
        {
            string part = Str(run, "text"); dynamic span = doc.Range(offset, offset + part.Length);
            if (run.ContainsKey("italic")) span.Font.Italic = Convert.ToBoolean(run["italic"]) ? -1 : 0;
            if (run.ContainsKey("bold")) span.Font.Bold = Convert.ToBoolean(run["bold"]) ? -1 : 0;
            if (run.ContainsKey("superscript")) span.Font.Superscript = Convert.ToBoolean(run["superscript"]) ? -1 : 0;
            if (run.ContainsKey("subscript")) span.Font.Subscript = Convert.ToBoolean(run["subscript"]) ? -1 : 0;
            if (run.ContainsKey("smallCaps")) span.Font.SmallCaps = Convert.ToBoolean(run["smallCaps"]) ? -1 : 0;
            offset += part.Length;
        }
        if (change.ContainsKey("bibliography") && Convert.ToBoolean(change["bibliography"]))
        {
            result.ParagraphFormat.LeftIndent = 24f; result.ParagraphFormat.FirstLineIndent = -24f;
            result.ParagraphFormat.SpaceAfter = 6f; result.ParagraphFormat.TabStops.Add(24f);
        }
        field.Locked = true;
    }
    static object Apply(dynamic app, Dictionary<string, object> input)
    {
        var snapshot = Snapshot(app);
        if ((string)snapshot["signature"] != Str(input, "expected")) throw new InvalidOperationException("文档、光标或引用已变化，请重新预览后再执行。");
        dynamic doc = app.ActiveDocument, selection = app.Selection;
        if ((bool)doc.ReadOnly || (int)doc.ProtectionType != -1) throw new InvalidOperationException("当前文档只读或受保护，无法插入引用。");
        if ((bool)doc.TrackRevisions) throw new InvalidOperationException("请先关闭修订记录，再更新引用；已有修订会保留。");
        if ((int)selection.StoryType != 1) throw new InvalidOperationException("当前版本请在正文中插入引用，暂不支持页眉、脚注或文本框。");
        if (!String.IsNullOrEmpty((string)doc.Path) && !((string)doc.Name).EndsWith(".docx", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("请先将文档另存为 .docx，再使用可更新引用。");
        dynamic insertRange = selection.Range.Duplicate; insertRange.Collapse(0);
        int originalSuper = (int)insertRange.Font.Superscript, originalSub = (int)insertRange.Font.Subscript;
        int originalBold = (int)insertRange.Font.Bold, originalItalic = (int)insertRange.Font.Italic, originalCaps = (int)insertRange.Font.SmallCaps;
        bool insert = input.ContainsKey("insert") && input["insert"] != null;
        if (insert) for (int i = 1; i <= (int)doc.Fields.Count; i++) { dynamic f = doc.Fields[i]; if ((int)insertRange.Start > (int)f.Code.Start - 1 && (int)insertRange.Start < (int)f.Result.End + 1) throw new InvalidOperationException("光标位于已有域中，请移到引用域之外。"); }
        var updates = Arr(input, "updates").Select(Map).OrderByDescending(c => Convert.ToInt32(c["index"])).ToArray();
        // Capture live COM ranges/fields before edits; Word adjusts these anchors as
        // earlier field lengths change. Never recompute offsets after mutations.
        var targets = new Dictionary<int, object>();
        foreach (var change in updates) { int i = Convert.ToInt32(change["index"]); dynamic field = doc.Fields[i]; if (!Own((string)field.Code.Text)) throw new InvalidOperationException("引用域已变化。"); targets[i] = field; }
        dynamic undo;
        try { undo = app.UndoRecord; undo.StartCustomRecord("文献工作台：更新引用"); }
        catch { throw new InvalidOperationException("此版本的 Word/WPS 未提供安全撤销事务接口，暂不写入；请使用 Microsoft Word 2013 或更新版本。"); }
        bool changed = false, ended = false;
        try
        {
            foreach (var change in updates) { changed = true; WriteField(doc, targets[Convert.ToInt32(change["index"])], change); }
            if (insert)
            {
                var change = Map(input["insert"]); bool bib = Convert.ToBoolean(change["bibliography"]);
                if (bib && (int)insertRange.Start > 0 && (string)doc.Range((int)insertRange.Start - 1, (int)insertRange.Start).Text != "\r") { changed = true; insertRange.InsertBefore("\r"); insertRange.Collapse(0); }
                changed = true;
                // The QUOTE seed creates a valid result range before changing to ADDIN.
                // This is the compatibility technique documented by Zotero's AGPL-3.0
                // Word integration (document.cpp / insertFieldRaw); direct ADDIN creation
                // gives broken ranges on current Word versions.
                Stage = "创建引用域"; dynamic field = doc.Fields.Add(insertRange, 35, "\"PW\"", false);
                WriteField(doc, field, change);
                int after = (int)field.Result.End + 1;
                if (bib) { dynamic tail = doc.Range(after, after); tail.InsertAfter("\r"); after++; }
                doc.Range(after, after).Select();
                Stage = "恢复正文格式";
                app.Selection.Font.Superscript = originalSuper == 9999999 ? 0 : originalSuper;
                app.Selection.Font.Subscript = originalSub == 9999999 ? 0 : originalSub;
                app.Selection.Font.Bold = originalBold == 9999999 ? 0 : originalBold;
                app.Selection.Font.Italic = originalItalic == 9999999 ? 0 : originalItalic;
                app.Selection.Font.SmallCaps = originalCaps == 9999999 ? 0 : originalCaps;
            }
            undo.EndCustomRecord(); ended = true;
            return new { updated = updates.Length, inserted = insert, document = (string)doc.Name, message = "引用已写入文档。请在 Word/WPS 中保存文档。" };
        }
        catch
        {
            if (!ended) { try { undo.EndCustomRecord(); } catch { } }
            if (changed) { try { doc.Undo(1); } catch { throw new InvalidOperationException("写入未完成且自动撤销失败。请立即检查 Word/WPS 文档，使用撤销或恢复备份后再继续。"); } }
            throw;
        }
    }
    [STAThread]
    static void Main()
    {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            var input = Json.Deserialize<Dictionary<string, object>>(Console.In.ReadToEnd()); string action = Str(input, "action"); object value;
            if (action == "probe")
            {
                var result = new List<object>();
                foreach (string name in new[] { "word", "wps" })
                {
                    bool installed = ProgIds(name).Any(id => Type.GetTypeFromProgID(id) != null), active = false; string version = null;
                    if (installed) try { dynamic app = Active(name); active = (int)app.Documents.Count > 0; version = (string)app.Version; } catch { }
                    result.Add(new { id = name, installed, active, version });
                }
                value = result;
            }
            else
            {
                string application = Str(input, "application"); if (application != "word" && application != "wps") throw new InvalidOperationException("不支持的写作软件。");
                dynamic app = Active(application);
                if (action == "snapshot") value = Snapshot(app);
                else if (action == "apply") value = Apply(app, input);
                else throw new InvalidOperationException("不支持的引用操作。");
            }
            Console.Write(Json.Serialize(new { ok = true, value }));
        }
        catch (Exception e) { bool diagnostic = Environment.GetEnvironmentVariable("PAPER_WORKBENCH_OFFICE_DIAGNOSTIC") == "1"; Console.Write(Json.Serialize(new { ok = false, code = "OFFICE", error = e.Message + (diagnostic ? " [" + Stage + "]" : "") })); if (diagnostic) Console.Error.WriteLine(e.ToString()); Environment.ExitCode = 1; }
    }
}
