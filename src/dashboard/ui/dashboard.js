/* ============================================================
   LLM Engine Dashboard - Client-Side Logic
   Vanilla JS, module pattern, no frameworks, no build step
   ============================================================ */

(function () {
  'use strict';

  // --- Configuration ---
  const POLL_INTERVAL_MS = 2000;
  const MAX_ACTIVITY_ENTRIES = 50;
  const API_URL = '/api/status';

  // --- State ---
  let pollingTimer = null;
  let lastSeenRequestId = null;
  let lastModelHash = '';
  let isConnected = false;
  let lastFetchTimestamp = null;

  // --- DOM References (cached on init) ---
  const dom = {};

  function cacheDom() {
    dom.connectionDot = document.getElementById('connection-dot');
    dom.connectionText = document.getElementById('connection-text');
    dom.lastUpdated = document.getElementById('last-updated');
    dom.autoRefresh = document.getElementById('auto-refresh');
    dom.providerCards = document.getElementById('provider-cards');
    dom.activityList = document.getElementById('activity-list');
    dom.activityCount = document.getElementById('activity-count');
    dom.modelSearch = document.getElementById('model-search');
    dom.modelTableBody = document.getElementById('model-table-body');
    dom.statTotalRequests = document.getElementById('stat-total-requests');
    dom.statSuccessRate = document.getElementById('stat-success-rate');
    dom.statAvgLatency = document.getElementById('stat-avg-latency');
    dom.statTopProvider = document.getElementById('stat-top-provider');
    // Fleet collapse
    dom.fleetCollapse = document.getElementById('fleet-collapse');
    dom.fleetCardsWrapper = document.getElementById('fleet-cards-wrapper');
    // Console
    dom.consoleProvider = document.getElementById('console-provider');
    dom.consoleModel = document.getElementById('console-model');
    dom.consoleMessages = document.getElementById('console-messages');
    dom.consoleInput = document.getElementById('console-input');
    dom.consoleSend = document.getElementById('console-send');
    dom.consoleNewChat = document.getElementById('console-new-chat');
    dom.consoleSystemPrompt = document.getElementById('console-system-prompt');
    dom.consoleMaxTokens = document.getElementById('console-max-tokens');
    // Size toggle buttons (S/M/L)
    dom.sizeToggleButtons = document.querySelectorAll('.size-toggle-btn');
  }

  // --- Utility Functions ---

  function formatTimestamp(ts) {
    const date = new Date(ts);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }

  function formatContextWindow(size) {
    if (!size || size <= 0) return '--';
    if (size >= 1000000) {
      return `${(size / 1000000).toFixed(1)}M`;
    }
    if (size >= 1000) {
      return `${(size / 1000).toFixed(0)}K`;
    }
    return String(size);
  }

  function formatNumber(n) {
    if (n >= 1000000) {
      return `${(n / 1000000).toFixed(1)}M`;
    }
    if (n >= 1000) {
      return `${(n / 1000).toFixed(1)}K`;
    }
    return String(n);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function computeGaugeColor(ratio) {
    if (ratio > 0.5) return 'var(--healthy)';
    if (ratio > 0.2) return 'var(--degraded)';
    return 'var(--unavailable)';
  }

  function hashModels(models) {
    return models.map(m => `${m.id}:${m.provider}:${m.contextWindow}`).join('|');
  }

  function getRateLimitLabel(type) {
    const labels = { rpm: 'RPM', rpd: 'RPD', tpm: 'TPM' };
    return labels[type] || type.toUpperCase();
  }

  // --- Connection Status ---

  function setConnectionStatus(connected) {
    isConnected = connected;
    dom.connectionDot.className = 'connection-dot ' + (connected ? 'connected' : 'disconnected');
    dom.connectionText.textContent = connected ? 'Connected' : 'Disconnected';
  }

  function updateLastUpdated() {
    if (!lastFetchTimestamp) {
      dom.lastUpdated.textContent = '--';
      dom.lastUpdated.style.display = '';
      return;
    }
    const elapsed = Math.floor((Date.now() - lastFetchTimestamp) / 1000);
    // Hide the timer when connected and fresh — QA found it confusing
    if (isConnected && elapsed < 5) {
      dom.lastUpdated.style.display = 'none';
    } else {
      dom.lastUpdated.style.display = '';
      dom.lastUpdated.textContent = `${elapsed}s ago`;
    }
  }

  // --- Fetch ---

  async function fetchStatus() {
    try {
      const response = await fetch(API_URL);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      setConnectionStatus(true);
      lastFetchTimestamp = Date.now();
      processData(data);
    } catch (err) {
      setConnectionStatus(false);
      // Do not clear existing data on error
    }
  }

  function processData(data) {
    renderProviders(data.providers || []);
    renderModels(data.models || []);
    renderActivity(data.recentRequests || []);
    renderStats(data.recentRequests || []);
  }

  // --- Render: Providers ---

  function renderProviders(providers) {
    const container = dom.providerCards;

    if (providers.length === 0) {
      container.innerHTML = '<div class="empty-state">No providers available</div>';
      return;
    }

    // Remove stale empty-state placeholder
    const placeholder = container.querySelector('.empty-state');
    if (placeholder) placeholder.remove();

    // Build a set of provider IDs we expect
    const expectedIds = new Set(providers.map(p => p.id));

    // Remove cards for providers that no longer exist
    container.querySelectorAll('.provider-card').forEach(card => {
      if (!expectedIds.has(card.getAttribute('data-provider-id'))) {
        card.remove();
      }
    });

    providers.forEach(provider => {
      const existing = container.querySelector(
        `.provider-card[data-provider-id="${CSS.escape(provider.id)}"]`
      );

      if (existing) {
        updateProviderCard(existing, provider);
      } else {
        container.appendChild(createProviderCard(provider));
      }
    });
  }

  function createProviderCard(provider) {
    const card = document.createElement('div');
    card.className = 'provider-card';
    card.setAttribute('role', 'listitem');
    card.setAttribute('data-provider-id', provider.id);
    card.setAttribute('aria-label', `${provider.name} provider status`);

    const stateClass = provider.state || 'unavailable';
    const stateLabel = formatState(provider.state);
    const circuitLabel = provider.circuitState || 'unknown';

    card.innerHTML = `
      <div class="provider-card-header">
        <span class="provider-name">${escapeHtml(provider.name)}</span>
        <span class="state-badge ${stateClass}" aria-label="State: ${stateLabel}">
          <span class="state-dot"></span>
          <span class="state-text">${stateLabel}</span>
        </span>
      </div>
      <div class="circuit-state">
        Circuit: <span class="circuit-state-value ${escapeHtml(provider.circuitState || '')}">${escapeHtml(circuitLabel)}</span>
      </div>
    `;

    if (provider.rateLimits && provider.rateLimits.length > 0) {
      card.appendChild(buildRateLimitsElement(provider.rateLimits));
    }

    return card;
  }

  function updateProviderCard(card, provider) {
    const stateClass = provider.state || 'unavailable';
    const stateLabel = formatState(provider.state);
    const circuitLabel = provider.circuitState || 'unknown';

    // Update state badge
    const badge = card.querySelector('.state-badge');
    if (badge) {
      badge.className = `state-badge ${stateClass}`;
      badge.setAttribute('aria-label', `State: ${stateLabel}`);
      const stateText = badge.querySelector('.state-text');
      if (stateText && stateText.textContent !== stateLabel) {
        stateText.textContent = stateLabel;
      }
    }

    // Update circuit state
    const circuitVal = card.querySelector('.circuit-state-value');
    if (circuitVal) {
      circuitVal.textContent = circuitLabel;
      circuitVal.className = `circuit-state-value ${escapeHtml(provider.circuitState || '')}`;
    }

    // Update rate limit gauges in place
    if (provider.rateLimits && provider.rateLimits.length > 0) {
      let limitsContainer = card.querySelector('.rate-limits');
      if (!limitsContainer) {
        card.appendChild(buildRateLimitsElement(provider.rateLimits));
        return;
      }

      provider.rateLimits.forEach((rl, i) => {
        let gauge = limitsContainer.children[i];

        if (!gauge) {
          gauge = createGaugeElement();
          limitsContainer.appendChild(gauge);
        }

        updateGauge(gauge, rl);
      });

      // Remove extra gauges
      while (limitsContainer.children.length > provider.rateLimits.length) {
        limitsContainer.removeChild(limitsContainer.lastChild);
      }
    }
  }

  function buildRateLimitsElement(rateLimits) {
    const div = document.createElement('div');
    div.className = 'rate-limits';
    rateLimits.forEach(rl => {
      const gauge = createGaugeElement();
      updateGauge(gauge, rl);
      div.appendChild(gauge);
    });
    return div;
  }

  function createGaugeElement() {
    const gauge = document.createElement('div');
    gauge.className = 'rate-gauge';
    gauge.innerHTML = `
      <div class="gauge-ring">
        <div class="gauge-ring-inner">
          <span class="gauge-percent"></span>
        </div>
      </div>
      <span class="gauge-label"></span>
    `;
    return gauge;
  }

  function updateGauge(gauge, rl) {
    const ratio = rl.total > 0 ? rl.remaining / rl.total : 0;
    const percent = Math.round(ratio * 100);
    const color = computeGaugeColor(ratio);
    const angle = ratio * 360;

    gauge.setAttribute('aria-label',
      `${getRateLimitLabel(rl.type)}: ${rl.remaining} of ${rl.total} remaining`);
    gauge.querySelector('.gauge-ring').style.background =
      `conic-gradient(${color} ${angle}deg, var(--border) ${angle}deg)`;
    gauge.querySelector('.gauge-percent').textContent = `${percent}%`;
    gauge.querySelector('.gauge-label').textContent = getRateLimitLabel(rl.type);
  }

  function formatState(state) {
    if (!state) return 'Unknown';
    return state.charAt(0).toUpperCase() + state.slice(1);
  }

  // --- Render: Models ---

  let currentModels = [];

  function renderModels(models) {
    const newHash = hashModels(models);
    const searchTerm = dom.modelSearch.value;

    if (newHash !== lastModelHash) {
      lastModelHash = newHash;
      currentModels = models;
      renderModelTable(models, searchTerm);
      updateConsoleSelects(models);
    }
  }

  function renderModelTable(models, searchTerm) {
    const filtered = filterModels(models, searchTerm);
    const tbody = dom.modelTableBody;
    tbody.innerHTML = '';

    if (filtered.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="4" class="empty-state">${
        searchTerm ? 'No models match your filter' : 'No models available'
      }</td>`;
      tbody.appendChild(tr);
      return;
    }

    filtered.forEach(model => {
      const tr = document.createElement('tr');
      const caps = (model.capabilities || [])
        .map(c => `<span class="capability-tag">${escapeHtml(c)}</span>`)
        .join('');

      tr.innerHTML = `
        <td class="model-id">${escapeHtml(model.id)}</td>
        <td class="model-provider">${escapeHtml(model.provider)}</td>
        <td class="model-context">${formatContextWindow(model.contextWindow)}</td>
        <td class="model-capabilities">${caps}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function filterModels(models, searchTerm) {
    if (!searchTerm || searchTerm.trim() === '') return models;
    const term = searchTerm.toLowerCase().trim();
    return models.filter(m =>
      m.id.toLowerCase().includes(term) ||
      m.provider.toLowerCase().includes(term) ||
      (m.name && m.name.toLowerCase().includes(term)) ||
      (m.capabilities || []).some(c => c.toLowerCase().includes(term))
    );
  }

  // --- Render: Activity Feed ---

  function renderActivity(requests) {
    const container = dom.activityList;

    if (!requests || requests.length === 0) {
      dom.activityCount.textContent = '0 entries';
      return;
    }

    // Sort newest first
    const sorted = [...requests].sort((a, b) => b.timestamp - a.timestamp);

    // Determine new entries (those we have not seen)
    let newEntries;
    if (lastSeenRequestId === null) {
      // First load -- clear placeholder and render all
      container.innerHTML = '';
      newEntries = sorted;
    } else {
      const lastIdx = sorted.findIndex(r => r.id === lastSeenRequestId);
      if (lastIdx === -1) {
        // All entries are new (likely server restarted)
        newEntries = sorted;
        container.innerHTML = '';
      } else {
        newEntries = sorted.slice(0, lastIdx);
      }
    }

    if (newEntries.length === 0) return;

    // Prepend new entries
    const fragment = document.createDocumentFragment();
    newEntries.forEach(req => {
      fragment.appendChild(createActivityEntry(req));
    });

    if (container.firstChild) {
      container.insertBefore(fragment, container.firstChild);
    } else {
      container.appendChild(fragment);
    }

    // Update last seen
    lastSeenRequestId = sorted[0].id;

    // Cap visible entries
    while (container.children.length > MAX_ACTIVITY_ENTRIES) {
      container.removeChild(container.lastChild);
    }

    // Update count
    dom.activityCount.textContent = `${container.children.length} entries`;
  }

  function createActivityEntry(req) {
    const entry = document.createElement('div');
    entry.className = 'activity-entry';
    entry.setAttribute('data-request-id', req.id);

    const outcomeClass = getOutcomeClass(req.outcome);

    // Build routing chain display
    const chainHtml = buildRoutingChainHtml(req.routingChain || []);

    const outcomeLabel = formatOutcomeLabel(req.outcome);

    entry.innerHTML = `
      <span class="activity-timestamp">${formatTimestamp(req.timestamp)}</span>
      <div class="activity-details">
        <div class="activity-model">${escapeHtml(req.model)}</div>
        <div class="activity-chain">${chainHtml}</div>
        <div class="activity-latency">${req.latencyMs}ms</div>
      </div>
      <span class="outcome-badge ${outcomeClass}">${outcomeLabel}</span>
    `;

    return entry;
  }

  function buildRoutingChainHtml(chain) {
    if (!chain || chain.length === 0) return '<span class="chain-step">--</span>';

    return chain.map((step, i) => {
      const actionClass = (step.action || '').replace(/\s+/g, '-');
      const providerHtml = `<span class="chain-provider">${escapeHtml(step.provider)}</span>`;
      const actionHtml = `<span class="chain-action ${escapeHtml(actionClass)}">${escapeHtml(step.action)}</span>`;
      const arrow = i < chain.length - 1
        ? '<span class="chain-arrow" aria-hidden="true"> -> </span>'
        : '';
      return `<span class="chain-step">${providerHtml} <span aria-hidden="true">(</span>${actionHtml}<span aria-hidden="true">)</span></span>${arrow}`;
    }).join('');
  }

  function getOutcomeClass(outcome) {
    switch (outcome) {
      case 'success': return 'success';
      case 'fallback-success': return 'fallback-success';
      case 'all-failed': return 'all-failed';
      default: return 'all-failed';
    }
  }

  function formatOutcomeLabel(outcome) {
    switch (outcome) {
      case 'success': return 'OK';
      case 'fallback-success': return 'FALLBACK';
      case 'all-failed': return 'FAILED';
      default: return outcome ? outcome.toUpperCase() : 'UNKNOWN';
    }
  }

  // --- Render: Stats ---

  function renderStats(requests) {
    const items = requests || [];
    const total = items.length;

    if (total === 0) {
      dom.statTotalRequests.textContent = '0';
      dom.statSuccessRate.textContent = '--';
      dom.statAvgLatency.textContent = '--';
      dom.statTopProvider.textContent = '--';
      return;
    }

    const successes = items.filter(r =>
      r.outcome === 'success' || r.outcome === 'fallback-success'
    ).length;
    const successRate = ((successes / total) * 100).toFixed(1);
    const avgLatency = Math.round(
      items.reduce((sum, r) => sum + (r.latencyMs || 0), 0) / total
    );

    // Most-used provider
    const providerCounts = {};
    items.forEach(r => {
      const p = r.provider;
      if (p) {
        providerCounts[p] = (providerCounts[p] || 0) + 1;
      }
    });
    const topProvider = Object.entries(providerCounts)
      .sort((a, b) => b[1] - a[1])[0];

    dom.statTotalRequests.textContent = formatNumber(total);
    dom.statSuccessRate.textContent = `${successRate}%`;
    dom.statAvgLatency.textContent = `${avgLatency}ms`;
    dom.statTopProvider.textContent = topProvider ? topProvider[0] : '--';
  }

  // --- Polling Control ---

  function startPolling() {
    stopPolling();
    fetchStatus();
    pollingTimer = setInterval(fetchStatus, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollingTimer !== null) {
      clearInterval(pollingTimer);
      pollingTimer = null;
    }
  }

  function onAutoRefreshToggle() {
    if (dom.autoRefresh.checked) {
      startPolling();
    } else {
      stopPolling();
    }
  }

  // --- Model Search Handler ---

  function onModelSearch() {
    const searchTerm = dom.modelSearch.value;
    renderModelTable(currentModels, searchTerm);
  }

  // --- Test Console: Provider -> Model Cascading Selects ---

  let modelsByProvider = {}; // { providerName: ModelInfo[] }

  function updateConsoleSelects(models) {
    // Group models by provider
    modelsByProvider = {};
    models.forEach(m => {
      const p = m.provider || 'unknown';
      if (!modelsByProvider[p]) modelsByProvider[p] = [];
      modelsByProvider[p].push(m);
    });

    // Update provider dropdown
    const prevProvider = dom.consoleProvider.value;
    dom.consoleProvider.innerHTML = '<option value="">All providers</option>';
    Object.keys(modelsByProvider)
      .sort((a, b) => a.localeCompare(b))
      .forEach(provider => {
        const opt = document.createElement('option');
        opt.value = provider;
        opt.textContent = `${provider} (${modelsByProvider[provider].length})`;
        dom.consoleProvider.appendChild(opt);
      });

    // Restore selection if still valid
    if (prevProvider && modelsByProvider[prevProvider]) {
      dom.consoleProvider.value = prevProvider;
    }

    // Refresh model dropdown based on current provider selection
    updateModelDropdown();
  }

  function updateModelDropdown() {
    const selectedProvider = dom.consoleProvider.value;
    const prevModel = dom.consoleModel.value;
    dom.consoleModel.innerHTML = '';

    let models;
    if (selectedProvider && modelsByProvider[selectedProvider]) {
      models = modelsByProvider[selectedProvider];
    } else {
      // Show all models, but still grouped
      models = currentModels;
    }

    if (models.length === 0) {
      dom.consoleModel.innerHTML = '<option value="">No models available</option>';
      return;
    }

    // If showing all providers, group with optgroups
    if (!selectedProvider) {
      const grouped = {};
      models.forEach(m => {
        const p = m.provider || 'unknown';
        if (!grouped[p]) grouped[p] = [];
        grouped[p].push(m);
      });

      Object.entries(grouped)
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([provider, providerModels]) => {
          const group = document.createElement('optgroup');
          group.label = provider;
          providerModels.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.id;
            group.appendChild(opt);
          });
          dom.consoleModel.appendChild(group);
        });
    } else {
      // Single provider selected — flat list
      models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.id;
        dom.consoleModel.appendChild(opt);
      });
    }

    // Restore previous model selection if still valid
    if (prevModel) {
      const exists = dom.consoleModel.querySelector(`option[value="${CSS.escape(prevModel)}"]`);
      if (exists) {
        dom.consoleModel.value = prevModel;
      }
    }
  }

  function onProviderChange() {
    updateModelDropdown();
  }

  // --- Test Console: Chat ---

  let consoleConversation = []; // {role, content}[] sent to API
  let isSending = false;

  function appendConsoleMessage(role, content, meta) {
    // Clear empty state
    const empty = dom.consoleMessages.querySelector('.empty-state');
    if (empty) empty.remove();

    const msg = document.createElement('div');
    msg.className = `console-msg ${role}`;
    msg.textContent = content;

    if (meta) {
      const metaEl = document.createElement('div');
      metaEl.className = 'console-msg-meta';
      metaEl.textContent = meta;
      msg.appendChild(metaEl);
    }

    dom.consoleMessages.appendChild(msg);
    dom.consoleMessages.scrollTop = dom.consoleMessages.scrollHeight;
    return msg;
  }

  /** Create an empty assistant message element for streaming token append. */
  function createStreamingMessage() {
    const empty = dom.consoleMessages.querySelector('.empty-state');
    if (empty) empty.remove();

    const msg = document.createElement('div');
    msg.className = 'console-msg assistant';

    const content = document.createElement('div');
    content.className = 'console-msg-content';
    msg.appendChild(content);

    dom.consoleMessages.appendChild(msg);
    dom.consoleMessages.scrollTop = dom.consoleMessages.scrollHeight;

    return {
      element: msg,
      setContent(fullText, done) { renderAssistantContent(content, fullText, done === true); },
    };
  }

  /**
   * Render assistant text, splitting out any <think>...</think> reasoning
   * blocks into a collapsed <details>. Handles partial open blocks during
   * streaming: an unclosed block is rendered in-progress while the stream
   * is live, and as complete once `done` is true.
   */
  function renderAssistantContent(parent, fullText, done) {
    parent.innerHTML = '';
    const OPEN = '<think>';
    const CLOSE = '</think>';
    let i = 0;
    while (i < fullText.length) {
      const openIdx = fullText.indexOf(OPEN, i);
      if (openIdx === -1) {
        appendPlain(parent, fullText.slice(i), done === true);
        return;
      }
      if (openIdx > i) appendPlain(parent, fullText.slice(i, openIdx), done === true);
      const after = openIdx + OPEN.length;
      const closeIdx = fullText.indexOf(CLOSE, after);
      if (closeIdx === -1) {
        appendThink(parent, fullText.slice(after), done === true);
        return;
      }
      appendThink(parent, fullText.slice(after, closeIdx), true);
      i = closeIdx + CLOSE.length;
    }
  }

  /**
   * Append a non-think segment to the message. While streaming we keep it
   * as plain text (fast, partial markdown/math don't render nicely). On
   * the final pass (done=true) we render markdown + math: extract math
   * expressions first (so marked doesn't break them across <br>/<p>),
   * run marked, then re-inject KaTeX-rendered HTML at the placeholders.
   */
  function appendPlain(parent, text, done) {
    if (!text) return;
    if (done && window.marked && window.katex) {
      const wrapper = document.createElement('div');
      wrapper.className = 'console-md';
      try {
        wrapper.innerHTML = renderMarkdownWithMath(text);
      } catch (_e) {
        wrapper.textContent = text;
      }
      parent.appendChild(wrapper);
    } else {
      parent.appendChild(document.createTextNode(text));
    }
  }

  // Private Use Area chars as math placeholders — won't appear in normal
  // text, and marked passes them through unmolested as plain text.
  const MATH_PH_START = '';
  const MATH_PH_END = '';
  const MATH_PH_RE = new RegExp(MATH_PH_START + '(\\d+)' + MATH_PH_END, 'g');

  function renderMarkdownWithMath(text) {
    const tokens = [];

    // Extract math expressions first. Order matters: longer/more-specific
    // delimiters before shorter ones so `$$...$$` doesn't get split by `$`.
    const patterns = [
      { re: /\$\$([\s\S]+?)\$\$/g, display: true },
      { re: /\\\[([\s\S]+?)\\\]/g, display: true },
      { re: /\\\(([\s\S]+?)\\\)/g, display: false },
      { re: /\$([^\n$]+?)\$/g, display: false },
    ];
    let working = text;
    for (const { re, display } of patterns) {
      working = working.replace(re, (_, content) => {
        const id = tokens.length;
        tokens.push({ content: content.trim(), display });
        return MATH_PH_START + id + MATH_PH_END;
      });
    }

    let html = window.marked.parse(working, { breaks: true, gfm: true });

    html = html.replace(MATH_PH_RE, (_, idx) => {
      const tok = tokens[parseInt(idx, 10)];
      if (!tok) return '';
      try {
        return window.katex.renderToString(tok.content, {
          displayMode: tok.display,
          throwOnError: false,
        });
      } catch (_e) {
        return escapeForHtml(tok.content);
      }
    });

    return html;
  }

  function escapeForHtml(s) {
    return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  function appendThink(parent, text, complete) {
    const details = document.createElement('details');
    details.className = complete ? 'think-block' : 'think-block in-progress';
    const summary = document.createElement('summary');
    summary.textContent = complete ? 'Thinking' : 'Thinking…';
    details.appendChild(summary);
    const body = document.createElement('div');
    body.className = 'think-content';
    body.textContent = text.replace(/^\n+/, '').replace(/\n+$/, '');
    details.appendChild(body);
    parent.appendChild(details);
  }

  async function sendConsoleMessage() {
    const model = dom.consoleModel.value;
    const text = dom.consoleInput.value.trim();

    if (!model || !text || isSending) return;

    isSending = true;
    dom.consoleSend.disabled = true;
    dom.consoleInput.value = '';

    // Build messages array with optional system prompt
    const systemPrompt = dom.consoleSystemPrompt ? dom.consoleSystemPrompt.value.trim() : '';
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push(...consoleConversation, { role: 'user', content: text });

    appendConsoleMessage('user', text);
    consoleConversation.push({ role: 'user', content: text });

    try {
      const requestBody = { model: model, messages: messages };
      const maxTokensRaw = dom.consoleMaxTokens ? parseInt(dom.consoleMaxTokens.value, 10) : NaN;
      if (Number.isFinite(maxTokensRaw) && maxTokensRaw > 0) {
        // Engine uses camelCase; /api/chat/stream forwards body as-is.
        requestBody.maxTokens = maxTokensRaw;
      }

      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${response.status}`);
      }

      // Stream tokens into the DOM
      const streamingMsg = createStreamingMessage();
      const msgEl = streamingMsg.element;
      let fullContent = '';
      let lastProvider = '';
      let lastFinishReason = '';

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              throw new Error(parsed.error);
            }
            fullContent += parsed.delta || '';
            streamingMsg.setContent(fullContent);
            if (parsed.provider) lastProvider = parsed.provider;
            if (parsed.finishReason) lastFinishReason = parsed.finishReason;
            dom.consoleMessages.scrollTop = dom.consoleMessages.scrollHeight;
          } catch (parseErr) {
            if (parseErr.message && !parseErr.message.includes('JSON')) {
              throw parseErr;
            }
          }
        }
      }

      // Finalize: re-render so any unclosed <think> block stops pulsing
      streamingMsg.setContent(fullContent, true);

      // Add meta line after stream completes
      if (lastProvider || lastFinishReason) {
        const metaEl = document.createElement('div');
        metaEl.className = 'console-msg-meta';
        metaEl.textContent = [lastProvider, lastFinishReason].filter(Boolean).join(' | ');
        msgEl.appendChild(metaEl);
      }

      consoleConversation.push({ role: 'assistant', content: fullContent });
    } catch (err) {
      appendConsoleMessage('error', `Error: ${err.message}`);
      consoleConversation.pop();
    } finally {
      isSending = false;
      dom.consoleSend.disabled = false;
      dom.consoleInput.focus();
    }
  }

  function onConsoleSend() {
    sendConsoleMessage();
  }

  function onConsoleKeydown(e) {
    // Enter without Shift sends the message
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendConsoleMessage();
    }
  }

  function onNewChat() {
    consoleConversation = [];
    dom.consoleMessages.innerHTML = '<div class="empty-state">Select a model and send a message to test routing</div>';
    if (dom.consoleSystemPrompt) {
      dom.consoleSystemPrompt.value = '';
    }
  }

  // --- Fleet Overview Collapse ---

  function onFleetCollapseToggle() {
    const wrapper = dom.fleetCardsWrapper;
    const btn = dom.fleetCollapse;
    const isExpanded = btn.getAttribute('aria-expanded') === 'true';

    if (isExpanded) {
      wrapper.classList.add('collapsed');
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', 'Expand fleet overview');
    } else {
      wrapper.classList.remove('collapsed');
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-label', 'Collapse fleet overview');
    }
  }

  // --- Text-size toggle (S/M/L) ---

  const SIZE_KEY = 'dashboard-size';
  const VALID_SIZES = new Set(['s', 'm', 'l']);

  function applySize(size) {
    if (!VALID_SIZES.has(size)) size = 'm';
    document.documentElement.setAttribute('data-size', size);
    try { localStorage.setItem(SIZE_KEY, size); } catch (_e) { /* private mode */ }
    dom.sizeToggleButtons.forEach(btn => {
      const active = btn.getAttribute('data-size') === size;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function initSizeToggle() {
    let saved = 'm';
    try { saved = localStorage.getItem(SIZE_KEY) || 'm'; } catch (_e) { /* private mode */ }
    applySize(saved);
    dom.sizeToggleButtons.forEach(btn => {
      btn.addEventListener('click', () => applySize(btn.getAttribute('data-size')));
    });
  }

  // --- Last Updated Timer ---

  let lastUpdatedTimer = null;

  function startLastUpdatedTimer() {
    lastUpdatedTimer = setInterval(updateLastUpdated, 1000);
  }

  // --- Initialization ---

  function init() {
    cacheDom();

    // Show initial empty/loading state
    dom.providerCards.innerHTML = '<div class="empty-state">Loading providers...</div>';
    dom.activityList.innerHTML = '<div class="empty-state">Waiting for activity data...</div>';

    // Event listeners
    dom.autoRefresh.addEventListener('change', onAutoRefreshToggle);
    dom.modelSearch.addEventListener('input', onModelSearch);
    dom.consoleProvider.addEventListener('change', onProviderChange);
    dom.consoleSend.addEventListener('click', onConsoleSend);
    dom.consoleInput.addEventListener('keydown', onConsoleKeydown);
    dom.consoleNewChat.addEventListener('click', onNewChat);
    dom.fleetCollapse.addEventListener('click', onFleetCollapseToggle);

    // Init size toggle from localStorage
    initSizeToggle();

    // Start polling (auto-refresh is on by default)
    startPolling();
    startLastUpdatedTimer();
  }

  // Boot when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
