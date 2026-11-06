using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Text;
using System.IO;
class OfficeQa
{
    [DllImport("oleaut32.dll")] static extern int RegisterActiveObject([MarshalAs(UnmanagedType.IUnknown)] object obj, ref Guid clsid, uint flags, out uint register);
    [DllImport("oleaut32.dll")] static extern int RevokeActiveObject(uint register, IntPtr reserved);
    [STAThread]
    static void Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false); var json = new JavaScriptSerializer { MaxJsonLength = 12000000 }; dynamic app = null, doc = null; uint registration = 0;
        try
        {
            // Attach to a normally launched Word session. Some Office installations
            // cannot initialize their profile in an automation-only hidden session.
            app = OfficeSession.Active("word");
            var clsid = new Guid("000209FF-0000-0000-C000-000000000046"); RegisterActiveObject(app, ref clsid, 0, out registration);
            doc = app.Documents.Add(); doc.PageSetup.PaperSize = 7; doc.PageSetup.TopMargin = 60f; doc.PageSetup.BottomMargin = 60f; doc.PageSetup.LeftMargin = 60f; doc.PageSetup.RightMargin = 60f;
            doc.Content.Font.Name = "Calibri"; doc.Content.Font.NameFarEast = "宋体"; doc.Content.Font.Size = 11f;
            doc.Content.Text = "文献工作台引用验证\r\r中文正文与 Greek α β 保持不变。First citation follows: \rSecond citation follows: \rRepeated citation follows: \r\r参考文献\r";
            doc.SaveAs2(Path.GetFullPath(args[0]), 16); doc.Activate();
            Console.WriteLine(json.Serialize(new { ok = true, name = (string)doc.Name, version = (string)app.Version }));
            string line; while ((line = Console.ReadLine()) != null)
            {
                var input = json.Deserialize<Dictionary<string, object>>(line); string action = (string)input["action"]; object result = null;
                try
                {
                    if (action == "select")
                    {
                        string needle = (string)input["text"]; string text = (string)doc.Content.Text; int position = text.IndexOf(needle); if (position < 0) throw new Exception("Text not found " + needle);
                        dynamic range = doc.Content.Duplicate; range.Find.ClearFormatting(); range.Find.Execute(needle); range.Collapse(0); range.Select();
                    }
                    else if (action == "text")
                    {
                        var fields = new List<object>(); for (int i = 1; i <= (int)doc.Fields.Count; i++) { dynamic f = doc.Fields[i]; fields.Add(new { index = i, code = ((string)f.Code.Text).Trim(), text = (string)f.Result.Text, locked = (bool)f.Locked }); }
                        result = new { text = (string)doc.Content.Text, fields };
                    }
                    else if (action == "delete") { doc.Fields[Convert.ToInt32(input["index"])].Delete(); }
                    else if (action == "moveEnd") { doc.Range((int)doc.Content.End - 1, (int)doc.Content.End - 1).Select(); }
                    else if (action == "save") { doc.Save(); }
                    else if (action == "reopen") { string name = (string)doc.FullName; doc.Save(); doc.Close(0); doc = app.Documents.Open(name); doc.Activate(); }
                    else if (action == "export") { doc.ExportAsFixedFormat(Path.GetFullPath((string)input["path"]), 17); }
                    else if (action == "track") { doc.TrackRevisions = Convert.ToBoolean(input["enabled"]); }
                    else if (action == "undo") { doc.Undo(1); }
                    else if (action == "otherField") { dynamic range = doc.Range((int)doc.Content.End - 1, (int)doc.Content.End - 1); dynamic f = doc.Fields.Add(range, -1, "QUOTE \"Other application field\"", false); f.Locked = true; }
                    else if (action == "quit") { Console.WriteLine(json.Serialize(new { ok = true, value = true })); break; }
                    else throw new Exception("Unknown QA action");
                    Console.WriteLine(json.Serialize(new { ok = true, value = result }));
                }
                catch (Exception e) { Console.WriteLine(json.Serialize(new { ok = false, error = e.Message })); }
            }
        }
        catch (Exception e) { Console.WriteLine(json.Serialize(new { ok = false, error = e.Message, desktop = OfficeSession.DesktopName() })); }
        finally { if (registration != 0) RevokeActiveObject(registration, IntPtr.Zero); if (doc != null) try { doc.Close(0); } catch { } }
    }
}
