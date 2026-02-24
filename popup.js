// Tabby — Tab Organizer
// popup.js

const CHROME_GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

let allTabs = [];
let duplicates = [];

// ── Init ──
document.addEventListener('DOMContentLoaded', async () => {
  await scanTabs();

  document.getElementById('organizeBtn').addEventListener('click', organize);
  document.getElementById('closeDupes').addEventListener('click', closeDuplicates);
  document.getElementById('ungroupBtn').addEventListener('click', ungroupAll);
  document.getElementById('settingsBtn').addEventListener('click', toggleSettings);
  document.getElementById('saveKey').addEventListener('click', saveApiKey);

  // Load saved key
  chrome.storage.local.get('anthropic_key', (data) => {
    if (data.anthropic_key) {
      document.getElementById('apiKey').value = data.anthropic_key;
    }
  });
});

// ── Scan all tabs ──
async function scanTabs() {
  allTabs = await chrome.tabs.query({ currentWindow: true });

  // Find duplicates (same URL)
  const urlMap = {};
  duplicates = [];
  allTabs.forEach(tab => {
    const url = tab.url?.split('#')[0]; // ignore hash
    if (!url) return;
    if (urlMap[url]) {
      duplicates.push(tab);
    } else {
      urlMap[url] = tab;
    }
  });

  // Update stats
  document.getElementById('tabCount').textContent = allTabs.length;
  document.getElementById('dupeCount').textContent = duplicates.length;

  // Count existing groups
  const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
  document.getElementById('groupCount').textContent = groups.length;

  // Show duplicate banner
  if (duplicates.length > 0) {
    document.getElementById('dupeNum').textContent = duplicates.length;
    document.getElementById('dupeBanner').classList.add('show');
  }
}

// ── Close duplicates ──
async function closeDuplicates() {
  const ids = duplicates.map(t => t.id);
  if (ids.length === 0) return;

  await chrome.tabs.remove(ids);
  showStatus(`Closed ${ids.length} duplicate${ids.length > 1 ? 's' : ''} 🧹`);
  document.getElementById('dupeBanner').classList.remove('show');

  // Rescan
  await scanTabs();
}

