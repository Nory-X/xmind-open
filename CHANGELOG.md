# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-09-28

### Added

- Localised interface (Chinese / English) that follows Obsidian's own language setting.
  Chinese for a Chinese UI, English for everything else.
- Chinese README (`README.zh.md`).
- Continuous integration running the test suite and the mutation tests.

### Changed

- `manifest.json` description is now English for the community plugin listing.

## [1.2.0] - 2026-09-27

### Added

- **XMind executable path** setting, for machines where the `.xmind` file association is
  missing or has been taken over by another program. When set, it takes priority, and a
  launch failure reports the reason instead of silently falling back.
- **Auto-detect** button: reads the current `.xmind` association from the registry
  (`HKCR\.xmind` → `shell\open\command`), then checks the common install locations.
  A detected path is only accepted if the file actually exists.

## [1.1.1] - 2026-09-27

### Changed

- `autoOpen` now defaults to **off**. Opening a map shows the preview rather than
  immediately pushing focus into an external window.

## [1.1.0] - 2026-09-27

### Added

- Inline preview of the map, read from `Thumbnails/thumbnail.png` inside the archive.
  Uses a built-in ZIP reader, so the mindmap data is still never parsed.
- `showThumbnail` setting. The preview is clickable and opens the file.
- Preview cache keyed by path and modification time (in memory only).

## [1.0.0] - 2026-09-27

### Added

- `.xmind` is registered as a file type, so these files appear in the file explorer
  (and in the quick switcher and search) instead of being hidden.
- Clicking a file hands it to the OS default application.
- **Open with system default app** entry in the file context menu.
- Graceful degradation when another plugin has already registered `.xmind`.
