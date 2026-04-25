// Apply the saved profile skin only on the user's OWN profile page.
// Detection: own profile shows the customization form save button
// (`.profile-customization-form__save-button`), other users' pages don't.
// Falls back to checking if `body` already has `profile-skin` class
// (which the site adds when the user owns + has selected a skin).

(async () => {
  const SKIN_RE = /^profile-skin(--\d+)?$/;
  let currentId = null;
  let applying = false;

  const isOwnProfile = () => {
    if (!/^\/users\/\d+/.test(location.pathname)) return false;
    if (document.querySelector('.profile-customization-form__save-button')) return true;
    if (document.body?.classList.contains('profile-skin')) return true;
    return false;
  };

  const apply = (id) => {
    if (applying) return;
    applying = true;
    try {
      const body = document.body;
      if (!body) return;
      [...body.classList].forEach((c) => {
        if (SKIN_RE.test(c)) body.classList.remove(c);
      });
      if (id) body.classList.add('profile-skin', 'profile-skin--' + id);
    } finally {
      applying = false;
    }
  };

  const reapplyIfStripped = () => {
    if (!currentId) return;
    if (!isOwnProfile()) return;
    const cls = document.body.classList;
    if (!cls.contains('profile-skin') || !cls.contains('profile-skin--' + currentId)) {
      apply(currentId);
    }
  };

  const init = async () => {
    const { selectedSkin } = await chrome.storage.local.get('selectedSkin');
    currentId = selectedSkin || null;

    // Wait until DOM is sufficiently rendered to check for the customization form.
    if (currentId && isOwnProfile()) apply(currentId);

    new MutationObserver(reapplyIfStripped).observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      subtree: true, // catches the save-button being inserted late
    });
  };

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.selectedSkin) return;
    currentId = changes.selectedSkin.newValue || null;
    if (isOwnProfile()) apply(currentId);
  });
})();