// ── Organize tabs ──
async function organize() {
  const btn = document.getElementById('organizeBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="emoji">🐱</span> Tabby is thinking...';
  document.body.classList.add('organizing');

  try {
    // Get tabs that aren't already grouped
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const ungrouped = tabs.filter(t => t.groupId === -1 && t.url && !t.url.startsWith('chrome://'));

    if (ungrouped.length < 2) {
      showStatus('Not enough tabs to organize! 😸');
      return;
    }

    // Try AI categorization, fall back to smart local
    let categories;
    const storage = await chrome.storage.local.get('anthropic_key');
    const anthropic_key = storage.anthropic_key;
    console.log('[Tabby] API key present:', !!anthropic_key, 'key starts with:', anthropic_key ? anthropic_key.slice(0, 10) + '...' : 'none');

    if (anthropic_key && anthropic_key.length > 10) {
      console.log('[Tabby] Using AI categorization');
      try {
        categories = await categorizeWithAI(ungrouped, anthropic_key);
        console.log('[Tabby] AI result:', categories);
      } catch (aiErr) {
        console.error('[Tabby] AI failed, falling back to local:', aiErr);
        showStatus('AI failed: ' + aiErr.message + ' — using local mode', true);
        categories = categorizeLocal(ungrouped);
      }
    } else {
      console.log('[Tabby] No API key, using local categorization');
      categories = categorizeLocal(ungrouped);
    }

    // Create tab groups
    const resultsDiv = document.getElementById('results');
    resultsDiv.innerHTML = '';
    let colorIndex = 0;

    for (const [groupName, tabIds] of Object.entries(categories)) {
      if (tabIds.length === 0) continue;

      const color = CHROME_GROUP_COLORS[colorIndex % CHROME_GROUP_COLORS.length];
      const groupId = await chrome.tabs.group({ tabIds });
      await chrome.tabGroups.update(groupId, { title: groupName, color, collapsed: false });

      resultsDiv.innerHTML += `
        <div class="result-item">
          <div class="group-color" style="background: ${cssColor(color)}"></div>
          <span class="group-name">${groupName}</span>
          <span class="group-count">${tabIds.length} tab${tabIds.length > 1 ? 's' : ''}</span>
        </div>
      `;
      colorIndex++;
    }

    resultsDiv.classList.add('show');
    document.getElementById('groupCount').textContent = Object.keys(categories).length;
    showStatus(`Organized ${ungrouped.length} tabs into ${Object.keys(categories).length} groups ✨`);

  } catch (err) {
    showStatus('Something went wrong: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="emoji">🐱</span> Organize My Tabs';
    document.body.classList.remove('organizing');
  }
}

// ── AI Categorization (Anthropic Claude via background worker) ──
async function categorizeWithAI(tabs, apiKey) {
  const tabData = tabs.map(t => ({ id: t.id, title: t.title, url: new URL(t.url).hostname + new URL(t.url).pathname.slice(0, 50) }));

  const result = await chrome.runtime.sendMessage({
    type: 'anthropic',
    apiKey,
    system: 'You organize browser tabs into groups. Given a list of tabs with id, title, and url, return a JSON object where keys are short group names (1-2 words, lowercase) and values are arrays of tab ids. Use 3-7 groups max. Be smart about grouping — by topic, not by website. Return ONLY valid JSON, no markdown.',
    content: JSON.stringify(tabData)
  });

  if (result.error) throw new Error(result.error);

  let content = result.text.trim();
  content = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();

  return JSON.parse(content);
}

// ── Local Categorization (no API) ──
function categorizeLocal(tabs) {
  const categories = {};

  const rules = [
    { name: 'finance', patterns: ['coinbase.com', 'binance.com', 'robinhood.com', 'tradingview.com', 'opensea.io', 'etherscan.io', 'bankofamerica', 'chase.com', 'paypal.com', 'venmo.com', 'fidelity.com', 'schwab.com', 'vanguard.com', 'mint.com', 'creditkarma', 'wellsfargo', 'capitalone', 'sofi.com', 'webull.com', 'kraken.com', 'crypto.com', 'metamask.io', 'uniswap', 'dextools', 'dexscreener.com', 'birdeye.so', 'defined.fi', 'dex.guru', 'gecko.terminal', 'coingecko.com', 'coinmarketcap.com', 'blockchain.com', 'phantom.app', 'jupiter.ag', 'raydium.io', 'solscan.io', 'debank.com', 'zapper.fi', 'aave.com', 'lido.fi', 'wealthfront', 'betterment', 'plaid.com', 'stripe.com', 'wise.com', 'revolut.com', 'finance.yahoo.com', 'yahoo.com/finance', 'money.cnn', 'investor.', 'morningstar.com', 'seekingalpha.com', 'fool.com', 'finviz.com', 'stocktwits.com', 'tipranks.com', 'benzinga.com', 'zacks.com', 'crypto', 'swap', 'defi', 'token', 'wallet', 'finance', 'banking', 'invest', 'trading', 'stock', 'forex', 'etf'] },
    { name: 'social', patterns: ['twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'linkedin.com', 'reddit.com', 'tiktok.com', 'threads.net', 'mastodon', 'bsky.app', 'discord.com', 'snapchat.com'] },
    { name: 'video', patterns: ['youtube.com', 'netflix.com', 'twitch.tv', 'vimeo.com', 'hulu.com', 'disneyplus.com', 'hbomax.com', 'primevideo.com', 'peacock', 'crunchyroll'] },
    { name: 'shopping', patterns: ['amazon.com', 'ebay.com', 'etsy.com', 'walmart.com', 'target.com', 'bestbuy.com', 'shopify.com', 'shop.', 'nike.com', 'adidas.com', 'zara.com', 'grailed.com', 'stockx.com'] },
    { name: 'dev', patterns: ['github.com', 'gitlab.com', 'stackoverflow.com', 'npmjs.com', 'codepen.io', 'vercel.com', 'netlify.com', 'localhost', 'developer.', 'docs.', 'replit.com', 'codesandbox'] },
    { name: 'email', patterns: ['mail.google', 'outlook.', 'mail.yahoo', 'protonmail', 'fastmail'] },
    { name: 'docs', patterns: ['docs.google', 'notion.so', 'drive.google', 'sheets.google', 'slides.google', 'dropbox.com', 'airtable.com', 'figma.com', 'canva.com', 'miro.com'] },
    { name: 'news', patterns: ['cnn.com', 'bbc.com', 'nytimes.com', 'reuters.com', 'techcrunch.com', 'theverge.com', 'arstechnica.com', 'news.ycombinator', 'bloomberg.com', 'cnbc.com', 'wsj.com', 'ft.com', 'marketwatch'] },
    { name: 'music', patterns: ['spotify.com', 'soundcloud.com', 'music.apple', 'music.youtube', 'bandcamp.com', 'tidal.com'] },
    { name: 'ai', patterns: ['chat.openai', 'claude.ai', 'bard.google', 'midjourney', 'perplexity.ai', 'huggingface.co', 'anthropic.com', 'poe.com', 'character.ai'] },
    { name: 'travel', patterns: ['airbnb.com', 'booking.com', 'expedia.com', 'kayak.com', 'google.com/travel', 'hotels.com', 'tripadvisor', 'skyscanner', 'united.com', 'delta.com', 'southwest.com'] },
    { name: 'food', patterns: ['doordash.com', 'ubereats.com', 'grubhub.com', 'seamless.com', 'yelp.com', 'opentable.com', 'resy.com', 'caviar.com'] },
  ];

  const other = [];

  tabs.forEach(tab => {
    const url = (tab.url || '').toLowerCase();
    let matched = false;

    for (const rule of rules) {
      if (rule.patterns.some(p => url.includes(p))) {
        if (!categories[rule.name]) categories[rule.name] = [];
        categories[rule.name].push(tab.id);
        matched = true;
        break;
      }
    }

    if (!matched) other.push(tab.id);
  });

  if (other.length > 0) {
    categories['other'] = other;
  }

  return categories;
}

// ── Ungroup all tabs ──
async function ungroupAll() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const groupedTabs = tabs.filter(t => t.groupId !== -1);

  if (groupedTabs.length === 0) {
    showStatus('No groups to undo 😸');
    return;
  }

  for (const tab of groupedTabs) {
    await chrome.tabs.ungroup(tab.id);
  }

  document.getElementById('results').classList.remove('show');
  document.getElementById('results').innerHTML = '';
  document.getElementById('groupCount').textContent = '0';
  showStatus(`Ungrouped ${groupedTabs.length} tabs — back to normal 🐾`);
}

// ── Helpers ──
function cssColor(chromeColor) {
  const map = {
    grey: '#888', blue: '#4a9eff', red: '#f87171', yellow: '#f9a826',
    green: '#4ade80', pink: '#f472b6', purple: '#a78bfa', cyan: '#22d3ee', orange: '#fb923c'
  };
  return map[chromeColor] || '#888';
}

function showStatus(msg, isError = false) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status show' + (isError ? ' error' : '');
  setTimeout(() => el.classList.remove('show'), 4000);
}

function toggleSettings() {
  document.getElementById('settingsPanel').classList.toggle('show');
}

function saveApiKey() {
  const key = document.getElementById('apiKey').value.trim();
  console.log('[Tabby] Saving key, length:', key.length, 'starts with:', key.slice(0, 10));
  chrome.storage.local.set({ anthropic_key: key }, () => {
    if (chrome.runtime.lastError) {
      showStatus('Error saving: ' + chrome.runtime.lastError.message, true);
      return;
    }
    // Verify it saved
    chrome.storage.local.get('anthropic_key', (data) => {
      console.log('[Tabby] Verified saved key length:', data.anthropic_key?.length);
      showStatus(key ? `API key saved 🔑 (${key.length} chars)` : 'API key cleared');
    });
  });
}
