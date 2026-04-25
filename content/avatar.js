// Swap user avatar everywhere on mangabuff.ru.
//
// Targets three places with different sizes:
//   - img.my-avatar                                          → x150 (profile)
//   - .header__item.header-profile.dropdown__trigger img     → x35  (header dropdown)
//   - .menu__avatar img                                      → x35  (mobile menu)
//
// `selectedAvatar` is either a site path "/img/avatars/x150/{id}.gif" or a
// "data:image/..." string (custom upload). For path-based selections we
// derive the x35 variant for the small slots; for data URLs we just reuse
// the same data URL (browser scales it).

(async () => {
  const SLOTS = [
    { sel: 'img.my-avatar',                                          size: 'x150' },
    { sel: '.header__item.header-profile.dropdown__trigger img',     size: 'x35'  },
    { sel: '.menu__avatar img',                                      size: 'x35'  },
  ];

  let currentSrc = null;
  let applying = false;

  // Convert the stored src into the right size for a given slot.
  const srcForSlot = (stored, size) => {
    if (!stored) return null;
    if (stored.startsWith('data:')) return stored;
    // path: /img/avatars/x150/200.gif → swap the size segment
    return stored.replace(/\/x\d+\//, `/${size}/`);
  };

  const apply = (stored) => {
    if (applying) return;
    applying = true;
    try {
      for (const { sel, size } of SLOTS) {
        const want = srcForSlot(stored, size);
        if (!want) continue;
        document.querySelectorAll(sel).forEach((im) => {
          if (im.getAttribute('src') !== want) im.setAttribute('src', want);
        });
      }
    } finally {
      applying = false;
    }
  };

  const reapplyIfStripped = () => {
    if (!currentSrc) return;
    let needs = false;
    for (const { sel, size } of SLOTS) {
      const want = srcForSlot(currentSrc, size);
      if (!want) continue;
      document.querySelectorAll(sel).forEach((im) => {
        if (im.getAttribute('src') !== want) needs = true;
      });
    }
    if (needs) apply(currentSrc);
  };

  const init = async () => {
    const { selectedAvatar } = await chrome.storage.local.get('selectedAvatar');
    currentSrc = selectedAvatar || null;
    if (currentSrc) apply(currentSrc);

    // The header avatar can be re-rendered when the dropdown opens, the menu
    // when it slides in. childList+subtree catches inserts; src filter catches
    // direct overwrites by the site.
    new MutationObserver(reapplyIfStripped).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
  };

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.selectedAvatar) return;
    currentSrc = changes.selectedAvatar.newValue || null;
    apply(currentSrc);
  });
})();
