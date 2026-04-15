importScripts(
    'shared/utils.js',
    'sites/upwork/background/constants.js',
    'sites/upwork/shared/upwork-run-status.js',
    'sites/upwork/background/upwork-scrape-runner.js',
    'sites/upwork/background/controller.js',
    'sites/tiktok/background/tiktok-controller.js',
    'sites/github/background/github-controller.js',
    'sites/zitouna/background/zitouna-controller.js'
);

async function configureSidePanelBehavior() {
    if (!chrome.sidePanel?.setPanelBehavior) {
        return;
    }

    try {
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } catch (error) {
        console.warn('Failed to configure side panel behavior:', error);
    }
}

chrome.runtime.onInstalled.addListener(() => {
    configureSidePanelBehavior().catch((error) => {
        console.warn('Side panel setup failed during install:', error);
    });
});

chrome.runtime.onStartup.addListener(() => {
    configureSidePanelBehavior().catch((error) => {
        console.warn('Side panel setup failed during startup:', error);
    });
});

configureSidePanelBehavior().catch((error) => {
    console.warn('Initial side panel setup failed:', error);
});
