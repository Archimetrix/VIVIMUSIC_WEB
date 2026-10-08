// The home screen is a launcher; feature settings live in their own scrollable view.
(() => {
  const sections = [...document.querySelectorAll('body > .section')];
  const header = document.querySelector('.header');
  const home = document.createElement('main');
  home.className = 'view-home';
  home.innerHTML = '<div class="home-intro"><h2>Your music, your way</h2><p>Choose a feature to view and adjust its settings.</p></div><div class="home-grid"></div>';
  const settings = document.createElement('main');
  settings.className = 'view-settings';
  settings.innerHTML = '<div class="panel-nav"><button class="back-btn" type="button" aria-label="Back to home">‹</button><div class="panel-icon"><img alt=""></div><div><div class="panel-heading"></div><div class="panel-caption"></div></div></div><div class="settings-content"></div>';
  const announcements = document.createElement('main');
  announcements.className = 'view-announcements';
  announcements.innerHTML = '<div class="panel-nav"><button class="back-btn" type="button" aria-label="Back to home">‹</button><div class="announcement-panel-icon"><img src="https://avatars.githubusercontent.com/u/122910097?v=4" alt="Archimetrix"></div><div><div class="panel-heading">Announcements</div><div class="panel-caption">News and notes from the developer</div></div></div><div class="announcement-list" aria-live="polite"><div class="announcement-empty">Checking for announcements…</div></div>';
  const developerAvatar = announcements.querySelector('.announcement-panel-icon img');
  developerAvatar.addEventListener('error', () => {
    developerAvatar.remove();
    announcements.querySelector('.announcement-panel-icon').textContent = 'A';
  }, { once: true });
  const store = document.createElement('div'); store.className = 'section-store';
  const meta = {
    Artwork: ['Apple Artwork', 'Animated cover art and fluid backgrounds', 'apple-artwork', 'static'],
    Equalizer: ['Equalizer', 'Shape and enhance your sound', 'equalizer'],
    Lyrics: ['Lyrics', 'Synced lyrics and display preferences', 'lyrics'],
    Appearance: ['Appearance', 'Tune the YouTube Music look', 'appearance'],
    'Artwork Cache': ['Artwork Cache', 'Browse, import, and export saved artwork', 'artwork-cache'],
    'Spotify Canvas': ['Spotify Canvas', 'Connect Spotify and manage Canvas', 'spotify-canvas'],
    'Last.fm': ['Last.fm', 'Scrobbling and account settings', 'lastfm', 'static'],
    Updates: ['Updates', 'Check your installed version', 'updates']
  };
  const sectionKey = section => section.querySelector('.section-title, .cache-title')?.textContent.trim() || '';
  const desiredOrder = ['Artwork', 'Spotify Canvas', 'Equalizer', 'Lyrics', 'Appearance', 'Artwork Cache', 'Last.fm', 'Updates'];
  sections.sort((a, b) => desiredOrder.indexOf(sectionKey(a)) - desiredOrder.indexOf(sectionKey(b)));
  sections.forEach(section => {
    const heading = section.querySelector('.section-title, .cache-title');
    const key = heading?.textContent.trim() || '';
    const [title, description, feature, motion = 'animated'] = meta[key] || [key, 'Feature settings', 'updates'];
    const card = document.createElement('button');
    card.type = 'button'; card.className = 'home-card'; card.dataset.feature = feature;
    const staticIcon = `../icons/popup/${feature}-static.png`;
    const animatedIcon = motion === 'static' ? '' : `../icons/popup/${feature}-animated.png`;
    card.innerHTML = `<span class="home-card-top"><span class="home-card-title">${title}</span><span class="home-card-icon"><img class="card-icon-static" src="${staticIcon}" alt=""><img class="card-icon-animated" alt=""></span></span><span class="home-card-description">${description}</span>`;
    const animatedImage = card.querySelector('.card-icon-animated');
    let hoverTimer = 0;
    let loadToken = 0;
    const wantsMotion = () => card.matches(':hover, :focus-visible');
    const startAnimation = () => {
      if (!animatedIcon || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      window.clearTimeout(hoverTimer);
      hoverTimer = window.setTimeout(async () => {
        if (!wantsMotion()) return;
        const token = ++loadToken;
        animatedImage.src = animatedIcon;
        try {
          await animatedImage.decode();
          if (token === loadToken && wantsMotion()) card.classList.add('is-animated');
        } catch {
          if (token === loadToken) animatedImage.src = staticIcon;
          card.classList.remove('is-animated');
        }
      }, 130);
    };
    const stopAnimation = () => {
      window.clearTimeout(hoverTimer);
      loadToken++;
      card.classList.remove('is-animated');
      if (animatedIcon) animatedImage.src = staticIcon;
    };
    card.addEventListener('pointerenter', startAnimation);
    card.addEventListener('pointerleave', () => { if (!card.matches(':focus-visible')) stopAnimation(); });
    card.addEventListener('focus', startAnimation);
    card.addEventListener('blur', () => { if (!card.matches(':hover')) stopAnimation(); });
    card.addEventListener('click', () => {
      settings.querySelector('.panel-heading').textContent = title;
      settings.querySelector('.panel-caption').textContent = description;
      settings.dataset.feature = feature;
      const panelIcon = settings.querySelector('.panel-icon');
      panelIcon.dataset.feature = feature;
      panelIcon.querySelector('img').src = staticIcon;
      settings.querySelector('.settings-content').appendChild(section);
      document.body.classList.add('settings-open');
      settings.querySelector('.back-btn').focus();
    });
    home.querySelector('.home-grid').appendChild(card);
    store.appendChild(section);
  });
  header.after(home, settings, announcements, store);

  // ── Update notice ────────────────────────────────────────────────────────
  // The background worker checks GitHub twice a day and stores the result in
  // vivi_update_check. If a newer version exists, show a red "1" on the
  // corner of the Updates card so users know to open it.
  const updatesCard = home.querySelector('.home-card[data-feature="updates"]');
  const updateBadge = document.createElement('span');
  updateBadge.className = 'home-card-badge'; updateBadge.textContent = '1'; updateBadge.hidden = true;
  updateBadge.setAttribute('aria-label', 'Update available');
  if (updatesCard) updatesCard.appendChild(updateBadge);
  function applyUpdateResult(result) {
    const available = !!(result && result.ok && result.updateAvailable);
    updateBadge.hidden = !available;
    if (updatesCard) updatesCard.title = available ? `Update available — v${result.latestVersion}` : '';
  }
  try {
    chrome.storage.local.get('vivi_update_check', ({ vivi_update_check: cached }) => {
      applyUpdateResult(cached);
      // Re-check if the stored result is over an hour old.
      if (!cached || !cached.checkedAt || Date.now() - cached.checkedAt > 60 * 60 * 1000) {
        try { chrome.runtime.sendMessage({ type: 'VIVI_CHECK_UPDATE' }, (fresh) => { void chrome.runtime.lastError; applyUpdateResult(fresh); }); } catch { /* offline */ }
      }
    });
  } catch { /* storage unavailable */ }
  // Keep the badge in sync after "Check for updates" in the Updates panel.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.vivi_update_check) applyUpdateResult(changes.vivi_update_check.newValue);
    });
  } catch { /* ignore */ }
  const announcementButton = header.querySelector('.announcement-button');
  const announcementBadge = header.querySelector('.announcement-badge');
  let announcementState = { announcements: [], seenIds: [], unreadCount: 0 };
  const checkAnnouncements = new Promise(resolve => {
    try { chrome.runtime.sendMessage({ type: 'VIVI_ANNOUNCEMENTS_CHECK' }, resolve); }
    catch { resolve(null); }
  }).then(state => {
    if (state?.ok) {
      announcementState = state;
      renderAnnouncementBadge();
    }
    return state;
  }).catch(() => null);
  function renderAnnouncementBadge() {
    const count = announcementState.unreadCount || 0;
    announcementBadge.hidden = count < 1;
    announcementBadge.textContent = count > 9 ? '9+' : String(count);
    announcementButton.setAttribute('aria-label', count ? `Announcements, ${count} new` : 'Announcements');
  }
  function renderAnnouncements(items) {
    const list = announcements.querySelector('.announcement-list');
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div'); empty.className = 'announcement-empty';
      empty.textContent = 'No announcements yet. You’re all caught up.'; list.appendChild(empty); return;
    }
    for (const item of items) {
      const card = document.createElement('article'); card.className = 'announcement-card';
      const head = document.createElement('div'); head.className = 'announcement-card-head';
      const date = document.createElement('time');
      if (item.timestamp) {
        const parsed = new Date(item.timestamp);
        if (!Number.isNaN(parsed.getTime())) {
          date.dateTime = parsed.toISOString();
          date.textContent = new Intl.DateTimeFormat(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
          }).format(parsed);
          date.title = `Published at ${item.timestamp}`;
        } else {
          date.textContent = item.timestamp;
        }
      }
      const title = document.createElement('h3'); title.textContent = item.title || 'Announcement';
      head.append(date, title);
      const message = document.createElement('p'); message.textContent = item.message || '';
      if (!announcementState.seenIds?.includes(item.id)) card.classList.add('is-unread');
      card.append(head, message); list.appendChild(card);
    }
  }
  announcementButton.addEventListener('click', async () => {
    document.body.classList.remove('settings-open');
    document.body.classList.add('announcements-open');
    await checkAnnouncements;
    renderAnnouncements(announcementState.announcements || []);
    try {
      const marked = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'VIVI_ANNOUNCEMENTS_MARK_SEEN' }, resolve));
      if (marked?.ok) announcementState = marked;
    } catch { /* Keep the cached list available while offline. */ }
    announcementState.unreadCount = 0;
    renderAnnouncementBadge();
  });
  announcements.querySelector('.back-btn').addEventListener('click', () => document.body.classList.remove('announcements-open'));
  settings.querySelector('.back-btn').addEventListener('click', () => {
    const section = settings.querySelector('.settings-content > .section');
    if (section) store.appendChild(section);
    document.body.classList.remove('settings-open');
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.body.classList.contains('settings-open')) settings.querySelector('.back-btn').click();
    if (event.key === 'Escape' && document.body.classList.contains('announcements-open')) announcements.querySelector('.back-btn').click();
  });
})();
