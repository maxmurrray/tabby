// background.js — handles Anthropic API calls (bypasses CORS)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'anthropic') {
    fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': msg.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-3-5-20241022',
        max_tokens: 1000,
        system: msg.system,
        messages: [{ role: 'user', content: msg.content }]
      })
    })
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          sendResponse({ error: data.error.message });
        } else {
          sendResponse({ text: data.content[0].text });
        }
      })
      .catch(err => sendResponse({ error: err.message }));
    return true; // keep channel open for async response
  }
});
