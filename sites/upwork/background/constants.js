const ARCHIVED_PROPOSALS_URL = 'https://www.upwork.com/nx/proposals/archived';
const UPWORK_ROOT_URL = 'https://www.upwork.com/';
const DEFAULT_SCRAPE_MODE = 'successful';

function normalizeScrapeMode(mode) {
    return mode === 'all' ? 'all' : DEFAULT_SCRAPE_MODE;
}