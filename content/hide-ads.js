// Hide ad/banner DOM containers on mangabuff.ru.
//
// declarativeNetRequest only blocks the network request — the empty container
// (`.rek`, `.rek--mt`, etc.) still takes layout space. We inject a <style>
// tag that collapses those containers entirely. Tied to the same
// `adblockEnabled` flag the popup toggle writes, so disabling the toggle
// reverts both the network block and the DOM hiding.
//
// Runs at document_start so the rule is in place before the ads render —
// no flash of empty space.

(() => {
  const STYLE_ID = 'mb-hide-ads';
  const CSS = `
    .rek, .rek--mt,
    .rek-stub, .ads, .ad-banner, .banner-ads {
      display: none !important;
    }
  `;

  const apply = (on) => {
    let style = document.getElementById(STYLE_ID);
    if (on) {
      if (style) return;
      style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      // documentElement is always available at document_start; head may not be.
      (document.head || document.documentElement).appendChild(style);
    } else if (style) {
      style.remove();
    }
  };

  // Default ON if storage value is missing (matches popup default).
  chrome.storage.local.get('adblockEnabled', ({ adblockEnabled }) => {
    apply(adblockEnabled !== false);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('adblockEnabled' in changes)) return;
    apply(changes.adblockEnabled.newValue !== false);
  });
})();
