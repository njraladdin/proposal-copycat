async function checkUpworkAuth() {
    const startScrapingBtn = document.getElementById('startScraping');
    
    try {
        const response = await fetch('https://www.upwork.com/nx/proposals/archived');
        const html = await response.text();
        
        // Check if the page contains login-related text
        if (html.includes('Log in to Upwork') || html.includes('Continue with Google')) {
            showAuthWarning(startScrapingBtn);
            return false;
        }
        
        // Remove warning if it exists and enable button
        removeAuthWarning();
        startScrapingBtn.disabled = false;
        return true;
        
    } catch (error) {
        console.error('Error checking auth:', error);
        showAuthWarning(startScrapingBtn);
        return false;
    }
}

function showAuthWarning(button) {
    removeAuthWarning(); // Remove any existing warning
    
    const warning = document.createElement('div');
    warning.className = 'auth-warning';
    warning.innerHTML = `
        Please sign in to Upwork first!
    `;
    
    // Insert warning before the button
    button.parentNode.insertBefore(warning, button);
    button.disabled = true;
}

function removeAuthWarning() {
    const existingWarning = document.querySelector('.auth-warning');
    if (existingWarning) {
        existingWarning.remove();
    }
}

function displayProposals(proposals) {
    const tableContainer = document.getElementById('proposalsTable');
    const proposalCount = document.getElementById('proposalCount');
    
    proposalCount.textContent = proposals ? proposals.length : 0;
    
    if (!proposals || proposals.length === 0) {
        tableContainer.innerHTML = '<div class="empty-state">No proposals found. Click "Start Scraping" to begin.</div>';
        return;
    }

    const table = `<table class="proposals-table"><thead><tr>
        <th>Job Title</th>
        <th>Job Description</th>
        <th>Proposal</th>
        <th></th>
    </tr></thead><tbody>${proposals.map(proposal => `<tr>
        <td class="title-cell">${cleanText(proposal.text).substring(0, 200)}${proposal.text.length > 200 ? '...' : ''}</td>
        <td class="description-cell">${proposal.description ? cleanText(proposal.description).substring(0, 200) + '...' : 'N/A'}</td>
        <td class="description-cell">${proposal.coverLetter ? cleanText(proposal.coverLetter).substring(0, 200) + '...' : 'N/A'}</td>
        <td class="link-cell">
            ${proposal.href ? `<a href="${proposal.href}" target="_blank" class="job-link" title="Open job post">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                    <polyline points="15 3 21 3 21 9"></polyline>
                    <line x1="10" y1="14" x2="21" y2="3"></line>
                </svg>
            </a>` : 'N/A'}
        </td>
    </tr>`).join('')}</tbody></table>`;
    
    tableContainer.innerHTML = table;
}

// Load and display proposals when popup opens
document.addEventListener('DOMContentLoaded', async () => {
    const data = await chrome.storage.local.get('proposals');
    displayProposals(data.proposals);
    
    // Update step states based on data
    updateStepStates(data.proposals);
    
    // Check auth status
    await checkUpworkAuth();
    
    // Add event listener for history limit changes
    const historyLimitSelect = document.getElementById('historyLimit');
    historyLimitSelect.addEventListener('change', (event) => {
        console.log('History limit changed to:', event.target.value); // For debugging
    });
});

// Start scraping button
document.getElementById('startScraping').addEventListener('click', async () => {
    chrome.runtime.sendMessage({ action: 'startScraping' });
    window.close();
});

// Clear data button
document.getElementById('clearData').addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear all stored proposals?')) {
        await chrome.storage.local.remove('proposals');
        displayProposals([]);
    }
});

// Listen for storage changes to update the display
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.proposals) {
        displayProposals(changes.proposals.newValue);
        updateStepStates(changes.proposals.newValue);
    }
});

// Default prompt text
const defaultPrompt = `<context> I am a freelancer on Upwork seeking assistance with proposal writing. I have a history of job posts I've applied to and the corresponding proposals I've submitted for those jobs. </context>
<mission> Your task is to analyze my past job applications and proposals, then write a new proposal for a similar job posting. The new proposal should closely emulate my previous work in terms of style, content, and overall approach. </mission>
<emulation> When crafting the new proposal, pay careful attention to and replicate the following aspects of my previous proposals:
- Writing style and tone
- Level of English proficiency
- Sentence structure and complexity
- Punctuation habits
- Capitalization style
- Formatting choices
- Length and level of detail
- Any unique phrases or expressions I tend to use
- How I introduce myself and my skills
- How I address the client's specific needs
- Any consistent closing remarks or call-to-action
The goal is to create a proposal that seems as if I wrote it myself, maintaining consistency with my established writing patterns and style. </emulation>`;

