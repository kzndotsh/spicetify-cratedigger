/// <reference path="./globals.d.ts" />

(function cratedigger() {
  const { Player, Platform, Mousetrap, LocalStorage, Menu, PopupModal, Playbar, showNotification } =
    Spicetify;

  // Spicetify injects the script before Player/Platform/Mousetrap exist.
  const READY_POLL_MS = 100;

  if (!Player || !Platform || !Mousetrap) {
    setTimeout(cratedigger, READY_POLL_MS);
    return;
  }

  /** @typedef {{ uri: string, name: string }} Slot */
  /** @typedef {Record<string, Slot | null>} Slots */
  /** @typedef {{ likeCleaner: boolean }} Settings */
  /** @typedef {{ uri: string, name: string }} Playlist */

  // ─── Config ───
  // Theme: --spice-button-disabled equals text; --spice-misc is #000. Never use either.

  const CONFIG = {
    title: "Crate Digger",
    slotKeys: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    storage: {
      slots: "cratedigger:slots",
      settings: "cratedigger:settings",
    },
    timing: {
      readyPollMs: READY_POLL_MS,
      mountRetryMs: 400,
      pickerBlurMs: 150, // input blur vs list mousedown
      hudFlashMs: 400,
    },
    library: {
      pageSize: 10000,
      playlistFilter: "2", // Spotify LibraryAPI: playlists
    },
    selectors: {
      seekBar: ".playback-bar",
      progressBar: '[data-testid="playback-progressbar"]',
      playerControls: ".player-controls",
      nowPlayingBar: ".Root__now-playing-bar",
    },
    theme: {
      surface: "var(--spice-card, #16161e)",
      text: "var(--spice-subtext, #c0caf5)",
      muted: "#565f89", // not --spice-misc (black) or --spice-button-disabled (same as text)
      hover: "var(--spice-tab-active, #27384e)",
      border: "var(--spice-notification, #414868)",
      accent: "var(--spice-button, #2ac3de)",
      radius: "4px",
    },
    picker: {
      zIndex: 100000, // above Spotify's playbar / modal chrome
      gapPx: 4,
      viewportPadPx: 8,
      minHeightPx: 140,
      maxHeightPx: 280,
      clearWidthPx: 32,
    },
    hud: {
      id: "cratedigger-hud",
      chipMaxWidth: "9.5em",
      fontSize: "11px",
      unboundLabel: "—",
      chipGap: "4px",
      chipPadding: "2px 6px",
      barGap: "2px 4px",
      barPadding: "2px 8px 4px",
    },
    membership: {
      iconSize: 16,
      fontSize: "12px",
      emptyLabel: "Not in a crate slot",
      widgetPadding: "0 4px",
    },
    ui: {
      fieldPadding: "6px 8px",
      controlGap: "6px",
      rowGap: "12px",
      rowMargin: "8px 0",
      sectionGap: "16px",
      hintSize: "12px",
      modalMaxHeight: "70vh",
      checkboxNudge: "3px",
      slotLabelWidth: "1.5em",
      slotLabelNudge: "6px",
      listItemPadding: "8px",
      listPad: "4px 0",
      toggleGap: "10px",
      countGap: "12px",
      pickerShadow: "0 12px 32px rgba(0, 0, 0, 0.55)",
    },
  };

  const SLOT_KEYS = CONFIG.slotKeys;
  const THEME = CONFIG.theme;

  /** @type {Map<string, Set<string>>} */
  const playlistTracks = new Map();
  let closeActivePicker = () => {};
  /** @type {{ widget: InstanceType<typeof Playbar.Widget>, label: HTMLSpanElement } | null} */
  let membershipUi = null;
  let membershipGen = 0; // drop stale membership checks after a fast skip

  /**
   * @param {string} tag
   * @param {{ style?: Partial<CSSStyleDeclaration>, text?: string, children?: Node[], dataset?: Record<string, string>, on?: Record<string, EventListener> } & Record<string, unknown>} [opts]
   */
  function el(tag, opts = {}) {
    const node = document.createElement(tag);
    const { style, text, children, dataset, on, ...props } = opts;
    if (text != null) node.textContent = text;
    if (style) Object.assign(node.style, style);
    if (dataset) Object.assign(node.dataset, dataset);
    for (const [key, value] of Object.entries(props)) {
      if (value != null) node[key] = value;
    }
    if (on) {
      for (const [event, handler] of Object.entries(on)) {
        node.addEventListener(event, handler);
      }
    }
    if (children) for (const child of children) node.appendChild(child);
    return node;
  }

  function fieldStyle(node) {
    Object.assign(node.style, {
      background: THEME.surface,
      color: THEME.text,
      border: "1px solid " + THEME.border,
      borderRadius: THEME.radius,
    });
    return node;
  }

  function errorMessage(err) {
    return String(err?.message || err);
  }

  function notify(message, isError) {
    showNotification(message, Boolean(isError));
  }

  function currentTrackUri() {
    return Player.data?.item?.uri || "";
  }

  function itemTrackUri(item) {
    return item?.uri || item?.itemMetadata?.uri || "";
  }

  function formatSlotTag(key) {
    return "[" + key + "]";
  }

  // ─── Storage ───
  // LocalStorageAPI is per Spotify account. LocalStorage is the unscoped fallback.

  function storageGet(key) {
    try {
      const api = Platform.LocalStorageAPI;
      const raw = api?.getItem ? api.getItem(key) : LocalStorage.get(key);
      if (raw == null || raw === "") return null;
      // LocalStorageAPI may already return an object; LocalStorage is always a string.
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (err) {
      console.error("cratedigger: storageGet", key, err);
      return null;
    }
  }

  function storageSet(key, value) {
    if (Platform.LocalStorageAPI?.setItem) {
      Platform.LocalStorageAPI.setItem(key, value);
      return;
    }
    LocalStorage.set(key, JSON.stringify(value));
  }

  function loadSettings() {
    const parsed = storageGet(CONFIG.storage.settings);
    return { likeCleaner: Boolean(parsed?.likeCleaner) };
  }

  function saveSettings(settings) {
    storageSet(CONFIG.storage.settings, settings);
  }

  function loadSlots() {
    return storageGet(CONFIG.storage.slots) || {};
  }

  function saveSlots(slots) {
    storageSet(CONFIG.storage.slots, slots);
    playlistTracks.clear();
    renderHud();
    refreshMembership();
  }

  // ─── Playlists ───
  // RootlistAPI walks folders. Top-level LibraryAPI misses nested playlists.

  function playlistName(item) {
    return item.name || item.title || item.uri || "";
  }

  function isPlaylistType(type) {
    return type === "playlist" || type === "playlist-v2";
  }

  function flattenPlaylists(node, out) {
    const items = node?.items || node?.rows || (Array.isArray(node) ? node : []);
    for (const item of items) {
      if (isPlaylistType(item.type)) {
        if (item.canAddTo === false) continue;
        const uri = item.uri || item.link;
        if (uri) out.push({ uri, name: playlistName(item) });
      } else if (item.type === "folder") {
        flattenPlaylists(item, out);
      }
    }
  }

  async function fetchFromLibrary(folderUri) {
    const res = await Platform.LibraryAPI.getContents({
      offset: 0,
      limit: CONFIG.library.pageSize,
      filters: [CONFIG.library.playlistFilter],
      folderUri: folderUri || "",
      includeLikedSongs: false,
      includeLocalFiles: false,
    });
    const out = [];
    for (const item of res?.items ?? []) {
      if (item.type === "playlist" && item.canAddTo !== false) {
        out.push({ uri: item.uri, name: playlistName(item) });
      } else if (item.type === "folder") {
        out.push(...(await fetchFromLibrary(item.uri)));
      }
    }
    return out;
  }

  function dedupePlaylists(playlists) {
    const byUri = new Map();
    for (const playlist of playlists) {
      if (!byUri.has(playlist.uri)) byUri.set(playlist.uri, playlist);
    }
    return [...byUri.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
  }

  async function fetchWritablePlaylists() {
    try {
      const collected = [];
      if (Platform.RootlistAPI?.getContents) {
        flattenPlaylists(await Platform.RootlistAPI.getContents(), collected);
      } else if (Platform.LibraryAPI?.getContents) {
        collected.push(...(await fetchFromLibrary("")));
      } else {
        notify("Crate Digger: cannot list playlists", true);
        return [];
      }
      return dedupePlaylists(collected);
    } catch (err) {
      notify(errorMessage(err), true);
      return [];
    }
  }

  function applyLikeCleaner(message) {
    if (!loadSettings().likeCleaner || !Player.getHeart()) return message;
    Player.setHeart(false);
    return message + " · unliked";
  }

  async function addCurrentToSlot(slotKey, skipAfter) {
    const trackUri = currentTrackUri();
    if (!trackUri) {
      notify("No track playing", true);
      return;
    }

    const slot = loadSlots()[slotKey];
    if (!slot?.uri) {
      notify("Slot " + slotKey + " is unbound", true);
      return;
    }

    if (!Platform.PlaylistAPI?.add) {
      notify("Crate Digger: PlaylistAPI missing", true);
      return;
    }

    try {
      await Platform.PlaylistAPI.add(slot.uri, [trackUri], { after: "end" });
      playlistTracks.get(slot.uri)?.add(trackUri);
      notify(applyLikeCleaner("Added to " + (slot.name || "playlist")));
      flashHudSlot(slotKey);
      refreshMembership();
      if (skipAfter) Player.next();
    } catch (err) {
      notify(errorMessage(err), true);
    }
  }

  // ─── Picker ───
  // Native <select> clips inside PopupModal. Dropdown is position:fixed on document.body.

  function positionListBelow(list, input) {
    const rect = input.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - CONFIG.picker.viewportPadPx;
    const maxHeight = Math.min(
      CONFIG.picker.maxHeightPx,
      Math.max(CONFIG.picker.minHeightPx, spaceBelow)
    );
    Object.assign(list.style, {
      left: rect.left + "px",
      width: rect.width + "px",
      top: rect.bottom + CONFIG.picker.gapPx + "px",
      maxHeight: maxHeight + "px",
    });
  }

  /**
   * @param {Playlist[]} playlists
   * @param {Slot | null | undefined} current
   * @param {(slot: Slot | null) => void} onChange
   */
  function createPicker(playlists, current, onChange) {
    const input = fieldStyle(
      el("input", {
        type: "search",
        autocomplete: "off",
        placeholder: "Search playlists…",
        value: current?.name || "",
        style: { flex: "1", minWidth: "0", padding: CONFIG.ui.fieldPadding, colorScheme: "dark" }, // native search chrome
      })
    );

    const clear = fieldStyle(
      el("button", {
        type: "button",
        text: "×",
        title: "Unbind",
        style: { width: CONFIG.picker.clearWidthPx + "px", cursor: "pointer" },
      })
    );

    const list = fieldStyle(
      el("div", {
        style: {
          display: "none",
          position: "fixed",
          zIndex: String(CONFIG.picker.zIndex),
          overflowY: "auto",
          padding: CONFIG.ui.listPad,
          boxShadow: CONFIG.ui.pickerShadow,
        },
      })
    );

    function setBound(slot) {
      current = slot;
      input.value = slot?.name || "";
      onChange(slot);
    }

    function hideList() {
      list.style.display = "none";
      list.remove();
    }

    function matchesQuery(filter) {
      const query = (filter || "").trim().toLowerCase();
      if (!query) return playlists;
      return playlists.filter(
        (playlist) =>
          playlist.name.toLowerCase().includes(query) || playlist.uri.toLowerCase().includes(query)
      );
    }

    function renderList(filter) {
      list.replaceChildren();
      const matches = matchesQuery(filter);
      list.appendChild(
        el("div", {
          text: matches.length + " playlist" + (matches.length === 1 ? "" : "s"),
          style: { padding: "4px 8px", color: THEME.muted, fontSize: CONFIG.ui.hintSize },
        })
      );
      if (matches.length === 0) {
        list.appendChild(
          el("div", { text: "No matches", style: { padding: CONFIG.ui.listItemPadding, color: THEME.muted } })
        );
        return;
      }
      for (const playlist of matches) {
        const selected = current?.uri === playlist.uri;
        const btn = el("button", {
          type: "button",
          text: playlist.name,
          style: {
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: CONFIG.ui.listItemPadding,
            border: "none",
            background: selected ? THEME.hover : "transparent",
            color: THEME.text,
            cursor: "pointer",
          },
        });
        btn.addEventListener("mouseenter", () => {
          btn.style.background = THEME.hover;
        });
        btn.addEventListener("mouseleave", () => {
          btn.style.background = current?.uri === playlist.uri ? THEME.hover : "transparent";
        });
        btn.addEventListener("mousedown", (event) => {
          event.preventDefault(); // keep focus; blur would close the list first
          setBound(playlist);
          hideList();
        });
        list.appendChild(btn);
      }
    }

    function showList() {
      closeActivePicker(); // one dropdown at a time
      const typing = input.value !== (current?.name || "");
      renderList(typing ? input.value : "");
      document.body.appendChild(list);
      list.style.display = "block";
      positionListBelow(list, input);
      closeActivePicker = hideList;
    }

    input.addEventListener("focus", showList);
    input.addEventListener("input", () => {
      if (list.style.display === "none" || !list.isConnected) showList();
      else {
        renderList(input.value);
        positionListBelow(list, input);
      }
    });
    input.addEventListener("blur", () => {
      setTimeout(() => {
        hideList();
        input.value = current?.name || "";
      }, CONFIG.timing.pickerBlurMs);
    });
    clear.addEventListener("click", () => {
      setBound(null);
      hideList();
    });

    return el("div", {
      style: { flex: "1", minWidth: "0" },
      children: [
        el("div", {
          style: { display: "flex", gap: CONFIG.ui.controlGap },
          children: [input, clear],
        }),
      ],
    });
  }

  function createLikeCleanerToggle() {
    const box = el("input", {
      type: "checkbox",
      checked: loadSettings().likeCleaner,
      style: { marginTop: CONFIG.ui.checkboxNudge },
    });
    box.addEventListener("change", () => {
      saveSettings({ ...loadSettings(), likeCleaner: box.checked });
    });
    return el("label", {
      style: {
        display: "flex",
        alignItems: "flex-start",
        gap: CONFIG.ui.toggleGap,
        marginBottom: CONFIG.ui.sectionGap,
        cursor: "pointer",
      },
      children: [
        box,
        el("span", {
          children: [
            el("div", { text: "Like cleaner", style: { fontWeight: "600" } }),
            el("div", {
              text: "Unlike after sorting a liked track into a playlist",
              style: { color: THEME.muted, fontSize: CONFIG.ui.hintSize },
            }),
          ],
        }),
      ],
    });
  }

  function createSlotRow(key, playlists, current) {
    return el("div", {
      style: { display: "flex", alignItems: "flex-start", gap: CONFIG.ui.rowGap, margin: CONFIG.ui.rowMargin },
      children: [
        el("span", {
          text: key,
          style: {
            width: CONFIG.ui.slotLabelWidth,
            marginTop: CONFIG.ui.slotLabelNudge,
            fontWeight: "700",
            fontVariantNumeric: "tabular-nums",
          },
        }),
        createPicker(playlists, current, (slot) => {
          const next = loadSlots();
          next[key] = slot;
          saveSlots(next);
        }),
      ],
    });
  }

  async function openSettings() {
    closeActivePicker();
    const root = el("div", {
      style: { color: THEME.text, padding: "4px 0", maxHeight: CONFIG.ui.modalMaxHeight, overflowY: "auto" },
    });
    root.appendChild(
      el("p", {
        text: "Type to search. Number key adds to that playlist. Shift+number adds and skips.",
        style: { color: THEME.muted, marginBottom: CONFIG.ui.sectionGap },
      })
    );
    root.appendChild(createLikeCleanerToggle());
    const loading = el("p", { text: "Loading playlists…" });
    root.appendChild(loading);

    PopupModal.display({ title: CONFIG.title, content: root, isLarge: true });

    const slots = loadSlots();
    const playlists = await fetchWritablePlaylists();
    loading.remove();
    root.appendChild(
      el("p", {
        text: playlists.length + " playlists",
        style: { color: THEME.muted, marginBottom: CONFIG.ui.countGap },
      })
    );
    for (const key of SLOT_KEYS) {
      root.appendChild(createSlotRow(key, playlists, slots[key]));
    }
  }

  // ─── Keys ───
  // Left/Right: stock Spotify shortcuts are broken on Linux.

  function bindPrevent(trap, combo, handler) {
    trap.bind(combo, (event) => {
      event.preventDefault();
      handler();
      return false;
    });
  }

  function bindKeys() {
    const trap = Mousetrap;
    for (const key of SLOT_KEYS) {
      bindPrevent(trap, key, () => addCurrentToSlot(key, false));
      bindPrevent(trap, "shift+" + key, () => addCurrentToSlot(key, true));
    }
    bindPrevent(trap, "left", () => Player.back());
    bindPrevent(trap, "right", () => Player.next());
    bindPrevent(trap, "l", () => {
      const wasLiked = Player.getHeart();
      Player.setHeart(!wasLiked);
      notify(wasLiked ? "Unliked" : "Liked");
    });
  }

  // ─── HUD ───
  // Insert before .player-controls (seek is below them). Inserting before .playback-bar
  // puts the chips between play buttons and the slider.

  function findSeekBar() {
    return (
      document.querySelector(CONFIG.selectors.seekBar) ||
      document.querySelector(CONFIG.selectors.progressBar)?.closest(CONFIG.selectors.seekBar)
    );
  }

  function findHudAnchor() {
    const controls = document.querySelector(CONFIG.selectors.playerControls);
    const seek = findSeekBar();
    if (controls && seek && controls.parentElement === seek.parentElement) {
      const seekFirst = controls.compareDocumentPosition(seek) & Node.DOCUMENT_POSITION_PRECEDING;
      return seekFirst ? seek : controls;
    }
    return controls || seek;
  }

  function flashHudSlot(slotKey) {
    const chip = document.querySelector("#" + CONFIG.hud.id + ' [data-slot="' + slotKey + '"]');
    if (!chip) return;
    chip.style.background = THEME.hover;
    chip.style.outline = "1px solid " + THEME.accent;
    setTimeout(() => {
      chip.style.background = "transparent";
      chip.style.outline = "none";
    }, CONFIG.timing.hudFlashMs);
  }

  function createHudChip(key, slot) {
    const bound = Boolean(slot?.uri);
    return el("button", {
      type: "button",
      dataset: { slot: key },
      title: bound ? "Slot " + key + ": " + slot.name : "Slot " + key + " unbound — click to bind",
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: CONFIG.hud.chipGap,
        maxWidth: CONFIG.hud.chipMaxWidth,
        padding: CONFIG.hud.chipPadding,
        border: "none",
        borderRadius: THEME.radius,
        background: "transparent",
        color: bound ? THEME.text : THEME.muted,
        cursor: "pointer",
        font: "inherit",
        fontSize: CONFIG.hud.fontSize,
        lineHeight: "1.2",
        whiteSpace: "nowrap",
        overflow: "hidden",
      },
      on: { click: () => openSettings() },
      children: [
        el("span", {
          text: formatSlotTag(key),
          style: {
            color: bound ? THEME.accent : THEME.muted,
            fontWeight: "700",
            fontVariantNumeric: "tabular-nums",
          },
        }),
        el("span", {
          text: slot?.name || CONFIG.hud.unboundLabel,
          style: { minWidth: "0", overflow: "hidden", textOverflow: "ellipsis" },
        }),
      ],
    });
  }

  function renderHud() {
    const hud = document.getElementById(CONFIG.hud.id);
    if (!hud) return;
    const slots = loadSlots();
    hud.replaceChildren();
    for (const key of SLOT_KEYS) hud.appendChild(createHudChip(key, slots[key]));
  }

  function ensureHud() {
    let hud = document.getElementById(CONFIG.hud.id);
    if (hud) return hud;
    return el("div", {
      id: CONFIG.hud.id,
      style: {
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        alignItems: "center",
        gap: CONFIG.hud.barGap,
        width: "100%",
        padding: CONFIG.hud.barPadding,
        boxSizing: "border-box",
        pointerEvents: "auto",
      },
    });
  }

  function mountHud() {
    const hud = ensureHud();
    const anchor = findHudAnchor();
    if (!anchor?.parentElement) {
      setTimeout(mountHud, CONFIG.timing.mountRetryMs);
      return;
    }
    if (hud.parentElement !== anchor.parentElement || hud.nextElementSibling !== anchor) {
      anchor.parentElement.insertBefore(hud, anchor);
    }
    renderHud();
  }

  function watchNowPlayingBar() {
    const root = document.querySelector(CONFIG.selectors.nowPlayingBar);
    if (!root) {
      setTimeout(watchNowPlayingBar, CONFIG.timing.mountRetryMs);
      return;
    }
    // Spotify rebuilds the playbar on navigation; reattach if the HUD is orphaned.
    new MutationObserver(() => {
      const anchor = findHudAnchor();
      const hud = document.getElementById(CONFIG.hud.id);
      if (anchor && (!hud || hud.nextElementSibling !== anchor)) mountHud();
    }).observe(root, { childList: true, subtree: true });
  }

  // ─── Membership ───
  // Playbar.Widget sits next to Like. Constructor requires an icon; we strip the SVG and show slot tags.

  function blankWidgetIcon() {
    const size = CONFIG.membership.iconSize;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + " " + size + '"></svg>';
  }

  function ensureMembershipUi() {
    if (membershipUi) return membershipUi;
    if (!Playbar?.Widget) return null;
    const widget = new Playbar.Widget(CONFIG.membership.emptyLabel, blankWidgetIcon(), () => {}, false, false);
    widget.element.querySelector("svg")?.remove();
    Object.assign(widget.element.style, {
      width: "auto",
      minWidth: "0",
      padding: CONFIG.membership.widgetPadding,
      display: "none",
    });
    const label = el("span", {
      style: {
        fontVariantNumeric: "tabular-nums",
        fontWeight: "700",
        fontSize: CONFIG.membership.fontSize,
        color: THEME.accent,
        letterSpacing: "0.02em",
      },
    });
    widget.element.appendChild(label);
    membershipUi = { widget, label };
    return membershipUi;
  }

  function hideMembership(ui) {
    ui.widget.label = CONFIG.membership.emptyLabel;
    ui.widget.element.style.display = "none";
    ui.label.textContent = "";
  }

  async function collectPlaylistUris(playlistUri) {
    const uris = new Set();
    const api = Platform.PlaylistAPI;
    if (!api?.getContents) return uris;
    const res = await api.getContents(playlistUri);
    for (const item of res?.items || []) {
      const uri = itemTrackUri(item);
      if (uri) uris.add(uri);
    }
    const total = res?.totalLength;
    const pageSize = res?.limit || (res?.items || []).length;
    if (!total || !pageSize || (res?.items || []).length >= total) return uris;
    for (let offset = (res.items || []).length; offset < total; offset += pageSize) {
      try {
        const page = await api.getContents(playlistUri, { offset, limit: pageSize });
        for (const item of page?.items || []) {
          const uri = itemTrackUri(item);
          if (uri) uris.add(uri);
        }
        if (!(page?.items || []).length) break;
      } catch {
        break;
      }
    }
    return uris;
  }

  async function loadPlaylistTracks(playlistUri) {
    try {
      const uris = await collectPlaylistUris(playlistUri);
      playlistTracks.set(playlistUri, uris);
      return uris;
    } catch (err) {
      console.error("cratedigger: getContents", playlistUri, err);
      const empty = new Set();
      playlistTracks.set(playlistUri, empty);
      return empty;
    }
  }

  function parseContainsResult(res, trackUri) {
    // PlaylistAPI.contains is untyped: boolean, boolean[], or { [uri]: boolean }.
    if (Array.isArray(res)) return Boolean(res[0]);
    if (res && typeof res === "object") return Boolean(res[trackUri]);
    return Boolean(res);
  }

  async function playlistHasTrack(playlistUri, trackUri) {
    const api = Platform.PlaylistAPI;
    if (typeof api?.contains === "function") {
      try {
        return parseContainsResult(await api.contains(playlistUri, [trackUri]), trackUri);
      } catch (err) {
        console.warn("cratedigger: contains", err);
      }
    }
    const cached = playlistTracks.get(playlistUri) || (await loadPlaylistTracks(playlistUri));
    return cached.has(trackUri);
  }

  async function slotKeysForTrack(trackUri, slots) {
    const hits = [];
    await Promise.all(
      SLOT_KEYS.map(async (key) => {
        const slot = slots[key];
        if (!slot?.uri) return;
        if (await playlistHasTrack(slot.uri, trackUri)) hits.push(key);
      })
    );
    hits.sort((a, b) => SLOT_KEYS.indexOf(a) - SLOT_KEYS.indexOf(b));
    return hits;
  }

  async function refreshMembership() {
    const ui = ensureMembershipUi();
    if (!ui) return;
    const gen = ++membershipGen;
    const trackUri = currentTrackUri();
    const slots = loadSlots();
    if (!trackUri) {
      hideMembership(ui);
      return;
    }
    const hits = await slotKeysForTrack(trackUri, slots);
    if (gen !== membershipGen) return; // skipped while this request was in flight
    ui.widget.element.querySelector("svg")?.remove();
    if (!ui.label.isConnected) ui.widget.element.appendChild(ui.label);
    if (!hits.length) {
      hideMembership(ui);
      return;
    }
    ui.label.textContent = hits.map(formatSlotTag).join("");
    ui.widget.label =
      "In " + hits.map((key) => formatSlotTag(key) + " " + (slots[key]?.name || "")).join(", ");
    ui.widget.element.style.display = "";
  }

  function registerMenu() {
    if (!Menu?.Item) return;
    new Menu.Item(CONFIG.title, false, () => openSettings(), "playlist").register();
  }

  bindKeys();
  mountHud();
  watchNowPlayingBar();
  registerMenu();
  Player.addEventListener("songchange", () => refreshMembership());
  refreshMembership();

  if (!Platform.PlaylistAPI) {
    notify("Crate Digger: PlaylistAPI missing — playlist keys disabled", true);
  }
})();
