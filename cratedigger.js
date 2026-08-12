/// <reference path="./globals.d.ts" />

(function cratedigger() {
  const { Player, Platform, Mousetrap, LocalStorage, Menu, PopupModal, Playbar, showNotification } =
    Spicetify;

  if (!Player || !Platform || !Mousetrap) {
    setTimeout(cratedigger, 100);
    return;
  }

  const STORAGE_KEY = "cratedigger:slots";
  const SETTINGS_KEY = "cratedigger:settings";
  const SLOT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
  /** @type {Map<string, Set<string>>} */
  const playlistTracks = new Map();

  /** @typedef {{ uri: string, name: string }} Slot */
  /** @typedef {Record<string, Slot | null>} Slots */
  /** @typedef {{ likeCleaner: boolean }} Settings */

  function notify(message, isError) {
    showNotification(message, Boolean(isError));
  }

  /** @returns {Settings} */
  function loadSettings() {
    try {
      const api = Platform.LocalStorageAPI;
      let raw = null;
      if (api && typeof api.getItem === "function") {
        raw = api.getItem(SETTINGS_KEY);
      } else {
        raw = LocalStorage.get(SETTINGS_KEY);
      }
      if (raw == null || raw === "") return { likeCleaner: false };
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return { likeCleaner: Boolean(parsed?.likeCleaner) };
    } catch (e) {
      console.error("cratedigger: loadSettings", e);
      return { likeCleaner: false };
    }
  }

  /** @param {Settings} settings */
  function saveSettings(settings) {
    if (Platform.LocalStorageAPI && typeof Platform.LocalStorageAPI.setItem === "function") {
      Platform.LocalStorageAPI.setItem(SETTINGS_KEY, settings);
      return;
    }
    LocalStorage.set(SETTINGS_KEY, JSON.stringify(settings));
  }

  /** @returns {Slots} */
  function loadSlots() {
    try {
      const api = Platform.LocalStorageAPI;
      if (api && typeof api.getItem === "function") {
        const raw = api.getItem(STORAGE_KEY);
        if (raw == null || raw === "") return {};
        return typeof raw === "string" ? JSON.parse(raw) : raw;
      }
      const raw = LocalStorage.get(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.error("cratedigger: loadSlots", e);
      return {};
    }
  }

  /** @param {Slots} slots */
  function saveSlots(slots) {
    if (Platform.LocalStorageAPI && typeof Platform.LocalStorageAPI.setItem === "function") {
      Platform.LocalStorageAPI.setItem(STORAGE_KEY, slots);
    } else {
      LocalStorage.set(STORAGE_KEY, JSON.stringify(slots));
    }
    renderHud();
    playlistTracks.clear();
    refreshMembership();
  }

  /**
   * @param {string} slotKey
   * @param {boolean} skipAfter
   */
  async function addCurrentToSlot(slotKey, skipAfter) {
    const trackUri = Player.data?.item?.uri;
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
      let msg = "Added to " + (slot.name || "playlist");
      if (loadSettings().likeCleaner && Player.getHeart()) {
        Player.setHeart(false);
        msg += " · unliked";
      }
      notify(msg);
      flashHudSlot(slotKey);
      refreshMembership();
      if (skipAfter) Player.next();
    } catch (e) {
      notify(String(e?.message || e), true);
    }
  }

  function playlistName(item) {
    return item.name || item.title || item.uri || "";
  }

  function flattenPlaylists(node, out) {
    const items = node?.items || node?.rows || (Array.isArray(node) ? node : []);
    for (const item of items) {
      const type = item.type;
      if (type === "playlist" || type === "playlist-v2") {
        if (item.canAddTo === false) continue;
        const uri = item.uri || item.link;
        if (uri) out.push({ uri, name: playlistName(item) });
      } else if (type === "folder") {
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
        out.push({ uri: item.uri, name: playlistName(item) });
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
        const root = await Platform.RootlistAPI.getContents();
        flattenPlaylists(root, collected);
      } else if (Platform.LibraryAPI?.getContents) {
        collected.push(...(await fetchFromLibrary("")));
      } else {
        notify("Crate Digger: cannot list playlists", true);
        return [];
      }

      const byUri = new Map();
      for (const pl of collected) {
        if (!byUri.has(pl.uri)) byUri.set(pl.uri, pl);
      }
      return [...byUri.values()].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      );
    } catch (e) {
      notify(String(e?.message || e), true);
      return [];
    }
  }

  const SURFACE = "var(--spice-card, #16161e)";
  const TEXT = "var(--spice-subtext, #c0caf5)";
  const MUTED = "#565f89";
  const HOVER = "var(--spice-tab-active, #27384e)";
  const BORDER = "var(--spice-notification, #414868)";

  function fieldStyle(el) {
    el.style.background = SURFACE;
    el.style.color = TEXT;
    el.style.border = "1px solid " + BORDER;
    el.style.borderRadius = "4px";
  }

  let closeActivePicker = () => {};

  /**
   * @param {Array<{uri: string, name: string}>} playlists
   * @param {Slot | null | undefined} current
   * @param {(slot: Slot | null) => void} onChange
   */
  function createPicker(playlists, current, onChange) {
    const wrap = document.createElement("div");
    wrap.style.flex = "1";
    wrap.style.minWidth = "0";

    const controls = document.createElement("div");
    controls.style.display = "flex";
    controls.style.gap = "6px";

    const input = document.createElement("input");
    input.type = "search";
    input.autocomplete = "off";
    input.placeholder = "Search playlists…";
    input.value = current?.name || "";
    input.style.flex = "1";
    input.style.minWidth = "0";
    input.style.padding = "6px 8px";
    input.style.colorScheme = "dark";
    fieldStyle(input);

    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "×";
    clear.title = "Unbind";
    clear.style.width = "32px";
    clear.style.cursor = "pointer";
    fieldStyle(clear);

    const list = document.createElement("div");
    list.style.display = "none";
    list.style.position = "fixed";
    list.style.zIndex = "100000";
    list.style.overflowY = "auto";
    list.style.padding = "4px 0";
    list.style.boxShadow = "0 12px 32px rgba(0, 0, 0, 0.55)";
    fieldStyle(list);

    function setBound(slot) {
      current = slot;
      input.value = slot?.name || "";
      onChange(slot);
    }

    function hideList() {
      list.style.display = "none";
      if (list.parentNode) list.remove();
    }

    function positionList() {
      const r = input.getBoundingClientRect();
      const gap = 4;
      const spaceBelow = window.innerHeight - r.bottom - 8;
      const maxH = Math.min(280, Math.max(140, spaceBelow));
      list.style.left = r.left + "px";
      list.style.width = r.width + "px";
      list.style.top = r.bottom + gap + "px";
      list.style.maxHeight = maxH + "px";
    }

    function renderList(filter) {
      list.replaceChildren();
      const q = (filter || "").trim().toLowerCase();
      const matches = q
        ? playlists.filter(
            (pl) => pl.name.toLowerCase().includes(q) || pl.uri.toLowerCase().includes(q)
          )
        : playlists;

      const count = document.createElement("div");
      count.style.padding = "4px 8px";
      count.style.color = MUTED;
      count.style.fontSize = "12px";
      count.textContent = matches.length + " playlist" + (matches.length === 1 ? "" : "s");
      list.appendChild(count);

      if (matches.length === 0) {
        const empty = document.createElement("div");
        empty.style.padding = "8px";
        empty.style.color = MUTED;
        empty.textContent = "No matches";
        list.appendChild(empty);
        return;
      }

      for (const pl of matches) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = pl.name;
        btn.style.display = "block";
        btn.style.width = "100%";
        btn.style.textAlign = "left";
        btn.style.padding = "8px";
        btn.style.border = "none";
        const selected = current?.uri === pl.uri;
        btn.style.background = selected ? HOVER : "transparent";
        btn.style.color = TEXT;
        btn.style.cursor = "pointer";
        btn.addEventListener("mouseenter", () => {
          btn.style.background = HOVER;
        });
        btn.addEventListener("mouseleave", () => {
          btn.style.background = current?.uri === pl.uri ? HOVER : "transparent";
        });
        btn.addEventListener("mousedown", (event) => {
          event.preventDefault();
          setBound(pl);
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
      positionList();
      closeActivePicker = hideList;
    }

    input.addEventListener("focus", showList);
    input.addEventListener("input", () => {
      if (list.style.display === "none" || !list.parentNode) showList();
      else {
        renderList(input.value);
        positionList();
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

    controls.appendChild(input);
    controls.appendChild(clear);
    wrap.appendChild(controls);
    return wrap;
  }

  async function openSettings() {
    closeActivePicker();
    const root = document.createElement("div");
    root.style.color = TEXT;
    root.style.padding = "4px 0";
    root.style.maxHeight = "70vh";
    root.style.overflowY = "auto";

    const hint = document.createElement("p");
    hint.textContent =
      "Type to search. Number key adds to that playlist. Shift+number adds and skips.";
    hint.style.color = MUTED;
    hint.style.marginBottom = "16px";
    root.appendChild(hint);

    const cleaner = document.createElement("label");
    cleaner.style.display = "flex";
    cleaner.style.alignItems = "flex-start";
    cleaner.style.gap = "10px";
    cleaner.style.marginBottom = "16px";
    cleaner.style.cursor = "pointer";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = loadSettings().likeCleaner;
    box.style.marginTop = "3px";
    box.addEventListener("change", () => {
      saveSettings({ ...loadSettings(), likeCleaner: box.checked });
    });
    cleaner.appendChild(box);

    const cleanerText = document.createElement("span");
    const cleanerTitle = document.createElement("div");
    cleanerTitle.textContent = "Like cleaner";
    cleanerTitle.style.fontWeight = "600";
    const cleanerHint = document.createElement("div");
    cleanerHint.textContent = "Unlike after sorting a liked track into a playlist";
    cleanerHint.style.color = MUTED;
    cleanerHint.style.fontSize = "12px";
    cleanerText.appendChild(cleanerTitle);
    cleanerText.appendChild(cleanerHint);
    cleaner.appendChild(cleanerText);
    root.appendChild(cleaner);

    const loading = document.createElement("p");
    loading.textContent = "Loading playlists…";
    root.appendChild(loading);

    PopupModal.display({
      title: "Crate Digger",
      content: root,
      isLarge: true,
    });

    const slots = loadSlots();
    const playlists = await fetchWritablePlaylists();
    loading.remove();

    const count = document.createElement("p");
    count.style.color = MUTED;
    count.style.marginBottom = "12px";
    count.textContent = playlists.length + " playlists";
    root.appendChild(count);

    for (const key of SLOT_KEYS) {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "flex-start";
      row.style.gap = "12px";
      row.style.margin = "8px 0";

      const label = document.createElement("span");
      label.textContent = key;
      label.style.width = "1.5em";
      label.style.marginTop = "6px";
      label.style.fontWeight = "700";
      label.style.fontVariantNumeric = "tabular-nums";
      row.appendChild(label);

      row.appendChild(
        createPicker(playlists, slots[key], (slot) => {
          const next = loadSlots();
          next[key] = slot;
          saveSlots(next);
        })
      );
      root.appendChild(row);
    }
  }

  function bindKeys() {
    const trap = Mousetrap;
    for (const key of SLOT_KEYS) {
      trap.bind(key, (event) => {
        event.preventDefault();
        addCurrentToSlot(key, false);
        return false;
      });
      trap.bind("shift+" + key, (event) => {
        event.preventDefault();
        addCurrentToSlot(key, true);
        return false;
      });
    }
    trap.bind("left", (event) => {
      event.preventDefault();
      Player.back();
      return false;
    });
    trap.bind("right", (event) => {
      event.preventDefault();
      Player.next();
      return false;
    });
    trap.bind("l", (event) => {
      event.preventDefault();
      const was = Player.getHeart();
      Player.setHeart(!was);
      notify(was ? "Unliked" : "Liked");
      return false;
    });
  }

  const HUD_ID = "cratedigger-hud";
  const ACCENT = "var(--spice-button, #2ac3de)";

  function findSeekBar() {
    return (
      document.querySelector(".playback-bar") ||
      document.querySelector('[data-testid="playback-progressbar"]')?.closest(".playback-bar")
    );
  }

  /** Top of the center play cluster (controls + seek), so the HUD sits above both. */
  function findHudAnchor() {
    const controls = document.querySelector(".player-controls");
    const seek = findSeekBar();
    if (controls && seek && controls.parentElement === seek.parentElement) {
      const seekFirst = controls.compareDocumentPosition(seek) & Node.DOCUMENT_POSITION_PRECEDING;
      return seekFirst ? seek : controls;
    }
    return controls || seek;
  }

  function flashHudSlot(slotKey) {
    const chip = document.querySelector("#" + HUD_ID + ' [data-slot="' + slotKey + '"]');
    if (!chip) return;
    chip.style.background = HOVER;
    chip.style.outline = "1px solid " + ACCENT;
    setTimeout(() => {
      chip.style.background = "transparent";
      chip.style.outline = "none";
    }, 400);
  }

  function renderHud() {
    const hud = document.getElementById(HUD_ID);
    if (!hud) return;
    const slots = loadSlots();
    hud.replaceChildren();
    for (const key of SLOT_KEYS) {
      const slot = slots[key];
      const chip = document.createElement("button");
      chip.type = "button";
      chip.dataset.slot = key;
      chip.title = slot?.name ? "Slot " + key + ": " + slot.name : "Slot " + key + " unbound — click to bind";
      chip.style.display = "inline-flex";
      chip.style.alignItems = "center";
      chip.style.gap = "4px";
      chip.style.maxWidth = "9.5em";
      chip.style.padding = "2px 6px";
      chip.style.border = "none";
      chip.style.borderRadius = "4px";
      chip.style.background = "transparent";
      chip.style.color = slot?.uri ? TEXT : MUTED;
      chip.style.cursor = "pointer";
      chip.style.font = "inherit";
      chip.style.fontSize = "11px";
      chip.style.lineHeight = "1.2";
      chip.style.whiteSpace = "nowrap";
      chip.style.overflow = "hidden";

      const num = document.createElement("span");
      num.textContent = "[" + key + "]";
      num.style.color = slot?.uri ? ACCENT : MUTED;
      num.style.fontWeight = "700";
      num.style.fontVariantNumeric = "tabular-nums";
      chip.appendChild(num);

      const name = document.createElement("span");
      name.textContent = slot?.name || "—";
      name.style.minWidth = "0";
      name.style.overflow = "hidden";
      name.style.textOverflow = "ellipsis";
      chip.appendChild(name);

      chip.addEventListener("click", () => openSettings());
      hud.appendChild(chip);
    }
  }

  function mountHud() {
    let hud = document.getElementById(HUD_ID);
    if (!hud) {
      hud = document.createElement("div");
      hud.id = HUD_ID;
      hud.style.display = "flex";
      hud.style.flexWrap = "wrap";
      hud.style.justifyContent = "center";
      hud.style.alignItems = "center";
      hud.style.gap = "2px 4px";
      hud.style.width = "100%";
      hud.style.padding = "2px 8px 4px";
      hud.style.boxSizing = "border-box";
      hud.style.pointerEvents = "auto";
    }

    const anchor = findHudAnchor();
    if (!anchor || !anchor.parentElement) {
      setTimeout(mountHud, 400);
      return;
    }
    if (hud.parentElement !== anchor.parentElement || hud.nextElementSibling !== anchor) {
      anchor.parentElement.insertBefore(hud, anchor);
    }
    renderHud();
  }

  bindKeys();
  mountHud();

  (function watchHud() {
    const root = document.querySelector(".Root__now-playing-bar");
    if (!root) {
      setTimeout(watchHud, 400);
      return;
    }
    new MutationObserver(() => {
      const anchor = findHudAnchor();
      const hud = document.getElementById(HUD_ID);
      if (anchor && (!hud || hud.nextElementSibling !== anchor)) mountHud();
    }).observe(root, { childList: true, subtree: true });
  })();

  if (Menu?.Item) {
    new Menu.Item("Crate Digger", false, () => {
      openSettings();
    }, "playlist").register();
  }

  const BLANK_ICON = '<svg width="16" height="16" viewBox="0 0 16 16"></svg>';
  /** @type {{ widget: InstanceType<typeof Playbar.Widget>, label: HTMLSpanElement } | null} */
  let membershipUi = null;
  let membershipGen = 0;

  function ensureMembershipUi() {
    if (membershipUi) return membershipUi;
    if (!Playbar?.Widget) return null;
    const widget = new Playbar.Widget("Not in a crate slot", BLANK_ICON, () => {}, false, false);
    widget.element.querySelector("svg")?.remove();
    widget.element.style.width = "auto";
    widget.element.style.minWidth = "0";
    widget.element.style.padding = "0 4px";
    widget.element.style.display = "none";
    const label = document.createElement("span");
    label.style.fontVariantNumeric = "tabular-nums";
    label.style.fontWeight = "700";
    label.style.fontSize = "12px";
    label.style.color = ACCENT;
    label.style.letterSpacing = "0.02em";
    widget.element.appendChild(label);
    membershipUi = { widget, label };
    return membershipUi;
  }

  /**
   * @param {string} playlistUri
   * @returns {Promise<Set<string>>}
   */
  async function loadPlaylistTracks(playlistUri) {
    const uris = new Set();
    const api = Platform.PlaylistAPI;
    if (!api?.getContents) {
      playlistTracks.set(playlistUri, uris);
      return uris;
    }
    try {
      const res = await api.getContents(playlistUri);
      const items = res?.items || [];
      for (const item of items) {
        const uri = item.uri || item.itemMetadata?.uri;
        if (uri) uris.add(uri);
      }
      const total = res?.totalLength;
      const pageSize = res?.limit || items.length;
      if (total && pageSize && items.length < total) {
        for (let offset = items.length; offset < total; offset += pageSize) {
          try {
            const page = await api.getContents(playlistUri, { offset, limit: pageSize });
            for (const item of page?.items || []) {
              const uri = item.uri || item.itemMetadata?.uri;
              if (uri) uris.add(uri);
            }
            if (!(page?.items || []).length) break;
          } catch {
            break;
          }
        }
      }
    } catch (e) {
      console.error("cratedigger: getContents", playlistUri, e);
    }
    playlistTracks.set(playlistUri, uris);
    return uris;
  }

  /**
   * @param {string} playlistUri
   * @param {string} trackUri
   */
  async function playlistHasTrack(playlistUri, trackUri) {
    const api = Platform.PlaylistAPI;
    if (typeof api?.contains === "function") {
      try {
        const res = await api.contains(playlistUri, [trackUri]);
        if (Array.isArray(res)) return Boolean(res[0]);
        if (res && typeof res === "object") return Boolean(res[trackUri]);
        return Boolean(res);
      } catch (e) {
        console.warn("cratedigger: contains", e);
      }
    }
    let set = playlistTracks.get(playlistUri);
    if (!set) set = await loadPlaylistTracks(playlistUri);
    return set.has(trackUri);
  }

  async function refreshMembership() {
    const ui = ensureMembershipUi();
    if (!ui) return;
    const gen = ++membershipGen;
    const trackUri = Player.data?.item?.uri;
    const slots = loadSlots();
    if (!trackUri) {
      ui.widget.element.style.display = "none";
      return;
    }
    const hits = [];
    await Promise.all(
      SLOT_KEYS.map(async (key) => {
        const slot = slots[key];
        if (!slot?.uri) return;
        if (await playlistHasTrack(slot.uri, trackUri)) hits.push(key);
      })
    );
    if (gen !== membershipGen) return;
    ui.widget.element.querySelector("svg")?.remove();
    if (!ui.label.isConnected) ui.widget.element.appendChild(ui.label);
    hits.sort((a, b) => SLOT_KEYS.indexOf(a) - SLOT_KEYS.indexOf(b));
    if (!hits.length) {
      ui.widget.label = "Not in a crate slot";
      ui.widget.element.style.display = "none";
      ui.label.textContent = "";
      return;
    }
    ui.label.textContent = hits.map((key) => "[" + key + "]").join("");
    ui.widget.label = "In " + hits.map((key) => "[" + key + "] " + (slots[key]?.name || "")).join(", ");
    ui.widget.element.style.display = "";
  }

  Player.addEventListener("songchange", () => {
    refreshMembership();
  });
  refreshMembership();

  if (!Platform.PlaylistAPI) {
    notify("Crate Digger: PlaylistAPI missing — playlist keys disabled", true);
  }
})();