// Initialize prompt in storage if it doesn't exist
chrome.storage.local.get('prompt', (data) => {
    if (!data.prompt) {
        chrome.storage.local.set({ prompt: defaultPrompt });
    }
});

// Edit prompt button handler
document.getElementById('editPrompt').addEventListener('click', () => {
    const modal = document.getElementById('promptModal');
    modal.style.display = 'block';
    
    // Load existing prompt
    chrome.storage.local.get('prompt', (data) => {
        document.getElementById('promptInput').value = data.prompt || defaultPrompt;
    });
});

// Save prompt button handler
document.getElementById('savePrompt').addEventListener('click', async () => {
    const promptText = document.getElementById('promptInput').value;
    await chrome.storage.local.set({ 
        prompt: promptText,
        promptEdited: true
    });
    document.getElementById('promptModal').style.display = 'none';
    
    // Update step states
    const data = await chrome.storage.local.get('proposals');
    updateStepStates(data.proposals);
});

// Cancel prompt button handler
document.getElementById('cancelPrompt').addEventListener('click', () => {
    document.getElementById('promptModal').style.display = 'none';
});

// Update the copyData event listener
document.getElementById('copyData').addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const currentUrl = tabs[0].url;
    
    if (!currentUrl.match(/upwork\.com\/nx\/proposals\/job\/.*\/apply/)) {
        showTooltip(document.getElementById('copyData'), 'Please visit a job post first!');
        return;
    }
    
    // Get the job post content by injecting a script into the current tab
    const [jobPostResult] = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        function: () => {
            // Try to click "Show More" button if it exists and has text "more"
            const showMoreButton = document.querySelector('#main > div.container > div:nth-child(4) > div > div > div:nth-child(3) > div.fe-job-details > div > section > div:nth-child(1) > div.content.span-md-8.span-lg-9 > div > div > span > span:nth-child(2) > button');
            if (showMoreButton && showMoreButton.querySelector('span')?.textContent.trim().toLowerCase() === 'more') {
                showMoreButton.click();
                // Give it a moment to expand
                return new Promise(resolve => {
                    setTimeout(() => {
                        const jobPostElement = document.querySelector('#air3-truncation-1');
                        resolve(jobPostElement ? jobPostElement.textContent.trim() : '');
                    }, 500);
                });
            } else {
                // If no show more button or button text isn't "more", get content directly
                const jobPostElement = document.querySelector('#air3-truncation-1');
                return jobPostElement ? jobPostElement.textContent.trim() : '';
            }
        }
    });
    
    const jobPostContent = jobPostResult.result;
    
    // Show the modal
    const modal = document.getElementById('generateModal');
    const outputArea = document.getElementById('generateOutput');
    modal.style.display = 'block';
    
    // Function to generate output text
    const generateOutputText = async () => {
        const data = await chrome.storage.local.get(['proposals', 'portfolio', 'prompt']);
        const historyLimit = document.getElementById('historyLimit').value;
        
        let proposalsToInclude = [...data.proposals];
        
        // Apply the history limit if not set to 'all'
        if (historyLimit !== 'all') {
            const limit = parseInt(historyLimit);
            proposalsToInclude = proposalsToInclude.slice(-limit);
        }
        
        let output = '';
        
        // Add proposals and job posts with limit
        proposalsToInclude.forEach((proposal) => {
            output += '<job_post>\n';
            output += proposal.description || 'No job description available';
            output += '\n</job_post>\n';
            output += '<proposal>\n';
            output += 'Cover letter: ' + (proposal.coverLetter || 'No cover letter available');
            output += '\n</proposal>\n';
        });
        
        // Add portfolio
        if (data.portfolio) {
            output += '\n<portfolio>\n';
            output += '# Portfolio Project Descriptions\n\n';
            data.portfolio.forEach((item, index) => {
                output += `${index + 1}. ${item}\n`;
            });
            output += '\n</portfolio>\n';
        }
        
        // Add the custom prompt
        output += '\n' + (data.prompt || defaultPrompt);
        
        // Add the current job post at the bottom
        output += '\n\n<current_job_post>\n';
        output += jobPostContent || 'Error: Could not fetch job post content';
        output += '\n</current_job_post>';
        
        return output;
    };
    
    // Generate initial output
    const output = await generateOutputText();
    outputArea.value = output;
    
    // Create a wrapper div for the formatted content
    const formattedWrapper = document.createElement('div');
    formattedWrapper.className = 'formatted-output';
    formattedWrapper.innerHTML = formatPromptText(output);
    
    // Replace any existing formatted output
    const existingFormatted = modal.querySelector('.formatted-output');
    if (existingFormatted) {
        existingFormatted.remove();
    }
    
    // Add the new formatted output
    outputArea.style.display = 'none';
    outputArea.parentNode.insertBefore(formattedWrapper, outputArea);
    
    // Add event listener for history limit changes
    const historyLimitSelect = document.getElementById('historyLimit');
    historyLimitSelect.addEventListener('change', async () => {
        const newOutput = await generateOutputText();
        outputArea.value = newOutput;
        formattedWrapper.innerHTML = formatPromptText(newOutput);
    });
});

