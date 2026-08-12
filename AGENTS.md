# AGENTS.md

Cursor/repo guide for **Crate Digger** — a Spicetify extension (single IIFE, no bundler).

Public repo: https://github.com/kzndotsh/spicetify-cratedigger  
Marketplace: GitHub topic `spicetify-extensions` + root `manifest.json`.

## What this is

Keyboard crate digging in Spotify: number keys dump the current track into a bound playlist. HUD above the seek bar. Slot numbers next to Like when the track is already in a crate. Optional like-cleaner unlikes after a successful sort.

Not a custom app. Not Spicetify Creator (deprecated). Not an npm package.

## Files

| File | Role |
| ---- | ---- |
| `cratedigger.js` | The extension. Only file Spotify loads. |
| `manifest.json` | Marketplace card (`main` = `cratedigger.js`) |
| `globals.d.ts` | Vendored editor types. Spotify does not load this. See below. |
| `README.md` | User install (Marketplace / manual / Nix) |
| `screenshot.png` | Marketplace preview (1024×1024) |
| `banner.png` | GitHub README hero |
| `LICENSE` | MIT |
| `docs/` | Local research/specs. **Gitignored — do not publish.** |

## `globals.d.ts`

Not generated. Not in Spicetify’s user docs. It is a **vendored copy** of:

https://raw.githubusercontent.com/spicetify/cli/main/globals.d.ts

`cratedigger.js` has `/// <reference path="./globals.d.ts" />` so the editor knows the `Spicetify` namespace. Refresh only when you need types for a newer API:

```bash
curl -s -o globals.d.ts https://raw.githubusercontent.com/spicetify/cli/main/globals.d.ts
```

Upstream updates irregularly (a few times a year, in bursts). No need to chase it for Player / Mousetrap / PlaylistAPI / Playbar / PopupModal.

## Runtime

IIFE waits until `Spicetify.Player`, `Platform`, and `Mousetrap` exist (100ms poll).

| Key | Action |
| --- | ------ |
| `1`–`9`, `0` | Add current track to slot. Stay. |
| `Shift+digit` | Add, then `Player.next()` |
| Left / Right | `Player.back()` / `Player.next()` |
| `L` | Toggle like via `setHeart(!getHeart())` |

Mousetrap ignores `input` / `textarea` / `select`. Unbound slot or no track → error toast, no skip.

Add: `Platform.PlaylistAPI.add(playlistUri, [trackUri], { after: "end" })`.  
Playlists: `RootlistAPI.getContents()` flattened through folders (not top-level `LibraryAPI` only).

Storage (prefer `Platform.LocalStorageAPI`, else `Spicetify.LocalStorage`):

- `cratedigger:slots` — `{ "1": { uri, name } \| null, ... }`
- `cratedigger:settings` — `{ likeCleaner: boolean }` (default off)

Settings UI: profile menu **Crate Digger** → `PopupModal`. HUD chips also open it.

## Tokyo Night (do not “fix”)

Theme `tokyoNight` / `Night` on the desktop host.

- `--spice-button-disabled` **equals text** `#a9b1d6` — never use for hover
- `--spice-misc` is `#000000` — do not use for muted text
- Use `SURFACE #16161e`, `TEXT #c0caf5`, `HOVER #27384e` (`--spice-tab-active`), `MUTED #565f89`

Playlist picker is `position: fixed` on `document.body` (native `<select>` clips). One picker open at a time.

HUD injects as a sibling **before** `.player-controls` (or `.playback-bar` if that comes first), so it sits above the whole play cluster — not between play buttons and the seek bar. Membership widget is `Playbar.Widget` next to Like; hidden when the track is in no bound slot.

## Local desktop (this machine)

Dotfiles flake input is still a **path** while iterating:

```nix
cratedigger.url = "path:/home/unle4rn/Projects/spicetify-cratedigger";
```

`~/.config/spicetify/Extensions` + `spicetify apply` **does not apply** to the wrapped Spotify.

After JS edits:

```bash
cd ~/dotfiles && nix flake update cratedigger && nh os switch ~/dotfiles
```

Then **fully quit and relaunch Spotify** (closing the window is not enough). DevTools: Ctrl+Shift+I (`alwaysEnableDevTools`).

Do not `nh os switch` unless asked. Do not commit unless asked.

## Publishing

- Keep `cratedigger.js` at repo root (`manifest.main` and nix `name` both depend on it)
- Topic must stay `spicetify-extensions`
- Optional later: PR to [Gerg-L/spicetify-nix](https://github.com/Gerg-L/spicetify-nix) — pin in `pkgs/npins/sources.json`, `{ src = sources.cratediggerSrc; name = "cratedigger.js"; }` in `pkgs/extensions.nix`
- Do not add Creator, `dist/`, or a bundler unless the extension stops being one file

## Never

- Spicetify Creator / `npx create-spicetify-app`
- Putting `pkgs.spotify` next to the spicetify module (dotfiles)
- Secrets in this repo
- Publishing `docs/`
- Hand-editing Marketplace; it scrapes GitHub

## When to update this file

Structure, install path, storage keys, flake input, or Marketplace/nix packaging changes.
