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
  const KEY_COMBOS = SLOT_KEYS.flatMap((key) => [key, `shift+${key}`]).concat(["a", "d", "l"]);
  const STORAGE_SLOTS = "cratedigger:slots";
  const STORAGE_SETTINGS = "cratedigger:settings";

  const playlistTracks = new Map();

  let closeActivePicker = () => {};
  let membershipEl = null;
  let membershipGen = 0;

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
    return {
      enabled: parsed?.enabled !== false,
      invertShift: Boolean(parsed?.invertShift),
      likeCleaner: Boolean(parsed?.likeCleaner),
    };
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

  // A/D: prev/next. Stock Left/Right are broken on Linux.
  function bindPrevent(trap, combo, handler) {
    trap.bind(combo, (event) => {
      event.preventDefault();
      handler();
      return false;
    });
  }

  function unbindKeys() {
    for (const combo of KEY_COMBOS) Mousetrap.unbind(combo);
  }

  function bindKeys() {
    const trap = Mousetrap;

    for (const key of SLOT_KEYS) {
      bindPrevent(trap, key, () => addCurrentToSlot(key, loadSettings().invertShift));
      bindPrevent(trap, `shift+${key}`, () => addCurrentToSlot(key, !loadSettings().invertShift));
    }

    bindPrevent(trap, "a", () => Player.back());
    bindPrevent(trap, "d", () => Player.next());

    bindPrevent(trap, "l", () => {
      const wasLiked = Player.getHeart();
      Player.setHeart(!wasLiked);
      showNotification(wasLiked ? "Unliked" : "Liked");
    });
  }

  async function addCurrentToSlot(slotKey, skipAfter) {
    if (!loadSettings().enabled) return;

    const trackUri = Player.data?.item?.uri || "";
    if (!trackUri) {
      showNotification("No track playing", true);
      return;
    }

    const slot = loadSlots()[slotKey];
    if (!slot?.uri) {
      showNotification(`Slot ${slotKey} is unbound`, true);
      return;
    }

    if (!Platform.PlaylistAPI?.add) {
      showNotification("Crate Digger: PlaylistAPI missing", true);
      return;
    }

    try {
      await Platform.PlaylistAPI.add(slot.uri, [trackUri], { after: "end" });
      playlistTracks.get(slot.uri)?.add(trackUri);

      let message = `Added to ${slot.name || "playlist"}`;
      if (loadSettings().likeCleaner && Player.getHeart()) {
        Player.setHeart(false);
        message += " - unliked";
      }

      showNotification(message);
      flashHudSlot(slotKey);
      refreshMembership();
      if (skipAfter) Player.next();
    } catch (err) {
      showNotification(String(err?.message || err), true);
    }
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
        showNotification("Crate Digger: cannot list playlists", true);
        return [];
      }

      const byUri = new Map();
      for (const playlist of collected) {
        if (!byUri.has(playlist.uri)) byUri.set(playlist.uri, playlist);
      }

      return [...byUri.values()].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
    } catch (err) {
      showNotification(String(err?.message || err), true);
      return [];
    }
  }

  // Native <select> clips inside PopupModal. Dropdown is position:fixed on document.body.
  function positionListBelow(list, input) {
    const rect = input.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 8;

    Object.assign(list.style, {
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      top: `${rect.bottom + 4}px`,
      maxHeight: `${Math.min(280, Math.max(140, spaceBelow))}px`,
    });
  }

  function picker(playlists, current, onChange) {
    const wrap = document.createElement("div");
    wrap.style.flex = "1";
    wrap.style.minWidth = "0";

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "6px";

    const input = document.createElement("input");
    input.type = "search";
    input.autocomplete = "off";
    input.placeholder = "Search playlists...";
    input.value = current?.name || "";
    input.style.cssText =
      "flex:1;min-width:0;padding:6px 8px;color-scheme:dark;" +
      "background:var(--spice-card);color:var(--spice-text);" +
      "border:1px solid rgba(var(--spice-rgb-text),.2);border-radius:4px";

    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "×";
    clear.title = "Unbind";
    clear.style.cssText =
      "width:32px;cursor:pointer;" +
      "background:var(--spice-card);color:var(--spice-text);" +
      "border:1px solid rgba(var(--spice-rgb-text),.2);border-radius:4px";

    const list = document.createElement("div");
    list.style.cssText =
      "display:none;position:fixed;z-index:100000;overflow-y:auto;padding:4px 0;" +
      "box-shadow:0 12px 32px rgba(var(--spice-rgb-shadow),.55);" +
      "background:var(--spice-card);color:var(--spice-text);" +
      "border:1px solid rgba(var(--spice-rgb-text),.2);border-radius:4px";

    function setBound(slot) {
      current = slot;
      input.value = slot?.name || "";
      onChange(slot);
    }

    function hideList() {
      list.style.display = "none";
      list.remove();
    }

    function renderList(filter) {
      list.replaceChildren();
      const query = (filter || "").trim().toLowerCase();
      const matches = !query
        ? playlists
        : playlists.filter(
            (p) => p.name.toLowerCase().includes(query) || p.uri.toLowerCase().includes(query),
          );

      const meta = document.createElement("div");
      meta.style.cssText = "padding:4px 8px;color:var(--spice-subtext);font-size:12px";
      meta.textContent = `${matches.length} playlist${matches.length === 1 ? "" : "s"}`;
      list.appendChild(meta);

      if (!matches.length) {
        const empty = document.createElement("div");
        empty.style.cssText = "padding:8px;color:var(--spice-subtext)";
        empty.textContent = "No matches";
        list.appendChild(empty);
        return;
      }

      for (const playlist of matches) {
        const selected = current?.uri === playlist.uri;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = playlist.name;
        btn.style.cssText =
          "display:block;width:100%;text-align:left;padding:8px;border:none;cursor:pointer;" +
          "color:var(--spice-text);background:" +
          (selected ? "var(--spice-tab-active)" : "transparent");

        btn.onmouseenter = () => {
          btn.style.background = "var(--spice-tab-active)";
        };
        btn.onmouseleave = () => {
          btn.style.background =
            current?.uri === playlist.uri ? "var(--spice-tab-active)" : "transparent";
        };
        btn.onmousedown = (event) => {
          event.preventDefault(); // keep focus; blur would close the list first
          setBound(playlist);
          hideList();
        };

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

    row.append(input, clear);
    wrap.appendChild(row);
    return wrap;
  }

  function settingToggle(heading, description, checked, onChange) {
    const toggle = document.createElement("label");
    toggle.style.cssText =
      "display:flex;align-items:flex-start;gap:10px;margin-bottom:16px;cursor:pointer";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = checked;
    box.style.marginTop = "3px";
    box.onchange = () => onChange(box.checked);

    const copy = document.createElement("span");
    const title = document.createElement("div");
    title.style.fontWeight = "600";
    title.textContent = heading;
    const desc = document.createElement("div");
    desc.style.cssText = "color:var(--spice-subtext);font-size:12px";
    desc.textContent = description;
    copy.append(title, desc);

    toggle.append(box, copy);
    return toggle;
  }

  async function openSettings() {
    closeActivePicker();

    const root = document.createElement("div");
    root.style.cssText = "color:var(--spice-text);padding:4px 0;max-height:70vh;overflow-y:auto";

    const hint = document.createElement("p");
    hint.style.cssText = "color:var(--spice-subtext);margin-bottom:16px";

    function setHint() {
      hint.textContent = loadSettings().invertShift
        ? "Type to search. Number key adds and skips. Shift+number adds and stays. A/D previous/next."
        : "Type to search. Number key adds to that playlist. Shift+number adds and skips. A/D previous/next.";
    }

    setHint();
    root.appendChild(hint);

    root.appendChild(
      settingToggle(
        "Enabled",
        "Keys, HUD, and crate tags. Profile menu stays so you can turn it back on.",
        loadSettings().enabled,
        (on) => {
          storageSet(STORAGE_SETTINGS, { ...loadSettings(), enabled: on });
          applyEnabled();
        },
      ),
    );

    root.appendChild(
      settingToggle(
        "Invert Shift",
        "Number key adds and skips. Shift+number adds and stays.",
        loadSettings().invertShift,
        (on) => {
          storageSet(STORAGE_SETTINGS, { ...loadSettings(), invertShift: on });
          setHint();
        },
      ),
    );

    root.appendChild(
      settingToggle(
        "Like cleaner",
        "Unlike after sorting a liked track into a playlist",
        loadSettings().likeCleaner,
        (on) => {
          storageSet(STORAGE_SETTINGS, { ...loadSettings(), likeCleaner: on });
        },
      ),
    );

    const loading = document.createElement("p");
    loading.textContent = "Loading playlists...";
    root.appendChild(loading);

    PopupModal.display({ title: TITLE, content: root, isLarge: true });

    const slots = loadSlots();
    const playlists = await fetchWritablePlaylists();
    loading.remove();

    const count = document.createElement("p");
    count.style.cssText = "color:var(--spice-subtext);margin-bottom:12px";
    count.textContent = `${playlists.length} playlists`;
    root.appendChild(count);

    for (const key of SLOT_KEYS) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:flex-start;gap:12px;margin:8px 0";
      const label = document.createElement("span");
      label.style.cssText =
        "width:1.5em;margin-top:6px;font-weight:700;font-variant-numeric:tabular-nums";
      label.textContent = key;
      row.append(
        label,
        picker(playlists, slots[key], (slot) => {
          const next = loadSlots();
          next[key] = slot;
          saveSlots(next);
        }),
      );
      root.appendChild(row);
    }
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
    const chip = document.querySelector(`#cratedigger-hud [data-slot="${slotKey}"]`);
    if (!chip) return;

    chip.style.background = "var(--spice-tab-active)";
    chip.style.outline = "1px solid var(--spice-button)";
    setTimeout(() => {
      chip.style.background = "transparent";
      chip.style.outline = "none";
    }, 400);
  }

  function hudChip(key, slot) {
    const bound = Boolean(slot?.uri);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.slot = key;
    btn.title = bound ? `Slot ${key}: ${slot.name}` : `Slot ${key} unbound`;
    btn.style.cssText =
      "display:inline-flex;align-items:center;gap:4px;max-width:9.5em;padding:2px 6px;" +
      "border:none;border-radius:4px;background:transparent;cursor:pointer;font:inherit;" +
      "font-size:11px;line-height:1.2;white-space:nowrap;overflow:hidden;color:" +
      (bound ? "var(--spice-text)" : "var(--spice-subtext)");
    btn.onclick = (event) => {
      const skip = event.shiftKey ? !loadSettings().invertShift : loadSettings().invertShift;
      addCurrentToSlot(key, skip);
    };

    const tag = document.createElement("span");
    tag.style.cssText =
      "font-weight:700;font-variant-numeric:tabular-nums;color:" +
      (bound ? "var(--spice-button)" : "var(--spice-subtext)");
    tag.textContent = `[${key}]`;

    const name = document.createElement("span");
    name.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis";
    name.textContent = slot?.name || "-";

    btn.append(tag, name);
    return btn;
  }

  function renderHud() {
    const hud = document.getElementById("cratedigger-hud");
    if (!hud) return;

    const slots = loadSlots();
    hud.replaceChildren();
    for (const key of SLOT_KEYS) hud.appendChild(hudChip(key, slots[key]));
  }

  function ensureHud() {
    const existing = document.getElementById("cratedigger-hud");
    if (existing) return existing;

    const hud = document.createElement("div");
    hud.id = "cratedigger-hud";
    hud.style.cssText =
      "display:flex;flex-wrap:wrap;justify-content:center;align-items:center;" +
      "gap:2px 4px;width:100%;padding:2px 8px 4px;box-sizing:border-box;pointer-events:auto";
    return hud;
  }

  function hideHud() {
    document.getElementById("cratedigger-hud")?.remove();
  }

  function mountHud() {
    if (!loadSettings().enabled) {
      hideHud();
      return;
    }

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
      if (!loadSettings().enabled) {
        hideHud();
        hideMembership();
        return;
      }

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
      membershipEl = document.createElement("span");
      membershipEl.id = "cratedigger-membership";
      membershipEl.style.cssText =
        "display:none;padding:0 4px;font-size:12px;font-weight:700;" +
        "font-variant-numeric:tabular-nums;color:var(--spice-button);" +
        "line-height:1;white-space:nowrap;align-self:center;flex-shrink:0;" +
        "pointer-events:none;user-select:none";
    }

    const heart = host.querySelector(".control-button-heart, [data-testid='add-button']");
    if (heart) {
      if (membershipEl.previousElementSibling !== heart) heart.after(membershipEl);
    } else if (membershipEl.parentElement !== host) {
      host.appendChild(membershipEl);
    }

    return membershipEl;
  }

  function hideMembership() {
    if (!membershipEl) return;
    membershipEl.textContent = "";
    membershipEl.title = "";
    membershipEl.style.display = "none";
    membershipEl.remove();
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
        const page = await api.getContents(playlistUri, {
          offset,
          limit: pageSize,
        });
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
      }),
    );

    hits.sort((a, b) => SLOT_KEYS.indexOf(a) - SLOT_KEYS.indexOf(b));
    return hits;
  }

  async function refreshMembership() {
    if (!loadSettings().enabled) {
      hideMembership();
      return;
    }

    const node = mountMembership();
    if (!node) {
      setTimeout(refreshMembership, 400);
      return;
    }

    const gen = ++membershipGen;
    const trackUri = Player.data?.item?.uri || "";
    const slots = loadSlots();
    if (!trackUri) {
      node.textContent = "";
      node.title = "";
      node.style.display = "none";
      return;
    }

    const hits = await slotKeysForTrack(trackUri, slots);
    if (gen !== membershipGen) return;
    if (!hits.length) {
      node.textContent = "";
      node.title = "";
      node.style.display = "none";
      return;
    }

    const labels = hits.map((key) => `[${key}] ${slots[key]?.name || ""}`);
    node.textContent = hits.map((key) => `[${key}]`).join("");
    node.title = `In ${labels.join(", ")}`;
    node.style.display = "";
  }

  function applyEnabled() {
    unbindKeys();
    if (!loadSettings().enabled) {
      hideHud();
      hideMembership();
      return;
    }

    bindKeys();
    mountHud();
    refreshMembership();
  }

  applyEnabled();
  watchNowPlayingBar();

  if (Menu?.Item) new Menu.Item(TITLE, false, () => openSettings(), "playlist").register();

  Player.addEventListener("songchange", () => refreshMembership());

  if (!Platform.PlaylistAPI && loadSettings().enabled) {
    showNotification("Crate Digger: PlaylistAPI missing - playlist keys disabled", true);
  }
})();
