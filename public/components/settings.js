/**
 * Settings Management Component
 * Configures default gateway upstreams, api keys, and security parameters.
 */
export const SettingsComponent = {
  app: null,

  init(appInstance) {
    this.app = appInstance;
    this.setupListeners();
  },

  setupListeners() {
    const saveBtn = document.getElementById('set-btn-save');
    saveBtn.addEventListener('click', () => this.saveSettings());
  },

  async loadSettings() {
    try {
      const response = await fetch('/api/settings', {
        headers: this.app.getHeaders()
      });

      if (!response.ok) throw new Error('拉取网关全局配置失败');
      const settings = await response.json();

      // Populate elements
      document.getElementById('set-default-url').value = settings.default_upstream_url || '';
      
      const keyInput = document.getElementById('set-default-key');
      if (settings.default_upstream_key_masked) {
        keyInput.value = settings.default_upstream_key_masked;
        keyInput.placeholder = '••••••••••••••••••••••••';
      } else {
        keyInput.value = '';
        keyInput.placeholder = '未配置任何默认密钥（通常针对公开的本地部署节点）';
      }

      document.getElementById('set-gemini-url').value = settings.default_gemini_url || '';
      
      const geminiKeyInput = document.getElementById('set-gemini-key');
      if (settings.default_gemini_key_masked) {
        geminiKeyInput.value = settings.default_gemini_key_masked;
        geminiKeyInput.placeholder = '••••••••••••••••••••••••';
      } else {
        geminiKeyInput.value = '';
        geminiKeyInput.placeholder = '未配置任何默认密钥（使用本地 Mock 或公开节点）';
      }

      const collectorKeyInput = document.getElementById('set-collector-key');
      if (settings.has_collector_key) {
        collectorKeyInput.value = '••••••••••••••••••••••••';
        collectorKeyInput.placeholder = '外部网关 API 密钥已配置';
      } else {
        collectorKeyInput.value = '';
        collectorKeyInput.placeholder = '当前留空代表允许公开免认证代理';
      }

      const dbPasswordInput = document.getElementById('set-dashboard-password');
      if (settings.has_dashboard_password) {
        dbPasswordInput.value = '••••••••••••••••••••••••';
        dbPasswordInput.placeholder = '控制面板登录密码已配置';
        
        // Show auth badge in main app
        document.getElementById('auth-indicator').style.display = 'block';
      } else {
        dbPasswordInput.value = '';
        dbPasswordInput.placeholder = '当前留空代表公共控制台（无安全认证，不推荐公网部署）';
        
        document.getElementById('auth-indicator').style.display = 'none';
      }

      // Also set default values inside Playground if empty
      const pgUrlInput = document.getElementById('pg-upstream-url');
      if (!pgUrlInput.value) {
        pgUrlInput.placeholder = settings.default_upstream_url || 'https://api.openai.com/v1';
      }

    } catch (err) {
      console.error(err);
    }
  },

  async saveSettings() {
    const saveBtn = document.getElementById('set-btn-save');
    const defaultUrl = document.getElementById('set-default-url').value.trim();
    const defaultKey = document.getElementById('set-default-key').value.trim();
    const geminiUrl = document.getElementById('set-gemini-url').value.trim();
    const geminiKey = document.getElementById('set-gemini-key').value.trim();
    const collectorKey = document.getElementById('set-collector-key').value.trim();
    const dbPassword = document.getElementById('set-dashboard-password').value.trim();

    const payload = {
      default_upstream_url: defaultUrl,
      default_upstream_key: defaultKey,
      default_gemini_url: geminiUrl,
      default_gemini_key: geminiKey,
      collector_api_key: collectorKey,
      dashboard_password: dbPassword
    };

    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在保存配置...';

    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.app.getHeaders()
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || '更新设置失败');
      }

      // If user changed the dashboard password, we need to update our active key!
      if (dbPassword !== '' && !dbPassword.includes('•••')) {
        // Update key in localStorage
        this.app.saveApiKey(dbPassword);
      } else if (dbPassword === '') {
        // Key cleared
        this.app.saveApiKey('');
      }

      alert('网关全局配置已成功保存！');
      
      // Reload stats and labels
      await this.loadSettings();
      await this.app.loadData();

    } catch (error) {
      console.error(error);
      alert('更新网关配置出错：' + error.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> <span>保存网关配置</span>';
    }
  }
};
