/**
 * Popup shell — renders top-level site tabs and dynamically loads
 * each site's panel HTML + JS when a tab is activated.
 */

const SITE_REGISTRY = [
    { id: 'upwork', label: 'Upwork' },
    { id: 'tiktok', label: 'TikTok' }
];

const ACTIVE_SITE_STORAGE_KEY = 'activeSiteTab';
const DEFAULT_SITE = 'upwork';

function normalizeSiteId(value) {
    const match = SITE_REGISTRY.find((s) => s.id === value);
    return match ? match.id : DEFAULT_SITE;
}

/**
 * Build site tab buttons from the registry.
 */
function renderSiteTabs(activeSiteId) {
    const container = document.getElementById('siteTabs');
    container.innerHTML = '';

    for (const site of SITE_REGISTRY) {
        const btn = document.createElement('button');
        btn.className = 'site-tab' + (site.id === activeSiteId ? ' active' : '');
        btn.dataset.site = site.id;
        btn.innerHTML = site.label;
        btn.addEventListener('click', () => activateSite(site.id));
        container.appendChild(btn);
    }
}

/**
 * Load a site's panel.html into #siteContent, then execute its panel.js.
 */
async function activateSite(siteId) {
    const normalizedId = normalizeSiteId(siteId);

    // Update tab button active state
    const buttons = document.querySelectorAll('.site-tab');
    for (const btn of buttons) {
        btn.classList.toggle('active', btn.dataset.site === normalizedId);
    }

    const contentEl = document.getElementById('siteContent');

    // Hide all existing panel containers
    Array.from(contentEl.children).forEach(child => child.style.display = 'none');

    const panelContainerId = `panel-container-${normalizedId}`;
    let panelContainer = document.getElementById(panelContainerId);

    if (!panelContainer) {
        panelContainer = document.createElement('div');
        panelContainer.id = panelContainerId;
        contentEl.appendChild(panelContainer);
        
        try {
            // Fetch panel HTML and inject
            const panelUrl = chrome.runtime.getURL(`sites/${normalizedId}/panel.html`);
            const response = await fetch(panelUrl);
            panelContainer.innerHTML = await response.text();

            // Execute the statically loaded panel JS once
            if (normalizedId === 'upwork' && typeof window.mountUpworkPanel === 'function') {
                window.mountUpworkPanel();
            } else if (normalizedId === 'tiktok' && typeof window.mountTiktokPanel === 'function') {
                window.mountTiktokPanel();
            }
        } catch (error) {
            console.error(`Failed to load panel for site "${normalizedId}":`, error);
            panelContainer.innerHTML = `<div class="coming-soon">
                <div class="coming-soon-icon">⚠️</div>
                <h2>Load Error</h2>
                <p>Could not load the ${normalizedId} panel. Check console for details.</p>
            </div>`;
        }
    }
    
    // Show the active panel container
    panelContainer.style.display = 'block';

    // Persist selection
    chrome.storage.local.set({ [ACTIVE_SITE_STORAGE_KEY]: normalizedId }).catch((err) => {
        console.warn('Failed to persist active site tab:', err);
    });
}

/**
 * Initialize: restore last-active site tab and render.
 */
async function initializePopup() {
    const data = await chrome.storage.local.get(ACTIVE_SITE_STORAGE_KEY);
    const activeSiteId = normalizeSiteId(data[ACTIVE_SITE_STORAGE_KEY]);

    renderSiteTabs(activeSiteId);
    await activateSite(activeSiteId);
}

document.addEventListener('DOMContentLoaded', () => {
    initializePopup().catch((error) => {
        console.error('Popup initialization failed:', error);
    });
});
