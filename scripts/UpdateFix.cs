using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("IADonkey Update Fix")]
[assembly: AssemblyDescription("Opravny balicek pro presmerovani aktualizaci IADonkey na repozitar coolpicture/IADonkey")]
[assembly: AssemblyCompany("MagicWare / IADonkey")]
[assembly: AssemblyProduct("IADonkey")]
[assembly: AssemblyVersion("2.1.31.0")]
[assembly: AssemblyFileVersion("2.1.31.0")]

namespace IADonkeyUpdateFix
{
    static class Program
    {
        private const string NewUpdateUrl = "https://raw.githubusercontent.com/coolpicture/IADonkey/main/version.json";

        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            try
            {
                string runningExePath = null;
                Process[] running = Process.GetProcessesByName("IADonkey");

                foreach (Process p in running)
                {
                    try
                    {
                        if (runningExePath == null && p.MainModule != null && !string.IsNullOrEmpty(p.MainModule.FileName))
                        {
                            string candidate = p.MainModule.FileName;
                            // Ignore this fix exe itself if renamed
                            if (!string.Equals(candidate, Application.ExecutablePath, StringComparison.OrdinalIgnoreCase))
                            {
                                runningExePath = candidate;
                            }
                        }
                    }
                    catch
                    {
                        // Ignore access denied on child processes
                    }
                }

                // 1. Stop running IADonkey instances so they do not overwrite config.json from memory on exit
                bool wasRunning = false;
                foreach (Process p in running)
                {
                    try
                    {
                        if (p.Id == Process.GetCurrentProcess().Id) continue;
                        wasRunning = true;
                        p.Kill();
                        p.WaitForExit(3000);
                    }
                    catch
                    {
                    }
                }

                if (wasRunning)
                {
                    Thread.Sleep(500);
                }

                // 2. Locate and update %APPDATA%\iadonkey\config.json
                string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                string configDir = Path.Combine(appData, "iadonkey");
                if (!Directory.Exists(configDir))
                {
                    Directory.CreateDirectory(configDir);
                }

                string configFile = Path.Combine(configDir, "config.json");
                Encoding utf8NoBom = new UTF8Encoding(false);

                if (File.Exists(configFile))
                {
                    // Create a backup first
                    string backupFile = configFile + ".bak";
                    File.Copy(configFile, backupFile, true);

                    string raw = File.ReadAllText(configFile, Encoding.UTF8);

                    if (Regex.IsMatch(raw, "\"updateUrl\"\\s*:\\s*\"[^\"]*\""))
                    {
                        raw = Regex.Replace(
                            raw,
                            "\"updateUrl\"\\s*:\\s*\"[^\"]*\"",
                            "\"updateUrl\": \"" + NewUpdateUrl + "\""
                        );
                    }
                    else
                    {
                        int lastBrace = raw.LastIndexOf('}');
                        if (lastBrace > 0)
                        {
                            raw = raw.Substring(0, lastBrace).TrimEnd()
                                + ",\n  \"updateUrl\": \"" + NewUpdateUrl + "\"\n}";
                        }
                    }

                    // Reset snoozed update flags if present
                    raw = Regex.Replace(raw, "\"lastDeclinedVersion\"\\s*:\\s*\"[^\"]*\"", "\"lastDeclinedVersion\": null");
                    raw = Regex.Replace(raw, "\"lastDeclinedTime\"\\s*:\\s*\\d+", "\"lastDeclinedTime\": null");

                    File.WriteAllText(configFile, raw, utf8NoBom);
                }
                else
                {
                    string minimalJson = "{\n  \"updateUrl\": \"" + NewUpdateUrl + "\"\n}\n";
                    File.WriteAllText(configFile, minimalJson, utf8NoBom);
                }

                // 3. Restart IADonkey if it was running
                bool restarted = false;
                if (!string.IsNullOrEmpty(runningExePath) && File.Exists(runningExePath))
                {
                    try
                    {
                        ProcessStartInfo psi = new ProcessStartInfo(runningExePath);
                        psi.WorkingDirectory = Path.GetDirectoryName(runningExePath);
                        psi.UseShellExecute = true;
                        Process.Start(psi);
                        restarted = true;
                    }
                    catch
                    {
                    }
                }

                string msg = "Kontrola aktualizací aplikace IADonkey byla úspěšně přesměrována na nový repozitář:\n"
                           + "coolpicture/IADonkey\n\n"
                           + "Konfigurační soubor:\n" + configFile + "\n\n"
                           + (restarted
                               ? "Aplikace IADonkey byla automaticky restartována a nyní může stahovat aktualizace z nového repozitáře."
                               : "Nyní můžete spustit aplikaci IADonkey – aktualizace se budou stahovat z nového repozitáře.");

                MessageBox.Show(
                    msg,
                    "IADonkey – Oprava aktualizací dokončena",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Došlo k chybě při aktualizaci konfigurace:\n\n" + ex.Message,
                    "IADonkey – Chyba opravy",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                Environment.ExitCode = 1;
            }
        }
    }
}
