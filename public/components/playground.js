/**
 * Interactive API Playground Component
 * Simulates LLM integrations by hitting the local proxy endpoint with streaming support.
 */
export const PlaygroundComponent = {
  app: null,

  init(appInstance) {
    this.app = appInstance;
    this.setupListeners();
  },

  setupListeners() {
    const submitBtn = document.getElementById('pg-btn-submit');
    const resetBtn = document.getElementById('pg-btn-clear-chat');

    submitBtn.addEventListener('click', () => this.executeProxyCall());
    resetBtn.addEventListener('click', () => this.resetPlayground());
  },

  resetPlayground() {
    document.getElementById('pg-system-input').value = '你是一个得力的 AI 助手。';
    document.getElementById('pg-user-input').value = '';
    
    const terminal = document.getElementById('pg-terminal-output');
    terminal.innerHTML = `
      <div class="terminal-placeholder">
        <i class="fa-solid fa-chevron-right"></i> 等待任务提交。LLM 的实时响应数据流将在本控制台终端中实时打字输出...
      </div>
    `;

    const stats = document.getElementById('pg-stream-stats');
    stats.style.visibility = 'hidden';
  },

  loadReplay(log) {
    // Populate form fields
    if (log.model) document.getElementById('pg-model').value = log.model;
    
    // Set system prompt
    document.getElementById('pg-system-input').value = log.system_prompt || '';

    // Set last user prompt
    document.getElementById('pg-user-input').value = log.user_prompt || '';

    // Toggle stream mode
    document.getElementById('pg-stream').checked = log.is_stream;

    // Reset terminal
    const terminal = document.getElementById('pg-terminal-output');
    terminal.innerHTML = `
      <div class="terminal-placeholder" style="color: var(--text-link);">
        <i class="fa-solid fa-rotate-right"></i> 已从日志 #${log.id.slice(0, 8)} 成功导入 Prompt！随时可以点击执行重试。
      </div>
    `;

    const stats = document.getElementById('pg-stream-stats');
    stats.style.visibility = 'hidden';
  },

  async executeProxyCall() {
    const submitBtn = document.getElementById('pg-btn-submit');
    const terminal = document.getElementById('pg-terminal-output');
    const streamStats = document.getElementById('pg-stream-stats');
    const lblTokens = document.getElementById('pg-lbl-tokens');
    const lblDuration = document.getElementById('pg-lbl-duration');

    // Gather input values
    const model = document.getElementById('pg-model').value.trim();
    const systemPrompt = document.getElementById('pg-system-input').value.trim();
    const userPrompt = document.getElementById('pg-user-input').value.trim();
    const temperature = parseFloat(document.getElementById('pg-temperature').value) || 0.7;
    const maxTokens = parseInt(document.getElementById('pg-max-tokens').value) || 1024;
    const stream = document.getElementById('pg-stream').checked;

    const dynamicKey = document.getElementById('pg-upstream-key').value.trim();

    if (!userPrompt) {
      alert('在执行代理请求前，请先输入用户的 Prompt 问题消息！');
      return;
    }

    // Build Messages array
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: userPrompt });

    // Build Request Payload
    const payload = {
      model: model || 'gpt-4o-mini',
      messages,
      temperature,
      max_tokens: maxTokens,
      stream
    };

    // Prepare Request Headers
    const headers = {
      'Content-Type': 'application/json',
      ...this.app.getHeaders() // Add authorization key if dashboard is secured
    };

    if (dynamicKey) headers['x-upstream-key'] = dynamicKey;

    // Reset UI state for loading
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在调用代理接口...';
    terminal.innerHTML = '<span class="terminal-cursor"></span>';
    streamStats.style.visibility = 'hidden';

    const startTime = Date.now();

    try {
      const response = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errMsg = errorText;
        try {
          const errObj = JSON.parse(errorText);
          errMsg = errObj.error?.message || errObj.error || errorText;
        } catch (e) {}

        throw new Error(`Upstream Error [${response.status}]: ${errMsg}`);
      }

      // Stream Response Handling
      if (stream) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        let accumulatedText = '';
        let chunkBuffer = '';
        let tokensEstimated = 0;

        terminal.innerHTML = '';
        const cursor = document.createElement('span');
        cursor.className = 'terminal-cursor';
        terminal.appendChild(cursor);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const decoded = decoder.decode(value, { stream: true });
          chunkBuffer += decoded;

          let newlineIndex;
          while ((newlineIndex = chunkBuffer.indexOf('\n')) !== -1) {
            const line = chunkBuffer.slice(0, newlineIndex).trim();
            chunkBuffer = chunkBuffer.slice(newlineIndex + 1);

            if (line.startsWith('data:')) {
              const dataStr = line.slice(5).trim();
              if (dataStr === '[DONE]') continue;

              try {
                const parsed = JSON.parse(dataStr);
                const content = parsed.choices?.[0]?.delta?.content || '';
                
                if (content) {
                  accumulatedText += content;
                  // Render text before cursor
                  terminal.textContent = accumulatedText;
                  terminal.appendChild(cursor);
                  terminal.scrollTop = terminal.scrollHeight;
                }
              } catch (e) {
                // Ignore parsing errors for partial splits
              }
            }
          }
        }

        // Complete styling
        cursor.remove();
        if (!accumulatedText) {
          terminal.innerHTML = '<span style="color:var(--text-muted);">流式传输已完成，但未返回任何文本内容。请查看系统日志以获取详细 HTTP 报文。</span>';
        }

        // Render Stats
        const duration = Date.now() - startTime;
        tokensEstimated = Math.ceil(accumulatedText.length / 3.8);
        
        lblTokens.textContent = `约 ${tokensEstimated} 输出 Token`;
        lblDuration.textContent = `耗时 ${duration}ms`;
        streamStats.style.visibility = 'visible';

      } else {
        // Standard JSON Handling
        const result = await response.json();
        const text = result.choices?.[0]?.message?.content || '';
        terminal.textContent = text;
        terminal.scrollTop = terminal.scrollHeight;

        const duration = Date.now() - startTime;
        const tokens = result.usage?.completion_tokens || Math.ceil(text.length / 3.8);

        lblTokens.textContent = `${tokens} 输出 Token`;
        lblDuration.textContent = `耗时 ${duration}ms`;
        streamStats.style.visibility = 'visible';
      }

      // Proactively trigger app reload so the newly captured prompt displays immediately in logs!
      setTimeout(() => this.app.loadData(), 1200);

    } catch (error) {
      console.error(error);
      terminal.innerHTML = `<span style="color:var(--crimson);"><i class="fa-solid fa-triangle-exclamation"></i> 代理接口调用失败：</span>\n\n${error.message}`;
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> <span>开始执行代理请求</span>';
    }
  }
};
