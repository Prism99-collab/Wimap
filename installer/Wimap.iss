; Wimap installer. Build with installer\build.ps1, or: ISCC.exe installer\Wimap.iss after publishing to dist\.
; Installs per user by default (no admin prompt); the first page offers "all users" for people who want it.

#define AppName "Wimap"
#define AppExe "Wimap.exe"
#define Source "..\dist\" + AppExe
#define FullVersion GetVersionNumbersString(Source)
#ifndef AppVersion
  ; 1.0.0.0 from the exe becomes 1.0.0
  #define AppVersion Copy(FullVersion, 1, RPos(".", FullVersion) - 1)
#endif

[Setup]
; Keep this AppId forever: Windows uses it to recognise upgrades and the uninstaller.
AppId={{A5D053A9-34BF-4016-894E-2876FF70280E}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Wimap
VersionInfoVersion={#FullVersion}
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} setup
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Windows 10 version 2004 or later, the same floor as the app.
MinVersion=10.0.19041
OutputDir=..\dist
OutputBaseFilename=WimapSetup-{#AppVersion}
SetupIconFile=..\src\Wimap\wimap.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
WizardStyle=modern dynamic
WizardSizePercent=110
Compression=lzma2/max
SolidCompression=yes
; A running Wimap is closed through the Windows Restart Manager before files are replaced:
; interactive setups ask first, silent ones (/VERYSILENT, package managers) close it on their own.
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
#ifdef SignTool
; Pass /DSignTool=name to sign setup and uninstaller with a SignTool defined in the Inno Setup IDE or ISCC /S.
SignTool={#SignTool}
SignedUninstaller=yes
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "{#Source}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; Comment: "Map everything on this PC"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "Open {#AppName}"; Flags: nowait postinstall skipifsilent

[Code]
const
  WebView2Id = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2Url = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';

var
  DownloadPage: TDownloadWizardPage;

{ The WebView2 runtime registers a version under one of these keys (Microsoft's documented check). }
function HasVersion(Root: Integer; Key: String): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(Root, Key, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0');
end;

function WebView2Installed: Boolean;
begin
  Result := HasVersion(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\' + WebView2Id)
    or HasVersion(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WebView2Id)
    or HasVersion(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\' + WebView2Id);
end;

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage('Getting Microsoft Edge WebView2',
    'Wimap draws its window with the WebView2 runtime, which this PC does not have yet.', nil);
end;

{ Windows 11 and current Windows 10 already have WebView2; only older PCs download Microsoft's small bootstrapper. }
function NextButtonClick(CurPageID: Integer): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  if (CurPageID <> wpReady) or WebView2Installed then Exit;
  DownloadPage.Clear;
  DownloadPage.Add(WebView2Url, 'MicrosoftEdgeWebview2Setup.exe', '');
  DownloadPage.Show;
  try
    try
      DownloadPage.Download;
      if not Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode)
        or (ResultCode <> 0) then
        SuppressibleMsgBox('WebView2 could not be installed (code ' + IntToStr(ResultCode) + '). Wimap will be installed, and will show a link to install WebView2 when it starts.',
          mbInformation, MB_OK, IDOK);
    except
      SuppressibleMsgBox('WebView2 could not be downloaded: ' + GetExceptionMessage + #13#10#13#10 +
        'Wimap will be installed, and will show a link to install WebView2 when it starts.', mbInformation, MB_OK, IDOK);
    end;
  finally
    DownloadPage.Hide;
  end;
end;

{ Wimap holds this mutex while it runs. The uninstaller cannot remove an exe that is in use,
  so it asks the user to close Wimap, or in silent mode closes it (politely first, then forcibly). }
function InitializeUninstall: Boolean;
var
  ResultCode, Tries: Integer;
begin
  Result := True;
  while CheckForMutexes('Wimap.App.Running') do
  begin
    if UninstallSilent then
    begin
      Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM Wimap.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      Tries := 0;
      while CheckForMutexes('Wimap.App.Running') and (Tries < 20) do begin Sleep(250); Tries := Tries + 1; end;
      if CheckForMutexes('Wimap.App.Running') then
        Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM Wimap.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      Sleep(500);
      Exit;
    end;
    if MsgBox('Wimap is open. Close it, then click OK to continue removing it.', mbInformation, MB_OKCANCEL) = IDCANCEL then
    begin
      Result := False;
      Exit;
    end;
  end;
end;

{ Saved maps and settings live in %LOCALAPPDATA%\Wimap. They are personal, so removal is the user's choice. }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep <> usPostUninstall then Exit;
  DataDir := ExpandConstant('{localappdata}\Wimap');
  if not DirExists(DataDir) then Exit;
  if UninstallSilent then Exit;
  if MsgBox('Also delete your saved map and Wimap settings?' + #13#10#13#10 + DataDir + #13#10#13#10 +
    'Maps you exported are not affected.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    DelTree(DataDir, True, True, True);
end;
