(function () {
  let threadId;
  let es; // current EventSource

  const chatDiv = document.getElementById('chat');
  const actionsDiv = document.getElementById('actions');
  const msgInput = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');

  // Maintain a map of action cards keyed by card ID
  const cards = {};

  /**
   * Append a chat message to the chat panel.
   * @param {string} role - 'user' or 'assistant'
   * @param {string} text
   */
  function appendMessage(role, text) {
    const wrapper = document.createElement('div');
    wrapper.className = 'message';
    const label = document.createElement('strong');
    label.textContent = role === 'user' ? 'You' : 'Assistant';
    const p = document.createElement('p');
    p.textContent = text;
    wrapper.appendChild(label);
    wrapper.appendChild(p);
    chatDiv.appendChild(wrapper);
    chatDiv.scrollTop = chatDiv.scrollHeight;
  }

  /**
   * Clear all action cards and reset the internal map.
   */
  function clearActions() {
    actionsDiv.innerHTML = '';
    for (const key in cards) delete cards[key];
  }

  /**
   * Add or update an action card based on the incoming tool event.
   * @param {Object} event - Tool event from the SSE stream
   */
  function handleToolEvent(event) {
    if (event.type === 'tool_start') {
      // Create a new card
      const card = document.createElement('div');
      card.className = 'action-card';
      card.dataset.id = event.cardId;
      // Header with tool name and status icon
      const header = document.createElement('div');
      header.className = 'header';
      const nameSpan = document.createElement('strong');
      nameSpan.textContent = event.tool;
      const statusSpan = document.createElement('span');
      statusSpan.textContent = '⏳';
      header.appendChild(nameSpan);
      header.appendChild(statusSpan);
      card.appendChild(header);
      // Input section
      if (event.input !== undefined) {
        const inputLabel = document.createElement('div');
        inputLabel.style.marginTop = '6px';
        inputLabel.style.fontSize = '12px';
        inputLabel.style.color = '#6c757d';
        inputLabel.textContent = 'input';
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(event.input, null, 2);
        card.appendChild(inputLabel);
        card.appendChild(pre);
      }
      actionsDiv.appendChild(card);
      cards[event.cardId] = { element: card, statusSpan, output: null };
    } else if (event.type === 'tool_done') {
      // Update existing card with output
      const cardInfo = cards[event.cardId];
      if (!cardInfo) return;
      const { element } = cardInfo;
      // Update status
      const statusSpan = element.querySelector('.header span');
      if (statusSpan) statusSpan.textContent = '✅';
      // Output section
      if (event.output !== undefined) {
        const outputLabel = document.createElement('div');
        outputLabel.style.marginTop = '6px';
        outputLabel.style.fontSize = '12px';
        outputLabel.style.color = '#6c757d';
        outputLabel.textContent = 'output';
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(event.output, null, 2);
        element.appendChild(outputLabel);
        element.appendChild(pre);
      }
    }
  }

  /**
   * Handle assistant done event: show the assistant message and close SSE.
   */
  function handleAssistantDone(event) {
    appendMessage('assistant', event.text);
    if (es) {
      es.close();
      es = null;
    }
  }

  /**
   * Send the current message to the backend and set up SSE streaming.
   */
  function send() {
    const text = msgInput.value.trim();
    if (!text) return;
    appendMessage('user', text);
    msgInput.value = '';
    clearActions();
    // Disable send while waiting for response
    sendBtn.disabled = true;
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, threadId }),
    })
      .then((resp) => resp.json())
      .then((data) => {
        threadId = data.threadId;
        const runId = data.runId;
        if (es) es.close();
        es = new EventSource('/api/stream/' + runId);
        es.onmessage = function (ev) {
          const event = JSON.parse(ev.data);
          if (event.type === 'assistant_done') {
            handleAssistantDone(event);
            sendBtn.disabled = false;
          } else if (event.type === 'tool_start' || event.type === 'tool_done') {
            handleToolEvent(event);
          }
        };
        es.onerror = function () {
          if (es) {
            es.close();
            es = null;
            sendBtn.disabled = false;
          }
        };
      })
      .catch((err) => {
        appendMessage('assistant', 'Error: ' + err.message);
        sendBtn.disabled = false;
      });
  }

  // Attach event listeners
  sendBtn.addEventListener('click', send);
  msgInput.addEventListener('keypress', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      send();
    }
  });
})();
