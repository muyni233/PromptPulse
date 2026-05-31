/**
 * Logs and Prompt Viewer Component
 * Renders intercepted prompts, conversational trees, JSON viewers, and triggers replays.
 */
export const LogViewerComponent = {
  // Main app reference to access other tabs/components
  app: null,

  init(appInstance) {
    this.app = appInstance;
    this.setupListeners();
  },

  setupListeners() {
    // Modal Tab switching
    const modalTabs = document.querySelectorAll('.modal-tab');
    modalTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        modalTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const targetTab = tab.getAttribute('data-modal-tab');
        document.querySelectorAll('.modal-tab-content').forEach(content => {
          content.classList.remove('active');
        });
        document.getElementById(`modal-content-${targetTab}`).classList.add('active');
      });
    });

    // Close Modal Button
    document.getElementById('modal-btn-close').addEventListener('click', () => this.closeModal());
    document.getElementById('modal-btn-close-footer').addEventListener('click', () => this.closeModal());
    
    // Close Modal on overlay click
    document.getElementById('log-modal').addEventListener('click', (e) => {
      if (e.target.id === 'log-modal') this.closeModal();
    });

    // Copy JSON helpers
    document.querySelectorAll('.btn-copy-json').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const targetId = btn.getAttribute('data-copy-target');
        const codeElement = document.getElementById(targetId);
        if (codeElement) {
          navigator.clipboard.writeText(codeElement.textContent);
          const icon = btn.querySelector('i');
          const originalText = btn.innerHTML;
          
          btn.innerHTML = '<i class="fa-solid fa-check text-emerald"></i> 已复制!';
          setTimeout(() => {
            btn.innerHTML = originalText;
          }, 2000);
        }
      });
    });
  },

  renderLogsList(logs) {
    const listContainer = document.getElementById('logs-list');
    if (!listContainer) return;

    if (!logs || logs.length === 0) {
      listContainer.innerHTML = `
        <div class="empty-state">
          <i class="fa-solid fa-box-open"></i>
          <h3>暂无被拦截的提示词</h3>
          <p>向本地网关代理端口 3000 发送标准 LLM completions 请求，即可在此处瞬时捕获并展示其内容。</p>
        </div>
      `;
      return;
    }

    let html = '';
    logs.forEach((log) => {
      // Date formatting
      const date = new Date(log.timestamp);
      const displayDate = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      // Status Styling
      const isSuccess = log.status >= 200 && log.status < 300;
      const statusBadgeClass = isSuccess ? 'badge-success' : 'badge-error';
      const statusText = isSuccess ? `${log.status} 成功` : `${log.status || '错误'} 异常`;

      // Prompt summaries
      const systemSnippet = log.system_prompt 
        ? `预设: ${log.system_prompt}` 
        : '预设: 未设定';

      const userSnippet = log.user_prompt || '未读取到有效的提问文本';

      // Stream status icon
      const streamIcon = log.is_stream 
        ? '<i class="fa-solid fa-water text-glow" style="color: var(--text-link); margin-left:6px;" title="流式传输模式 (SSE)"></i>' 
        : '';

      html += `
        <div class="log-card" data-log-id="${log.id}">
          
          <!-- Model name and Date -->
          <div class="log-model-cell">
            <span class="log-model-name">${log.model}</span>
            <span class="log-date">${displayDate}</span>
          </div>

          <!-- Prompt Preview details -->
          <div class="log-prompt-cell">
            <span class="log-prompt-title">${userSnippet}</span>
            <span class="log-prompt-system">${systemSnippet}</span>
          </div>

          <!-- Status badge -->
          <div>
            <span class="badge ${statusBadgeClass}">${statusText}</span>
          </div>

          <!-- Metrics: Latency and Token Counts -->
          <div class="log-metrics-cell">
            <span class="log-token-count">
              <strong>${log.tokens_prompt + log.tokens_completion}</strong> Token
              <small style="color: var(--text-muted); font-size:11px;">(输入 ${log.tokens_prompt} / 输出 ${log.tokens_completion})</small>
            </span>
            <span class="log-duration">
              <i class="fa-regular fa-clock"></i> ${log.duration} ms
              ${streamIcon}
            </span>
          </div>

        </div>
      `;
    });

    listContainer.innerHTML = html;

    // Attach click events to card rows
    const cards = listContainer.querySelectorAll('.log-card');
    cards.forEach(card => {
      card.addEventListener('click', () => {
        const logId = card.getAttribute('data-log-id');
        this.openLogDetail(logId);
      });
    });
  },

  async openLogDetail(logId) {
    const modal = document.getElementById('log-modal');
    modal.style.display = 'flex';

    // Reset tabs
    document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('[data-modal-tab="messages"]').classList.add('active');
    document.querySelectorAll('.modal-tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('modal-content-messages').classList.add('active');

    try {
      // Get detail
      const response = await fetch(`/api/logs/${logId}`, {
        headers: this.app.getHeaders()
      });

      if (!response.ok) throw new Error('拉取日志详情失败');
      const log = await response.json();

      // Set header details
      document.getElementById('modal-lbl-model').textContent = log.model;
      document.getElementById('modal-lbl-date').textContent = new Date(log.timestamp).toLocaleString();
      
      const statusBadge = document.getElementById('modal-lbl-status');
      statusBadge.textContent = log.status >= 200 && log.status < 300 ? `${log.status} 成功` : `${log.status || '错误'} 异常`;
      statusBadge.className = `badge ${log.status >= 200 && log.status < 300 ? 'badge-success' : 'badge-error'}`;

      // Set metrics values
      document.getElementById('modal-val-duration').textContent = `${log.duration} ms`;
      document.getElementById('modal-val-tokens').textContent = log.tokens_prompt + log.tokens_completion;
      document.getElementById('modal-val-tokens-split').textContent = `(输入 ${log.tokens_prompt} / 输出 ${log.tokens_completion})`;
      document.getElementById('modal-val-mode').textContent = log.is_stream ? '流式输出 (SSE)' : '常规非流式 JSON';
      document.getElementById('modal-val-upstream').textContent = log.upstream_url || '全局默认上游接口';

      // Set Prompts tab
      const systemPromptBox = document.getElementById('modal-system-prompt-box');
      if (log.system_prompt) {
        systemPromptBox.style.display = 'block';
        document.getElementById('modal-system-prompt').textContent = log.system_prompt;
      } else {
        systemPromptBox.style.display = 'none';
      }

      // Generate Chat bubbles
      const chatThread = document.getElementById('modal-chat-thread');
      chatThread.innerHTML = '';
      
      if (Array.isArray(log.messages)) {
        log.messages.forEach(msg => {
          const bubble = document.createElement('div');
          bubble.className = `chat-bubble bubble-${msg.role || 'user'}`;
          
          const roleLabel = document.createElement('span');
          roleLabel.className = 'bubble-role';
          
          let roleIcon = '<i class="fa-solid fa-user"></i>';
          let roleName = '提问者';
          if (msg.role === 'system') {
            roleIcon = '<i class="fa-solid fa-gears"></i>';
            roleName = '系统设定';
          }
          if (msg.role === 'assistant') {
            roleIcon = '<i class="fa-solid fa-robot"></i>';
            roleName = '智能体回复';
          }
          
          roleLabel.innerHTML = `${roleIcon} ${roleName} (${msg.role})`;
          bubble.appendChild(roleLabel);

          // Content body
          const content = document.createElement('div');
          // Simple escaping
          content.textContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          bubble.appendChild(content);

          chatThread.appendChild(bubble);
        });
      }

      // Assistant completion output
      const completionOut = document.getElementById('modal-assistant-completion');
      if (log.error_message) {
        completionOut.innerHTML = `<span style="color:var(--crimson);"><i class="fa-solid fa-circle-exclamation"></i> 网关捕获到异常日志:</span>\n${log.error_message}`;
      } else {
        completionOut.textContent = log.response_text || '未返回有效的生成数据。';
      }

      // JSON Payload tab
      document.getElementById('modal-json-request').textContent = JSON.stringify(log.messages, null, 2);
      document.getElementById('modal-json-response').textContent = JSON.stringify(log.response_json || { error: log.error_message }, null, 2);

      // Wire Action buttons inside modal
      
      // 1. Replay in Playground
      const replayBtn = document.getElementById('modal-btn-replay');
      // Remove old listeners by cloning
      const newReplayBtn = replayBtn.cloneNode(true);
      replayBtn.replaceWith(newReplayBtn);
      
      newReplayBtn.addEventListener('click', () => {
        this.closeModal();
        this.app.playground.loadReplay(log);
        this.app.switchTab('playground');
      });

      // 2. Copy User Prompt
      const copyBtn = document.getElementById('modal-btn-copy-prompt');
      const newCopyBtn = copyBtn.cloneNode(true);
      copyBtn.replaceWith(newCopyBtn);

      newCopyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(log.user_prompt || '');
        const label = newCopyBtn.querySelector('span');
        label.textContent = '已成功复制！';
        setTimeout(() => {
          label.textContent = '复制最后提问 Prompt';
        }, 1500);
      });

    } catch (err) {
      console.error(err);
      alert('拉取日志详情异常: ' + err.message);
      this.closeModal();
    }
  },

  closeModal() {
    document.getElementById('log-modal').style.display = 'none';
  }
};