// Update the updateStepStates function to handle the new step
function updateStepStates(proposals) {
    // Get current tab URL first
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const currentUrl = tabs[0].url;
        const isOnJobPage = currentUrl.match(/upwork\.com\/nx\/proposals\/job\/.*\/apply/);
        
        const step1 = document.getElementById('step1');
        const step2 = document.getElementById('step2');
        const step3 = document.getElementById('step3');
        const step4 = document.getElementById('step4');
        
        chrome.storage.local.get(['portfolio', 'prompt', 'promptEdited'], (data) => {
            const hasProposals = proposals && proposals.length > 0;
            const hasPortfolio = data.portfolio && data.portfolio.length > 0;
            const hasPrompt = data.prompt && data.prompt.trim().length > 0;
            const hasEditedPrompt = data.promptEdited;
            
            // Step 1: Scrape Proposals
            if (hasProposals) {
                step1.querySelector('.step-status').textContent = 'Done';
                step1.querySelector('.step-status').className = 'step-status status-completed';
                step1.classList.add('completed');
                step1.classList.remove('ready');
            } else {
                step1.querySelector('.step-status').textContent = 'Done';
                step1.querySelector('.step-status').className = 'step-status status-inactive';
                step1.classList.remove('completed', 'ready');
            }
            
            // Step 2: Portfolio
            if (hasPortfolio) {
                step2.querySelector('.step-status').textContent = 'Done';
                step2.querySelector('.step-status').className = 'step-status status-completed';
                step2.classList.add('completed');
                step2.classList.remove('ready');
            } else {
                step2.querySelector('.step-status').textContent = 'Done';
                step2.querySelector('.step-status').className = 'step-status status-inactive';
                step2.classList.remove('completed', 'ready');
            }
            
            // Update step 3 (Prompt)
            if (hasPrompt && hasEditedPrompt) {
                step3.querySelector('.step-status').textContent = 'Done';
                step3.querySelector('.step-status').className = 'step-status status-completed';
                step3.classList.add('completed');
                step3.classList.remove('ready');
            } else {
                step3.querySelector('.step-status').textContent = 'Not Started';
                step3.querySelector('.step-status').className = 'step-status status-inactive';
                step3.classList.remove('completed', 'ready');
            }
            
            // Update step 4 status
            const generateButton = document.getElementById('copyData');
            if (hasProposals && hasPortfolio && hasPrompt && hasEditedPrompt && isOnJobPage) {
                step4.querySelector('.step-status').textContent = 'Ready';
                step4.querySelector('.step-status').className = 'step-status status-ready';
                step4.classList.add('ready');
                step4.classList.remove('completed');
                step4.querySelector('.step-number').classList.add('ready-number');
                generateButton.classList.add('ready');
                generateButton.title = ''; // Clear any existing tooltip
            } else {
                step4.querySelector('.step-status').textContent = isOnJobPage ? 'Not Ready' : 'Visit a Job Post';
                step4.querySelector('.step-status').className = 'step-status status-inactive';
                step4.classList.remove('completed', 'ready');
                step4.querySelector('.step-number').classList.remove('ready-number');
                generateButton.classList.remove('ready');
                
                // Set appropriate tooltip message
                if (!isOnJobPage) {
                    generateButton.title = 'Please visit a job post first';
                } else if (!hasProposals) {
                    generateButton.title = 'Please scrape your proposals first';
                } else if (!hasPortfolio) {
                    generateButton.title = 'Please add your portfolio first';
                } else if (!hasPrompt || !hasEditedPrompt) {
                    generateButton.title = 'Please edit and save the prompt first';
                }
            }
        });
    });
}

