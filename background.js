chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'startScraping') {
        // Check if we're already on the proposals page
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const currentTab = tabs[0];
            if (currentTab.url === 'https://www.upwork.com/nx/proposals/archived') {
                // If we're already on the page, just refresh and inject script
                chrome.tabs.reload(currentTab.id, {}, () => {
                    chrome.scripting.executeScript({
                        target: { tabId: currentTab.id },
                        function: scrapeProposals
                    });
                });
            } else {
                // If not, create new tab
                chrome.tabs.create({ 
                    url: 'https://www.upwork.com/nx/proposals/archived' 
                }, (tab) => {
                    chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        function: scrapeProposals
                    });
                });
            }
        });
    }
});

async function scrapeProposals() {
    // Get existing proposals from storage
    const storageData = await chrome.storage.local.get('proposals');
    const existingProposals = storageData.proposals || [];
    const existingUrls = new Set(existingProposals.map(p => p.href));
    
    let allLinks = [];
    let tableData = [];
    let isPaused = false;
    
    const statusPopup = document.createElement('div');
    statusPopup.style.cssText = `
        position: fixed;
        top: 24px;
        right: 24px;
        background: #ffffff;
        color: #1a1f36;
        padding: 32px;
        border-radius: 16px;
        z-index: 10000;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
        width: 420px;
        height: auto;
        max-height: 85vh;
        overflow-y: auto;
        box-shadow: 
            0 24px 48px -12px rgba(0, 0, 0, 0.18),
            0 0 1px rgba(0, 0, 0, 0.1);
        backdrop-filter: blur(8px);
        border: 1px solid rgba(230, 232, 235, 0.8);
    `;
    
    const updateStatus = (message, currentPage = '', totalPages = '') => {
        let tableHTML = '';
        if (tableData.length > 0) {
            tableHTML = `
                <div style="margin-top: 32px;">
                    <div style="
                        margin-bottom: 16px;
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                    ">
                        <div style="
                            font-size: 14px;
                            font-weight: 600;
                            color: #1a1f36;
                            letter-spacing: -0.1px;
                        ">
                            Successful Proposals
                        </div>
                        <div style="
                            font-size: 13px;
                            color: #697386;
                        ">
                            ${tableData.filter(item => item.reason === 'Hired').length} hired
                        </div>
                    </div>
                    <table style="width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px;">
                        <thead>
                            <tr>
                                <th style="
                                    text-align: left; 
                                    padding: 16px; 
                                    background: #f8fafc; 
                                    font-weight: 600; 
                                    color: #1a1f36;
                                    border-top: 1px solid rgba(230, 232, 235, 0.8);
                                    border-bottom: 1px solid rgba(230, 232, 235, 0.8);
                                    first-child { border-radius: 12px 0 0 12px; }
                                    last-child { border-radius: 0 12px 12px 0; }
                                ">
                                    Job Title
                                </th>
                                <th style="
                                    text-align: left; 
                                    padding: 16px; 
                                    background: #f8fafc; 
                                    width: 110px; 
                                    font-weight: 600; 
                                    color: #1a1f36;
                                    border-top: 1px solid rgba(230, 232, 235, 0.8);
                                    border-bottom: 1px solid rgba(230, 232, 235, 0.8);
                                ">
                                    Status
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            ${tableData.map(item => `
                                <tr style="transition: background-color 0.2s ease;">
                                    <td style="
                                        padding: 16px; 
                                        border-bottom: 1px solid rgba(230, 232, 235, 0.5);
                                        background: white;
                                    ">
                                        <div style="font-weight: 500; color: #1a1f36; line-height: 1.4;">${item.text}</div>
                                        ${item.description ? `
                                            <div style="
                                                margin-top: 8px; 
                                                font-size: 12px; 
                                                color: #697386; 
                                                line-height: 1.5;
                                            ">
                                                ${item.description.substring(0, 100)}...
                                            </div>
                                        ` : ''}
                                    </td>
                                    <td style="
                                        padding: 16px; 
                                        border-bottom: 1px solid rgba(230, 232, 235, 0.5);
                                        background: white;
                                    ">
                                        <span style="
                                            padding: 6px 10px;
                                            border-radius: 20px;
                                            font-size: 11px;
                                            letter-spacing: 0.3px;
                                            font-weight: 500;
                                            background: ${item.reason === 'Hired' ? 'rgba(52, 199, 89, 0.1)' : 'rgba(142, 142, 147, 0.12)'};
                                            color: ${item.reason === 'Hired' ? '#28a745' : '#8e8e93'};
                                        ">${item.reason}</span>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }

        statusPopup.innerHTML = `
            <div style="margin-bottom: 32px;">
                <h3 style="
                    margin: 0 0 12px 0; 
                    font-size: 20px; 
                    font-weight: 600; 
                    color: #1a1f36;
                    letter-spacing: -0.2px;
                ">
                    Collecting Successful Proposals
                </h3>
                <div style="
                    font-size: 13px; 
                    color: #697386;
                    letter-spacing: -0.1px;
                    line-height: 1.5;
                ">
                    Found ${allLinks.length} successful proposals so far
                    <div style="
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        margin-left: 8px;
                        padding: 4px 8px;
                        background: rgba(52, 199, 89, 0.1);
                        border-radius: 6px;
                        color: #28a745;
                        font-weight: 500;
                        font-size: 12px;
                    ">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M20 6L9 17L4 12"></path>
                        </svg>
                        Hired Only
                    </div>
                </div>
            </div>

            <div style="
                background: #f8fafc;
                border-radius: 12px;
                padding: 20px;
                margin-bottom: 24px;
                border: 1px solid rgba(230, 232, 235, 0.8);
            ">
                <div style="
                    display: flex;
                    align-items: center;
                    gap: 16px;
                    padding-bottom: 16px;
                    margin-bottom: 16px;
                    border-bottom: 1px solid rgba(230, 232, 235, 0.8);
                ">
                    <div style="
                        width: 40px;
                        height: 40px;
                        background: rgba(52, 199, 89, 0.1);
                        border-radius: 10px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    ">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#28a745" stroke-width="2">
                            <path d="M12 2L2 7L12 12L22 7L12 2Z"></path>
                            <path d="M2 17L12 22L22 17"></path>
                            <path d="M2 12L12 17L22 12"></path>
                        </svg>
                    </div>
                    <div>
                        <div style="
                            font-size: 12px; 
                            color: #697386; 
                            margin-bottom: 6px;
                            text-transform: uppercase;
                            letter-spacing: 0.5px;
                            font-weight: 500;
                        ">Collection Status</div>
                        <div style="
                            font-size: 14px; 
                            color: #1a1f36; 
                            font-weight: 500;
                            letter-spacing: -0.1px;
                        ">${message}</div>
                    </div>
                </div>
                <div style="
                    display: flex;
                    align-items: center;
                    gap: 16px;
                ">
                    <div style="
                        width: 40px;
                        height: 40px;
                        background: rgba(99, 91, 255, 0.1);
                        border-radius: 10px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    ">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#635bff" stroke-width="2">
                            <path d="M12 2v20M2 12h20"></path>
                        </svg>
                    </div>
                    <div>
                        <div style="
                            font-size: 12px; 
                            color: #697386; 
                            margin-bottom: 6px;
                            text-transform: uppercase;
                            letter-spacing: 0.5px;
                            font-weight: 500;
                        ">Progress</div>
                        <div style="
                            font-size: 14px; 
                            color: #1a1f36; 
                            font-weight: 500;
                            letter-spacing: -0.1px;
                        ">
                            ${currentPage ? `Page ${currentPage}${totalPages ? ` of ${totalPages}` : ''}` : 'Initializing...'}
                        </div>
                    </div>
                </div>
            </div>

            <div style="
                background: rgba(52, 199, 89, 0.05);
                border: 1px solid rgba(52, 199, 89, 0.2);
                border-radius: 12px;
                padding: 16px;
                margin-bottom: 24px;
                display: flex;
                align-items: center;
                gap: 12px;
            ">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#28a745" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <path d="M12 8v4M12 16h.01"></path>
                </svg>
                <div style="
                    font-size: 13px;
                    color: #28a745;
                    letter-spacing: -0.1px;
                    line-height: 1.4;
                ">
                    We're only collecting proposals that were marked as "Hired" to learn from your successful applications.
                </div>
            </div>

            <button id="pauseButton" style="
                background: ${isPaused ? '#635bff' : '#dc3545'};
                border: none;
                color: white;
                padding: 12px 24px;
                border-radius: 12px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 500;
                width: 100%;
                margin-bottom: 24px;
                transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                box-shadow: 
                    0 1px 2px rgba(0,0,0,0.05),
                    0 0 1px rgba(0,0,0,0.1);
                letter-spacing: -0.1px;
            ">
                ${isPaused ? '▶️ Resume Collection' : '⏸️ Pause Collection'}
            </button>

            ${tableHTML}
        `;

        // Enhanced hover effect for pause button
        const pauseButton = document.getElementById('pauseButton');
        pauseButton.addEventListener('mouseover', () => {
            pauseButton.style.transform = 'translateY(-1px) scale(1.02)';
            pauseButton.style.boxShadow = `
                0 4px 12px ${isPaused ? 'rgba(99,91,255,0.2)' : 'rgba(220,53,69,0.2)'},
                0 0 1px rgba(0,0,0,0.1)
            `;
        });
        pauseButton.addEventListener('mouseout', () => {
            pauseButton.style.transform = 'none';
            pauseButton.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05), 0 0 1px rgba(0,0,0,0.1)';
        });

        // Add active state
        pauseButton.addEventListener('mousedown', () => {
            pauseButton.style.transform = 'translateY(0) scale(0.98)';
        });

        pauseButton.addEventListener('mouseup', () => {
            pauseButton.style.transform = 'translateY(-1px) scale(1.02)';
        });

        pauseButton.addEventListener('click', () => {
            isPaused = !isPaused;
            updateStatus(isPaused ? 'Paused' : 'Resuming...', currentPage, totalPages);
        });
    };
    
    document.body.appendChild(statusPopup);
    updateStatus('Starting scraper...');

    const scrapeCurrentPage = () => {
        const allDivs = document.querySelectorAll('div[data-qa="card-archived-proposals"]');
        const proposalsDiv = Array.from(allDivs).find(div => {
            const h2 = div.querySelector('h2');
            return h2 && h2.textContent.includes('Archived proposals');
        });

        if (!proposalsDiv) return null;
        
        const h2 = proposalsDiv.querySelector('h2');
        console.log('Section heading:', h2 ? h2.textContent.trim() : 'No h2 found');
        
        const table = proposalsDiv.querySelector('table');
        if (!table) return null;
        
        // Filter out already scraped proposals
        const links = Array.from(table.querySelectorAll('tr')).filter(row => {
            const reasonCell = row.querySelector('td[data-qa="reason-slot"]');
            if (!reasonCell) return false;
            
            const reason = reasonCell.textContent.trim();
            const link = row.querySelector('a');
            
            // Skip if not hired/withdrawn or if already scraped
            if (!(reason === 'Hired' || reason === 'Withdrawn')) return false;
            if (existingUrls.has(link.href)) return false;
            
            return true;
        }).map(row => {
            const link = row.querySelector('a');
            const timeCell = row.querySelector('td[data-cy="time-slot"]');
            return {
                href: link.href,
                text: link.textContent.trim(),
                reason: row.querySelector('td[data-qa="reason-slot"]').textContent.trim(),
                submissionTime: timeCell ? timeCell.textContent.trim() : 'N/A'
            };
        });
        
        return { links, proposalsDiv };
    };

    const waitForTable = () => {
        updateStatus('Waiting for table to load...');
        return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                const result = scrapeCurrentPage();
                if (result) {
                    clearInterval(checkInterval);
                    resolve(result);
                }
            }, 1000);

            setTimeout(() => {
                clearInterval(checkInterval);
                resolve(null);
            }, 30000);
        });
    };

    const visitProposalPage = async (linkData) => {
        try {
            const response = await fetch(linkData.href);
            const html = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            
            const descriptionDiv = doc.querySelector('div.description.text-body-sm');
            const description = descriptionDiv ? descriptionDiv.textContent.trim() : null;
            
            const coverLetterDiv = doc.querySelector('div[data-cy="cover-letter-section"]');
            const coverLetter = coverLetterDiv ? 
                coverLetterDiv.textContent
                    .replace(/Cover letter\s*Cover letter\s*/gi, '') // Remove duplicate "Cover letter" text
                    .replace(/^\s+|\s+$/g, '') // Remove leading/trailing whitespace
                    .replace(/\s+/g, ' ') // Replace multiple spaces with single space
                    .trim() 
                : null;
            
            const proposalData = {
                ...linkData,
                description,
                coverLetter,
                timestamp: new Date().toISOString()
            };
            
            // Add to local storage
            const storageUpdate = await chrome.storage.local.get('proposals');
            const proposals = storageUpdate.proposals || [];
            proposals.push(proposalData);
            await chrome.storage.local.set({ proposals });
            
            tableData.push(proposalData);
            updateStatus('Processing proposals...');
            
            return {
                description,
                coverLetter
            };
        } catch (error) {
            console.error('Error visiting proposal:', linkData.href, error);
            return null;
        }
    };

    try {
        while (true) {
            while (isPaused) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            const result = await waitForTable();
            if (!result) {
                updateStatus('No table found after timeout');
                console.log('Scraping timeout - no table found');
                break;
            }

            const { links, proposalsDiv } = result;
            
            if (links.length === 0) {
                updateStatus('No new proposals found on this page');
                console.log('No new proposals on current page');
            }
            
            // Find current page number and total pages
            const paginationButton = Array.from(proposalsDiv.querySelectorAll('button')).find(button => {
                const span = button.querySelector('span');
                return span && span.textContent.trim().includes('Current page');
            });
            
            let currentPage = '', totalPages = '';
            if (paginationButton) {
                const paginationText = paginationButton.querySelector('span').textContent.trim();
                const match = paginationText.match(/Current page (\d+) of (\d+)/);
                if (match) {
                    [, currentPage, totalPages] = match;
                }
            }

            // Process all proposals from current page
            updateStatus(`Processing proposals from page ${currentPage}...`, currentPage, totalPages);
            for (const link of links) {
                while (isPaused) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                allLinks.push(link);
                updateStatus(`Visiting proposal ${allLinks.length} (Page ${currentPage})...`, currentPage, totalPages);
                await visitProposalPage(link);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            // Find Next button within the proposals div
            const nextButton = Array.from(proposalsDiv.querySelectorAll('button')).find(button => {
                const span = button.querySelector('span');
                return span && span.textContent.trim().includes('Next');
            });

            if (!nextButton || nextButton.disabled) {
                updateStatus('Reached last page, finishing up...');
                break;
            }

            updateStatus('Moving to next page...', currentPage, totalPages);
            nextButton.click();
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        updateStatus('All done! Closing in 3 seconds...');
        console.log('Finished processing all proposals');
        setTimeout(() => {
            statusPopup.remove();
        }, 3000);

    } catch (error) {
        updateStatus(`Error: ${error.message}`);
        console.error('Scraping error:', error);
        setTimeout(() => {
            statusPopup.remove();
        }, 5000);
    }

    return allLinks;
} 