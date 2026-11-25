# Microsoft Store submission

Everything to paste into Partner Center for Wimap. Fields are in the order the submission pages show them.

## Before the first upload

1. In Partner Center, go to **Apps and games › New product › MSIX or PWA app** and reserve the name **Wimap**.
2. Open **Product management › Product identity** and copy three values:
   - `Package/Identity/Name` (looks like `12345Prism99.Wimap`)
   - `Package/Identity/Publisher` (looks like `CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`)
   - `Package/Properties/PublisherDisplayName`
3. Build the package with them:

```powershell
powershell -File installer\build-msix.ps1 -IdentityName "<Name>" -Publisher "<Publisher>" -PublisherDisplayName "<PublisherDisplayName>"
```

Upload `dist\Wimap-<version>.msix` under **Packages**. The Store signs it, so it is uploaded unsigned.

## Pricing and availability

- Markets: all markets
- Visibility: public
- Price: free, or set a price and a free trial (Microsoft keeps 15% of sales for apps)

## Properties

- Category: **Utilities + tools**
- Subcategory: none
- Privacy policy URL: `https://github.com/Prism99-collab/Wimap/blob/main/PRIVACY.md`
- Website: `https://github.com/Prism99-collab/Wimap`
- Support contact: `https://github.com/Prism99-collab/Wimap/issues`
- Product declarations: tick "This app has been tested to meet accessibility guidelines" only if you agree; leave the others unticked.
- System requirements: Memory 4 GB recommended, x64.

## Age ratings

Answer the questionnaire as a utility with no user interaction, no shared location, no purchases inside the app and no unrestricted web access. The expected rating is 3+ / Everyone.

## Store listing (English)

**Product name:** Wimap

**Short description** (up to 100 characters):

> See everything on your PC as one map, and keep it for your next one.

**Description:**

> Setting up a new PC usually means trying to remember what was on the old one. Wimap scans your PC in a few seconds and draws everything it finds as one map you can search, fold and turn.
>
> It finds your installed apps and the folders they live in, your AI tools with their MCP servers, plugins and skills, browser bookmarks and extensions, your files and drives, developer tools, startup programs and fonts you installed.
>
> When you're done, save the map as a single HTML file that opens offline in any browser. It comes with a reinstall list: every app, extension and tool with a link to get it again, and boxes to tick as you set up the new PC. You can also save the map as a PNG, JPEG or SVG image.
>
> Everything stays on your PC. Wimap has no account and sends nothing anywhere. It reads names, sizes and versions, never passwords, cookies, browsing history or API keys.

**What's new in this version:**

> First release in the Microsoft Store.

**Features** (one per line, up to 20):

> Maps installed apps, Store apps, Steam and Epic games, with their folders
> Finds AI tools: MCP servers, plugins, skills, agents and local models
> Lists browser bookmarks and extensions for every profile
> Search that ignores accents and case, with filters
> Rotate, zoom and fold the map with mouse, keyboard or touch
> Exports one offline HTML file with a reinstall checklist
> Exports PNG, JPEG and SVG images
> Optional winget file to reinstall apps on a new PC
> No account, no tracking, nothing leaves your PC

**Search terms** (up to 7):

> pc map, migration, new pc, installed apps, backup list, mind map, mcp

**Screenshots:** use `docs/map.png`, `docs/search.png` and `docs/reinstall-list.png` (they show a made-up PC called STUDIO, not real data). The Store wants at least one at 1366×768 or larger; these are 1920 wide.

**Store logos:** optional. The package already carries its logos.

## Notes for certification

Paste this into **Submission options › Notes for certification**, and the second paragraph into the justification box that appears for the restricted capability:

> Wimap needs no account or test data. Start it and click "Map this PC"; a scan takes a few seconds and draws a map of the PC. Help › Shortcuts and search lists the controls.
>
> runFullTrust: Wimap is a desktop app (.NET with WebView2) packaged as MSIX. To build the map it reads the Windows registry (installed programs, startup entries, fonts), the folders where programs are installed, other apps' settings files (AI tools, browser bookmark and extension files) and the user's folders. None of this is possible from an app container. Wimap does not modify other apps, does not run code it downloads, and sends no data off the device.