// Add listeners for new buttons
document.getElementById('startPortfolio').addEventListener('click', () => {
    const modal = document.getElementById('portfolioModal');
    modal.style.display = 'block';
    
    // Load existing portfolio data if any
    chrome.storage.local.get('portfolio', (data) => {
        if (data.portfolio) {
            document.getElementById('portfolioInput').value = data.portfolio.join('\n');
        }
    });
});

// Add modal action listeners
document.getElementById('savePortfolio').addEventListener('click', async () => {
    const portfolioText = document.getElementById('portfolioInput').value;
    const portfolioItems = portfolioText.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
    
    await chrome.storage.local.set({ portfolio: portfolioItems });
    document.getElementById('portfolioModal').style.display = 'none';
    
    // Update step states after saving
    const data = await chrome.storage.local.get('proposals');
    updateStepStates(data.proposals);
});

document.getElementById('cancelPortfolio').addEventListener('click', () => {
    document.getElementById('portfolioModal').style.display = 'none';
});

// Close modal if clicking outside
window.addEventListener('click', (event) => {
    const modal = document.getElementById('portfolioModal');
    if (event.target === modal) {
        modal.style.display = 'none';
    }
});

function cleanText(text) {
    return text.replace(/\s+/g, ' ').trim();
}

// Update the button HTML to remove spans with icons
document.getElementById('startScraping').innerHTML = 'Start Scraping';
document.getElementById('clearData').innerHTML = 'Clear Data';
document.getElementById('startPortfolio').innerHTML = 'Add Portfolio';

// Update the button text
document.getElementById('copyData').innerHTML = 'Generate';



// Add handlers for the new modal buttons
document.getElementById('copyGenerated').addEventListener('click', async () => {
    const outputArea = document.getElementById('generateOutput');
    await navigator.clipboard.writeText(outputArea.value);
    
    // Change button text temporarily to show success
    const copyBtn = document.getElementById('copyGenerated');
    const originalText = copyBtn.innerHTML;
    copyBtn.innerHTML = 'Copied!';
    
    // Show the tip message
    const tipMessage = document.querySelector('.modal-description[style*="margin-top"]');
    tipMessage.style.display = 'block'; // Show the message
    tipMessage.style.animation = 'fadeIn 0.3s ease-in'; // Optional: add animation
    
    setTimeout(() => {
        copyBtn.innerHTML = originalText;
    }, 2000);
});

document.getElementById('closeGenerate').addEventListener('click', () => {
    document.getElementById('generateModal').style.display = 'none';
});

// Update modal close on outside click
window.addEventListener('click', (event) => {
    const portfolioModal = document.getElementById('portfolioModal');
    const promptModal = document.getElementById('promptModal');
    const generateModal = document.getElementById('generateModal');
    
    if (event.target === portfolioModal) {
        portfolioModal.style.display = 'none';
    }
    if (event.target === promptModal) {
        promptModal.style.display = 'none';
    }
    if (event.target === generateModal) {
        generateModal.style.display = 'none';
    }
});

// Add this to your existing CSS or add it inline in popup.html
const style = document.createElement('style');
style.textContent = `
    .modal-description[style*="margin-top"] {
        display: none;  /* Hidden by default */
    }
    
    @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
    }
`;
document.head.appendChild(style); 

// Add these new functions for tooltip handling
function showTooltip(element, message) {
    // Remove any existing tooltip
    removeTooltip();
    
    // Create tooltip element
    const tooltip = document.createElement('div');
    tooltip.className = 'custom-tooltip';
    tooltip.textContent = message;
    
    // Position the tooltip above the element
    const rect = element.getBoundingClientRect();
    tooltip.style.position = 'absolute';
    tooltip.style.top = `${rect.top - 30}px`; // Position above the button
    tooltip.style.left = `${rect.left + (rect.width / 2)}px`;
    
    // Add tooltip to the document
    document.body.appendChild(tooltip);
    
    // Remove tooltip after 3 seconds
    setTimeout(removeTooltip, 3000);
}

function removeTooltip() {
    const existingTooltip = document.querySelector('.custom-tooltip');
    if (existingTooltip) {
        existingTooltip.remove();
    }
}

