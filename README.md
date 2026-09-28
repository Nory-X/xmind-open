# XMind Open

**English** | [中文](README.zh.md)

Show `.xmind` files in Obsidian's file explorer, preview them inline, and open them in the system default application — **without ever parsing the mindmap**.

---

## The problem

Obsidian only lists a file in the file explorer when its extension is registered in the view registry:

```js
isSupportedFile(file) =
  vault.getConfig('showUnsupportedFiles') || viewRegistry.isExtensionRegistered(file.extension);
```

`.xmind` is not one of the built-in extensions, so your mindmaps are **invisible** in the vault — in the file explorer, the quick switcher and search alike.

Installing a mindmap plugin does not necessarily fix this. A plugin may register a *view* for a file type without registering the *extension*, and those are two different things.

## What this plugin does

| | |
|---|---|
| **Shows** | `.xmind` files appear in the file explorer with an `xmind` tag |
| **Previews** | Renders the map preview XMind stores inside the archive |
| **Opens** | Hands the file to your operating system, so XMind starts as usual |
| **Never** | Parses, reads, or modifies the mindmap data |

## Installation

**Manual**

1. Download or clone this repository.
2. Copy the folder into `<your vault>/.obsidian/plugins/xmind-open/`.
3. In Obsidian, reload the plugins list (Settings → Community plugins), then enable **XMind Open**.

Desktop only (Windows, macOS, Linux). Opening a file in an external application is not available on mobile.

## Usage

Click any `.xmind` file. A tab opens with the map preview and an **Open with system default app** button.

You can also right-click the file in the explorer and pick **Open with system default app** from the context menu.

## Settings

| Setting | Default | Description |
|---|---|---|
| **Open with the system app automatically** | off | Off, the tab shows the preview and waits for a click. On, opening a file launches the system application immediately. |
| **Show preview image** | on | Renders the preview image stored inside the archive. |
| **XMind executable path** | *(empty)* | Leave empty to use the OS file association. Set a path only if that association is missing or has been taken over by another program. |

### About the executable path

By default the plugin **never looks for XMind**. It hands the *file* to the operating system, which resolves `.xmind` through its own file association — so the plugin works regardless of where XMind is installed, and needs no configuration.

That design has one failure mode: if nothing is associated with `.xmind`, or another program has claimed it, opening does nothing useful. For those cases the settings accept an explicit path, and the **Auto-detect** button will look for it by:

1. reading the current `.xmind` association from the registry (`HKCR\.xmind` → `shell\open\command`), then
2. checking the usual install locations (`%ProgramFiles%`, `%ProgramFiles(x86)%`, `%LOCALAPPDATA%`, …).

A detected path is only accepted if the file actually exists, so a stale registry entry is never adopted.

When a path **is** configured it takes priority, and a failure to launch reports the reason instead of silently falling back — otherwise a broken configuration would look like it worked.

## How the preview works

An `.xmind` file is a plain ZIP archive, and XMind stores a pre-rendered image of the map at `Thumbnails/thumbnail.png`. Showing it therefore requires reading **one entry out of a ZIP** — not understanding the XMind document format. The mindmap data (`content.json`) is never opened.

The plugin ships a small ZIP reader (locate the End Of Central Directory, walk the central directory, inflate the single deflate entry) rather than bundling a library, since the plugin is a single file with no build step.

Everything degrades quietly. A missing preview entry, a corrupted archive, or an oversized image simply means *no picture this time* — the file still opens normally.

## Permissions and system access

To do its job the plugin touches a few things outside your vault. They are listed
here rather than buried in the settings.

| What | Why |
|---|---|
| Reads `Thumbnails/thumbnail.png` from the `.xmind` file you open | That is the preview image XMind itself stores. Nothing else inside the archive is read. |
| Resolves the absolute path of that file | The operating system needs a real path before it can open anything. |
| Launches the application associated with `.xmind` | This is the plugin's main action — opening your mindmap in XMind. |
| **Optionally** launches one specific executable that you configure | Only if you fill in **XMind executable path**. Leave it empty and the plugin never runs anything you did not ask for. |

It does not walk directories, does not read other files inside or outside your
vault, and does not upload anything anywhere.

## Privacy

- No network requests, ever.
- Nothing is written to your vault.
- From each `.xmind` file you open, exactly one entry (`Thumbnails/thumbnail.png`) is read, and the decoded result is cached **in memory only**, keyed by path and modification time.

## Language

The interface follows Obsidian's own language setting: Chinese for a Chinese UI, English for everything else.

## Development

The plugin is a single CommonJS file with no build step. `main.js` is the only entry point Obsidian loads.

An offline test suite lives in `tests/`. It runs the real plugin code against a stubbed `obsidian` module and a jsdom document, so no Obsidian installation is needed:

```bash
# 88 assertions: extension registration, the view, the opening chain,
# thumbnail extraction, custom-path handling and localisation
node tests/run-tests.js

# 20 mutants: each one deliberately breaks a behaviour, and the suite
# must fail — otherwise the corresponding test proves nothing
node tests/mutate.js

# cross-check the ZIP reader against a real .xmind file, comparing the
# extracted bytes with Python's zipfile
node tests/verify-thumbnail.js /path/to/file.xmind
```

`npm install` pulls in jsdom, the only development dependency — the plugin itself ships with none.

## License

MIT — see [LICENSE](LICENSE).
