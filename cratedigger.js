/// <reference path="./globals.d.ts" />

(function cratedigger() {
  const { Player, Platform, Mousetrap, LocalStorage, Menu, PopupModal, showNotification } =
    Spicetify;

  if (!Player || !Platform || !Mousetrap) {
    setTimeout(cratedigger, 100);
    return;
  }

  const TITLE = "Crate Digger";
  const SLOT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
  const STORAGE_SLOTS = "cratedigger:slots";
  const STORAGE_SETTINGS = "cratedigger:settings";
  const THEME = {
    surface: "var(--spice-card, #16161e)",
    text: "var(--spice-subtext, #c0caf5)",
    muted: "#565f89",
    hover: "var(--spice-tab-active, #27384e)",
    border: "var(--spice-notification, #414868)",
    accent: "var(--spice-button, #2ac3de)",
    radius: "4px",
  };

  const playlistTracks = new Map();
  let closeActivePicker = () => {};
  let membershipEl = null;
  let membershipGen = 0;

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

  function notify(message, isError) {
    showNotification(message, Boolean(isError));
  }

  // LocalStorageAPI is per Spotify account. LocalStorage is the unscoped fallback.
  function storageGet(key) {
    try {
      const api = Platform.LocalStorageAPI;
      const raw = api?.getItem ? api.getItem(key) : LocalStorage.get(key);
      if (raw == null || raw === "") return null;
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
    const parsed = storageGet(STORAGE_SETTINGS);
    return { likeCleaner: Boolean(parsed?.likeCleaner) };
  }

  function loadSlots() {
    return storageGet(STORAGE_SLOTS) || {};
  }

  function saveSlots(slots) {
    storageSet(STORAGE_SLOTS, slots);
    playlistTracks.clear();
    renderHud();
    refreshMembership();
  }

  // RootlistAPI walks folders. Top-level LibraryAPI misses nested playlists.
  function flattenPlaylists(node, out) {
    const items = node?.items || node?.rows || (Array.isArray(node) ? node : []);
    for (const item of items) {
      if (item.type === "playlist" || item.type === "playlist-v2") {
        if (item.canAddTo === false) continue;
        const uri = item.uri || item.link;
        if (uri) out.push({ uri, name: item.name || item.title || uri });
      } else if (item.type === "folder") {
        flattenPlaylists(item, out);
      }
    }
  }

  async function fetchFromLibrary(folderUri) {
    const res = await Platform.LibraryAPI.getContents({
      offset: 0,
      limit: 10000,
      filters: ["2"],
      folderUri: folderUri || "",
      includeLikedSongs: false,
      includeLocalFiles: false,
    });
    const out = [];
    for (const item of res?.items ?? []) {
      if (item.type === "playlist" && item.canAddTo !== false) {
        out.push({ uri: item.uri, name: item.name || item.title || item.uri });
      } else if (item.type === "folder") {
        out.push(...(await fetchFromLibrary(item.uri)));
      }
    }
    return out;
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
      const byUri = new Map();
      for (const playlist of collected) {
        if (!byUri.has(playlist.uri)) byUri.set(playlist.uri, playlist);
      }
      return [...byUri.values()].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      );
    } catch (err) {
      notify(String(err?.message || err), true);
      return [];
    }
  }

  async function addCurrentToSlot(slotKey, skipAfter) {
    const trackUri = Player.data?.item?.uri || "";
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
      let message = "Added to " + (slot.name || "playlist");
      if (loadSettings().likeCleaner && Player.getHeart()) {
        Player.setHeart(false);
        message += " · unliked";
      }
      notify(message);
      flashHudSlot(slotKey);
      refreshMembership();
      if (skipAfter) Player.next();
    } catch (err) {
      notify(String(err?.message || err), true);
    }
  }

  // Native <select> clips inside PopupModal. Dropdown is position:fixed on document.body.
  function positionListBelow(list, input) {
    const rect = input.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const maxHeight = Math.min(280, Math.max(140, spaceBelow));
    Object.assign(list.style, {
      left: rect.left + "px",
      width: rect.width + "px",
      top: rect.bottom + 4 + "px",
      maxHeight: maxHeight + "px",
    });
  }

  function createPicker(playlists, current, onChange) {
    const input = fieldStyle(
      el("input", {
        type: "search",
        autocomplete: "off",
        placeholder: "Search playlists…",
        value: current?.name || "",
        style: { flex: "1", minWidth: "0", padding: "6px 8px", colorScheme: "dark" },
      })
    );

    const clear = fieldStyle(
      el("button", {
        type: "button",
        text: "×",
        title: "Unbind",
        style: { width: "32px", cursor: "pointer" },
      })
    );

    const list = fieldStyle(
      el("div", {
        style: {
          display: "none",
          position: "fixed",
          zIndex: "100000",
          overflowY: "auto",
          padding: "4px 0",
          boxShadow: "0 12px 32px rgba(0, 0, 0, 0.55)",
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
          style: { padding: "4px 8px", color: THEME.muted, fontSize: "12px" },
        })
      );
      if (matches.length === 0) {
        list.appendChild(
          el("div", { text: "No matches", style: { padding: "8px", color: THEME.muted } })
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
            padding: "8px",
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
      closeActivePicker();
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
      }, 150);
    });
    clear.addEventListener("click", () => {
      setBound(null);
      hideList();
    });

    return el("div", {
      style: { flex: "1", minWidth: "0" },
      children: [
        el("div", {
          style: { display: "flex", gap: "6px" },
          children: [input, clear],
        }),
      ],
    });
  }

  function createLikeCleanerToggle() {
    const box = el("input", {
      type: "checkbox",
      checked: loadSettings().likeCleaner,
      style: { marginTop: "3px" },
    });
    box.addEventListener("change", () => {
      storageSet(STORAGE_SETTINGS, { ...loadSettings(), likeCleaner: box.checked });
    });
    return el("label", {
      style: {
        display: "flex",
        alignItems: "flex-start",
        gap: "10px",
        marginBottom: "16px",
        cursor: "pointer",
      },
      children: [
        box,
        el("span", {
          children: [
            el("div", { text: "Like cleaner", style: { fontWeight: "600" } }),
            el("div", {
              text: "Unlike after sorting a liked track into a playlist",
              style: { color: THEME.muted, fontSize: "12px" },
            }),
          ],
        }),
      ],
    });
  }

  function createSlotRow(key, playlists, current) {
    return el("div", {
      style: { display: "flex", alignItems: "flex-start", gap: "12px", margin: "8px 0" },
      children: [
        el("span", {
          text: key,
          style: {
            width: "1.5em",
            marginTop: "6px",
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
      style: { color: THEME.text, padding: "4px 0", maxHeight: "70vh", overflowY: "auto" },
    });
    root.appendChild(
      el("p", {
        text: "Type to search. Number key adds to that playlist. Shift+number adds and skips.",
        style: { color: THEME.muted, marginBottom: "16px" },
      })
    );
    root.appendChild(createLikeCleanerToggle());
    const loading = el("p", { text: "Loading playlists…" });
    root.appendChild(loading);

    PopupModal.display({ title: TITLE, content: root, isLarge: true });

    const slots = loadSlots();
    const playlists = await fetchWritablePlaylists();
    loading.remove();
    root.appendChild(
      el("p", {
        text: playlists.length + " playlists",
        style: { color: THEME.muted, marginBottom: "12px" },
      })
    );
    for (const key of SLOT_KEYS) {
      root.appendChild(createSlotRow(key, playlists, slots[key]));
    }
  }

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

  // Insert before .player-controls (seek is below them). Inserting before .playback-bar
  // puts the chips between play buttons and the slider.
  function findHudAnchor() {
    const controls = document.querySelector(".player-controls");
    const seek =
      document.querySelector(".playback-bar") ||
      document.querySelector('[data-testid="playback-progressbar"]')?.closest(".playback-bar");
    if (controls && seek && controls.parentElement === seek.parentElement) {
      const seekFirst = controls.compareDocumentPosition(seek) & Node.DOCUMENT_POSITION_PRECEDING;
      return seekFirst ? seek : controls;
    }
    return controls || seek;
  }

  function flashHudSlot(slotKey) {
    const chip = document.querySelector('#cratedigger-hud [data-slot="' + slotKey + '"]');
    if (!chip) return;
    chip.style.background = THEME.hover;
    chip.style.outline = "1px solid " + THEME.accent;
    setTimeout(() => {
      chip.style.background = "transparent";
      chip.style.outline = "none";
    }, 400);
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
        gap: "4px",
        maxWidth: "9.5em",
        padding: "2px 6px",
        border: "none",
        borderRadius: THEME.radius,
        background: "transparent",
        color: bound ? THEME.text : THEME.muted,
        cursor: "pointer",
        font: "inherit",
        fontSize: "11px",
        lineHeight: "1.2",
        whiteSpace: "nowrap",
        overflow: "hidden",
      },
      on: { click: () => openSettings() },
      children: [
        el("span", {
          text: "[" + key + "]",
          style: {
            color: bound ? THEME.accent : THEME.muted,
            fontWeight: "700",
            fontVariantNumeric: "tabular-nums",
          },
        }),
        el("span", {
          text: slot?.name || "—",
          style: { minWidth: "0", overflow: "hidden", textOverflow: "ellipsis" },
        }),
      ],
    });
  }

  function renderHud() {
    const hud = document.getElementById("cratedigger-hud");
    if (!hud) return;
    const slots = loadSlots();
    hud.replaceChildren();
    for (const key of SLOT_KEYS) hud.appendChild(createHudChip(key, slots[key]));
  }

  function ensureHud() {
    let hud = document.getElementById("cratedigger-hud");
    if (hud) return hud;
    return el("div", {
      id: "cratedigger-hud",
      style: {
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        alignItems: "center",
        gap: "2px 4px",
        width: "100%",
        padding: "2px 8px 4px",
        boxSizing: "border-box",
        pointerEvents: "auto",
      },
    });
  }

  function mountHud() {
    const hud = ensureHud();
    const anchor = findHudAnchor();
    if (!anchor?.parentElement) {
      setTimeout(mountHud, 400);
      return;
    }
    if (hud.parentElement !== anchor.parentElement || hud.nextElementSibling !== anchor) {
      anchor.parentElement.insertBefore(hud, anchor);
    }
    renderHud();
  }

  function watchNowPlayingBar() {
    const root = document.querySelector(".Root__now-playing-bar");
    if (!root) {
      setTimeout(watchNowPlayingBar, 400);
      return;
    }
    new MutationObserver(() => {
      const anchor = findHudAnchor();
      const hud = document.getElementById("cratedigger-hud");
      if (anchor && (!hud || hud.nextElementSibling !== anchor)) mountHud();
      mountMembership();
    }).observe(root, { childList: true, subtree: true });
  }

  // Playbar.Widget clones heart-button classes. Plain span after Like instead.
  function mountMembership() {
    const host = document.querySelector(".main-nowPlayingWidget-nowPlaying");
    if (!host) return null;
    if (!membershipEl) {
      membershipEl = el("span", {
        id: "cratedigger-membership",
        style: {
          display: "none",
          padding: "0 4px",
          fontSize: "12px",
          fontWeight: "700",
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "0.02em",
          color: THEME.accent,
          lineHeight: "1",
          whiteSpace: "nowrap",
          alignSelf: "center",
          flexShrink: "0",
          pointerEvents: "none",
          userSelect: "none",
        },
      });
    }
    const heart = host.querySelector(".control-button-heart, [data-testid='add-button']");
    if (heart) {
      if (membershipEl.previousElementSibling !== heart) heart.after(membershipEl);
    } else if (membershipEl.parentElement !== host) {
      host.appendChild(membershipEl);
    }
    return membershipEl;
  }

  async function collectPlaylistUris(playlistUri) {
    const uris = new Set();
    const api = Platform.PlaylistAPI;
    if (!api?.getContents) return uris;
    const res = await api.getContents(playlistUri);
    for (const item of res?.items || []) {
      const uri = item?.uri || item?.itemMetadata?.uri || "";
      if (uri) uris.add(uri);
    }
    const total = res?.totalLength;
    const pageSize = res?.limit || (res?.items || []).length;
    if (!total || !pageSize || (res?.items || []).length >= total) return uris;
    for (let offset = (res.items || []).length; offset < total; offset += pageSize) {
      try {
        const page = await api.getContents(playlistUri, { offset, limit: pageSize });
        for (const item of page?.items || []) {
          const uri = item?.uri || item?.itemMetadata?.uri || "";
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

  async function playlistHasTrack(playlistUri, trackUri) {
    const api = Platform.PlaylistAPI;
    if (typeof api?.contains === "function") {
      try {
        const res = await api.contains(playlistUri, [trackUri]);
        if (Array.isArray(res)) return Boolean(res[0]);
        if (res && typeof res === "object") return Boolean(res[trackUri]);
        return Boolean(res);
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
    const node = mountMembership();
    if (!node) {
      setTimeout(refreshMembership, 400);
      return;
    }
    const gen = ++membershipGen;
    const trackUri = Player.data?.item?.uri || "";
    const slots = loadSlots();
    if (!trackUri) {
      node.title = "";
      node.textContent = "";
      node.style.display = "none";
      return;
    }
    const hits = await slotKeysForTrack(trackUri, slots);
    if (gen !== membershipGen) return;
    if (!hits.length) {
      node.title = "";
      node.textContent = "";
      node.style.display = "none";
      return;
    }
    node.textContent = hits.map((key) => "[" + key + "]").join("");
    node.title = "In " + hits.map((key) => "[" + key + "] " + (slots[key]?.name || "")).join(", ");
    node.style.display = "";
  }

  bindKeys();
  mountHud();
  watchNowPlayingBar();
  if (Menu?.Item) new Menu.Item(TITLE, false, () => openSettings(), "playlist").register();
  Player.addEventListener("songchange", () => refreshMembership());
  refreshMembership();

  if (!Platform.PlaylistAPI) {
    notify("Crate Digger: PlaylistAPI missing — playlist keys disabled", true);
  }
})();
