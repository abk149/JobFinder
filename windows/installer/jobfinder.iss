; ============================================================================
; JobFinder - Inno Setup installer script
;
; Build with Inno Setup 6 (https://jrsoftware.org/isinfo.php) - Windows-native, or
; via Wine on macOS/Linux: `wine ISCC.exe installer\jobfinder.iss`.
;
; This installer:
;   * Lays the bundled Node.js + Next standalone app under Program Files\JobFinder
;   * Downloads + silently installs Ollama (small, ~200 MB)
;   * OPTIONALLY downloads DeepSeek-R1 8B (~5 GB) - user can uncheck on the
;     "Components" page to skip; the dashboard works without it.
;   * Creates Desktop + Start Menu shortcuts pointing at scripts\launcher.bat
;   * Checks for Google Chrome at first launch (informational; not blocking)
; ============================================================================

#define MyAppName          "JobFinder"
#define MyAppVersion       "0.1.0"
#define MyAppPublisher     "JobFinder"
#define MyAppExeName       "scripts\launcher.bat"

[Setup]
AppId={{F1A2B3C4-D5E6-4789-ABCD-1234567890AB}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\JobFinder
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputBaseFilename=JobFinder-Setup-{#MyAppVersion}
Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
; The installer is a regular user-mode install; bumped to admin only for Program Files.
PrivilegesRequired=admin
UninstallDisplayIcon={app}\app\public\favicon.ico
LicenseFile=README.txt

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &Desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Components]
Name: "core"; Description: "JobFinder dashboard (required)"; Types: full compact custom; Flags: fixed
Name: "ollama"; Description: "Install Ollama (local LLM runtime, ~200 MB)"; Types: full compact custom; Flags: checkablealone
Name: "model"; Description: "Set up local AI models (~5 GB - skipped automatically if already installed)"; Types: full

[Files]
; The standalone app: dist\windows\app\* -> C:\Program Files\JobFinder\app\*
Source: "dist\windows\app\*"; DestDir: "{app}\app"; Flags: recursesubdirs ignoreversion; Components: core
; Bundled Node.js runtime
Source: "dist\windows\node\node.exe"; DestDir: "{app}\node"; Flags: ignoreversion; Components: core
; Launcher + helper scripts
Source: "dist\windows\scripts\launcher.bat"; DestDir: "{app}\scripts"; Flags: ignoreversion; Components: core
Source: "dist\windows\scripts\post-install-models.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion; Components: core
; README
Source: "dist\windows\README.txt"; DestDir: "{app}"; Flags: isreadme ignoreversion; Components: core

[Icons]
Name: "{group}\JobFinder";          Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\app\public\favicon.ico"
Name: "{group}\Uninstall JobFinder"; Filename: "{uninstallexe}"
Name: "{autodesktop}\JobFinder";    Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\app\public\favicon.ico"; Tasks: desktopicon

[Run]
; --- Ollama installer (downloaded at install time, not bundled) -----------
; We download the small Ollama installer over HTTPS so we don't bloat this .exe.
; If the download fails (offline install), we skip with a friendly message - the
; user can grab it later from ollama.com/download.
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""if ((Get-Command ollama -ErrorAction SilentlyContinue) -or (Test-Path """"$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"""")) { Write-Host 'Ollama is already installed - skipping download.'; exit 0 }; $ErrorActionPreference='Stop'; $u='https://ollama.com/download/OllamaSetup.exe'; $p=Join-Path $env:TEMP 'OllamaSetup.exe'; try { Invoke-WebRequest -Uri $u -OutFile $p -UseBasicParsing; Start-Process -Wait -FilePath $p -ArgumentList '/SILENT' } catch { Write-Host ('Ollama install skipped: ' + $_.Exception.Message) }"""; \
    StatusMsg: "Checking for Ollama, installing if needed (~200 MB)..."; \
    Flags: runhidden waituntilterminated; \
    Components: ollama

; --- DeepSeek-R1 model pull (optional, ~5 GB) -----------------------------
; This is the long-running step. We invoke the helper PowerShell which streams
; `ollama pull` progress. User can cancel the installer mid-pull - Ollama resumes
; from the last layer on the next attempt.
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\post-install-models.ps1"""; \
    StatusMsg: "Setting up local models - a console window shows progress."; \
    Flags: waituntilterminated; \
    Components: model

; --- Launch on finish (optional) ------------------------------------------
Filename: "{app}\{#MyAppExeName}"; \
    Description: "Launch JobFinder now"; \
    Flags: postinstall skipifsilent nowait

[UninstallDelete]
; Don't delete user data on uninstall. %APPDATA%\JobFinder stays so users keep their
; profiles + sessions + answers across reinstalls.
Type: filesandordirs; Name: "{app}\app\.next\cache"

[Code]
function InitializeSetup(): Boolean;
var
  ChromePath: String;
begin
  Result := True;
  // Friendly informational check for Chrome. Not blocking - user can install Chrome
  // afterwards; JobFinder's `manualLaunch` will throw a clear error if it's missing.
  ChromePath := ExpandConstant('{pf}\Google\Chrome\Application\chrome.exe');
  if not FileExists(ChromePath) then begin
    ChromePath := ExpandConstant('{pf32}\Google\Chrome\Application\chrome.exe');
  end;
  if not FileExists(ChromePath) then begin
    if MsgBox(
      'JobFinder needs Google Chrome installed to scan jobs and submit applications.' + #13#10#13#10 +
      'Chrome was not found on this machine.' + #13#10#13#10 +
      'Continue with JobFinder install anyway?' + #13#10 +
      '(You can install Chrome later from https://www.google.com/chrome)',
      mbConfirmation, MB_YESNO
    ) = IDNO then
      Result := False;
  end;
end;
