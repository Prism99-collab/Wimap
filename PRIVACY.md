# Wimap privacy policy

Last updated: November 25, 2026

Wimap is a Windows app that maps what is installed and stored on your PC. This policy explains what it reads, what it keeps, and what it never does.

## Everything stays on your PC

Wimap has no account, no server, no analytics and no ads. It does not send any information about you or your PC anywhere. Nothing it reads leaves your computer unless you export a map and share that file yourself.

The only network activity happens when you ask for it:

- opening a link from the map opens it in your web browser
- if you tick "winget restore file" when exporting, Windows' own winget tool runs, and it may refresh its package list online
- on older PCs without the Microsoft Edge WebView2 runtime, the installer downloaded from GitHub can fetch that runtime from Microsoft

## What Wimap reads

To draw the map, Wimap reads names, sizes, versions and locations of:

- installed programs, from the Windows registry, Microsoft Store packages, and Steam and Epic game libraries, plus the folders those programs live in
- AI tool settings, such as the names of MCP servers, plugins, skills, agents and local models
- browser bookmarks and extension names, for each browser profile
- folders and files in your user folders (Desktop, Documents, Downloads, Pictures, Music, Videos, OneDrive) and the top folders of each drive
- developer tools on your PATH, global npm packages, editor extensions and WSL distributions
- programs that start with Windows, and fonts you installed

## What Wimap never reads

- passwords, saved logins, cookies or browsing history
- browser encryption keys (Wimap does not open the browser's "Local State" file)
- API keys, tokens, environment variables or authentication files of AI tools. For MCP servers Wimap keeps only the server name and the program that starts it, and skips any value that looks like a secret.
- the contents of your documents

Bookmark links are kept, but values in them that look like secrets (for example `token=`, `key=` or `sig=`) and any user name or password in a link are removed.

## What Wimap stores

On your PC, in `%LOCALAPPDATA%\Wimap` (or the Microsoft Store app's own data folder):

- your most recent map, so it opens instantly next time
- your preferences and the window position
- a log file with error messages, used only to diagnose problems

**Settings › Preferences › Forget saved map** deletes the saved map. Uninstalling Wimap from the installer asks whether to delete this folder too.

## Exported files

When you export a map as HTML, JSON or an image, Wimap writes it where you choose. What goes in depends on the options you pick before saving: you can leave out bookmarks, hide your user folder from paths, and drop app icons. Once saved, the file is yours; Wimap does not upload or track it.

## Children

Wimap does not collect personal information from anyone, including children.

## Changes

If this policy changes, the new version will be published at this address with a new date.

## Contact

Questions about privacy: open an issue at https://github.com/Prism99-collab/Wimap/issues, or report a security problem privately as described in [SECURITY.md](SECURITY.md).