// Update the tooltip CSS
const tooltipStyle = document.createElement('style');
tooltipStyle.textContent = `
    .custom-tooltip {
        background-color: #333;
        color: white;
        padding: 6px 10px;
        border-radius: 4px;
        font-size: 12px;
        transform: translateX(-50%) translateY(-50%);
        white-space: normal; /* Changed from nowrap to normal */
        max-width: 200px; /* Added max-width */
        text-align: center; /* Center the text */
        z-index: 1000;
        animation: fadeInOut 3s ease-in-out;
    }

    .custom-tooltip::after {
        content: '';
        position: absolute;
        top: 100%;
        left: 50%;
        margin-left: -5px;
        border-width: 5px;
        border-style: solid;
        border-color: #333 transparent transparent transparent;
    }

    @keyframes fadeInOut {
        0% { opacity: 0; }
        10% { opacity: 1; }
        90% { opacity: 1; }
        100% { opacity: 0; }
    }
`;
document.head.appendChild(tooltipStyle); 

// Add style for the warning
const authStyle = document.createElement('style');
authStyle.textContent = `
    .auth-warning {
        position: absolute;
        top: -30px;
        left: 50%;
        transform: translateX(-50%);
        background: #fff3cd;
        color: #856404;
        padding: 8px 12px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        display: flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
        z-index: 1000;
        animation: slideIn 0.3s ease-out;
    }
    
    .warning-icon {
        font-size: 14px;
    }
    
    @keyframes slideIn {
        from {
            opacity: 0;
            transform: translate(-50%, -10px);
        }
        to {
            opacity: 1;
            transform: translate(-50%, 0);
        }
    }
    
    button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }
`;
document.head.appendChild(authStyle); 

// Update the formatting function
function formatPromptText(text) {
    // Split the text into sections based on XML-like tags
    const sections = text.split(/(?=<(?:job_post|proposal|portfolio|context|mission|emulation|current_job_post)>)/g);
    
    return sections.map(section => {
        if (!section.trim()) return '';
        
        // Extract the tag and content
        const tagMatch = section.match(/<([^>]+)>([\s\S]*?)(?=<\/\1>|$)/);
        if (!tagMatch) return section; // Return as-is if no tag found
        
        const [_, tagName, content] = tagMatch;
        
        // Create a section with the tag and its content
        return `
            <div class="prompt-section">
                <div class="tag-header">&lt;${tagName}&gt;</div>
                <div class="section-content">${content.trim()}</div>
                <div class="tag-footer">&lt;/${tagName}&gt;</div>
            </div>
        `;
    }).join('');
}

// Update the styles
const promptStyle = document.createElement('style');
promptStyle.textContent = `
    .formatted-output {
        width: 80%;
        max-width: 100%;
        height: 230px;
        padding: 12px;
        border: 1px solid #e6e8eb;
        border-radius: 8px;
        background: #f8fafc;
        overflow-y: auto;
        font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', monospace;
        font-size: 13px;
        line-height: 1.5;
    }

    .prompt-section {
        margin-bottom: 8px;
        padding: 8px;
        backgdround: white;
        border-radius: 6px;
        bordder: 1px solid #edf2f7;
        boxshadow: 0 1px 2px rgba(0, 0, 0, 0.05);
    }

    .tag-header {
        color: #805ad5;
        font-weight: 500;
        margin-bottom: 4px;
        font-size: 13px;
        line-height: 1.2;
    }

    .tag-footer {
        color: #805ad5;
        font-weight: 500;
        margin-top: 4px;
        font-size: 13px;
        line-height: 1.2;
    }

    .section-content {
        padding: 4px 0;
        color: #2d3748;
        bordertop: 1px solid #edf2f7;
        borderbottom: 1px solid #edf2f7;
    }

    .formatted-output::-webkit-scrollbar {
        width: 8px;
    }

    .formatted-output::-webkit-scrollbar-track {
        background: #f1f1f1;
        border-radius: 4px;
    }

    .formatted-output::-webkit-scrollbar-thumb {
        background: #cbd5e0;
        border-radius: 4px;
    }

    .formatted-output::-webkit-scrollbar-thumb:hover {
        background: #a0aec0;
    }

    #generateModal .modal-content {
        width: 90%;
        max-width: 740px;
        max-height: 90vh;
        overflow-y: auto;
        padding: 24px;
    }
`;
document.head.appendChild(promptStyle); 