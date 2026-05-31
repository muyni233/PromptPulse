import { StatsComponent } from './components/stats.js';
import { LogViewerComponent } from './components/log-viewer.js';
import { PlaygroundComponent } from './components/playground.js';
import { SettingsComponent } from './components/settings.js';

class PromptPulseApp {
  constructor() {
    this.apiKey = localStorage.getItem('prompt_pulse_key') || '';
    this.currentPage = 0;
    this.pageSize = 50;
    this.totalLogs = 0;
    this.searchQuery = '';
    this.activeTab = 'logs';

    this.stats = StatsComponent;
    this.logViewer = LogViewerComponent;
    this.playground = PlaygroundComponent;
    this.settings = SettingsComponent;
  }

  async init() {
    // Set dynamic port label in sidebar
    const portLabel = document.getElementById('lbl-port');
    if (portLabel) {
      portLabel.textContent = window.location.port || '80';
    }

    // Register self references
    this.logViewer.init(this);
    this.playground.init(this);
    this.settings.init(this);

    this.setupNavigation();
    this.setupGlobalListeners();
    this.setupAuthGate();
    
    // Initial fetch
    await this.loadData();
    await this.settings.loadSettings();
  }

  // --- Auth Session Helpers ---
  getHeaders() {
    const headers = {};
    if (this.apiKey) {
      headers['x-dashboard-password'] = this.apiKey;
    }
    return headers;
  }

  saveApiKey(key) {
    this.apiKey = key;
    if (key) {
      localStorage.setItem('prompt_pulse_key', key);
    } else {
      localStorage.removeItem('prompt_pulse_key');
    }
    this.setupAuthIndicator();
  }

  setupAuthIndicator() {
    const indicator = document.getElementById('auth-indicator');
    if (this.apiKey) {
      indicator.style.display = 'block';
    } else {
      indicator.style.display = 'none';
    }
  }

  setupAuthGate() {
    const authModal = document.getElementById('auth-modal');
    const authSubmit = document.getElementById('auth-btn-submit');
    const authInput = document.getElementById('auth-input-key');

    // Handle submit inside login overlay
    authSubmit.addEventListener('click', () => {
      const key = authInput.value.trim();
      if (!key) {
        alert('请输入控制面板登录密码！');
        return;
      }
      this.saveApiKey(key);
      authModal.style.display = 'none';
      
      // Retry loading
      this.loadData();
      this.settings.loadSettings();
    });

    // Enter key submit in input
    authInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') authSubmit.click();
    });

    this.setupAuthIndicator();
  }

  triggerAuthModal() {
    const authModal = document.getElementById('auth-modal');
    authModal.style.display = 'flex';
    document.getElementById('auth-input-key').focus();
  }

  // --- Tab Navigation Controller ---
  setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
      item.addEventListener('click', () => {
        const tabName = item.getAttribute('data-tab');
        this.switchTab(tabName);
      });
    });
  }

  switchTab(tabName) {
    this.activeTab = tabName;
    
    // Update Sidebar Navigation state
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.remove('active');
      if (btn.getAttribute('data-tab') === tabName) {
        btn.classList.add('active');
      }
    });

    // Toggle Visible Panes
    document.querySelectorAll('.tab-pane').forEach(pane => {
      pane.classList.remove('active');
    });
    
    const targetPane = document.getElementById(`tab-${tabName}`);
    if (targetPane) targetPane.classList.add('active');

    // Perform specific tab actions
    if (tabName === 'analytics') {
      this.loadStats();
    } else if (tabName === 'logs') {
      this.loadLogs();
    }
  }

  // --- Global Event Controllers ---
  setupGlobalListeners() {
    // Search Box Listener (with basic Debouncing)
    const searchInput = document.getElementById('global-search');
    let debounceTimer;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        this.searchQuery = e.target.value.trim();
        this.currentPage = 0; // reset to page 1
        this.loadLogs();
      }, 350);
    });

    // Refresh Action Button
    document.getElementById('btn-refresh').addEventListener('click', () => {
      this.loadData();
    });

    // Logs filters
    document.getElementById('filter-model').addEventListener('change', () => {
      this.currentPage = 0;
      this.loadLogs();
    });
    document.getElementById('filter-status').addEventListener('change', () => {
      this.currentPage = 0;
      this.loadLogs();
    });

    // Wipe Logs Button
    document.getElementById('btn-clear-logs').addEventListener('click', async () => {
      if (!confirm('您确定要彻底删除所有已拦截抓取的提示词日志吗？此操作将清空数据库且不可恢复！')) {
        return;
      }
      try {
        const response = await fetch('/api/logs/clear', {
          method: 'POST',
          headers: this.getHeaders()
        });

        if (response.status === 401) {
          this.triggerAuthModal();
          return;
        }

        if (!response.ok) throw new Error('清空日志操作失败');
        alert('所有拦截日志已成功清空！');
        this.loadData();
      } catch (err) {
        alert(err.message);
      }
    });

    // Pagination buttons
    const prevBtn = document.getElementById('btn-prev-page');
    const nextBtn = document.getElementById('btn-next-page');

    prevBtn.addEventListener('click', () => {
      if (this.currentPage > 0) {
        this.currentPage--;
        this.loadLogs();
      }
    });

    nextBtn.addEventListener('click', () => {
      if ((this.currentPage + 1) * this.pageSize < this.totalLogs) {
        this.currentPage++;
        this.loadLogs();
      }
    });
  }

  // --- Data Loading Handlers ---
  async loadData() {
    await this.loadStats();
    await this.loadLogs();
  }

  async loadStats() {
    try {
      const response = await fetch('/api/stats', {
        headers: this.getHeaders()
      });

      if (response.status === 401) {
        this.triggerAuthModal();
        return;
      }

      if (!response.ok) throw new Error('Stats fetch failure');
      const statsData = await response.json();
      
      // Update stats dashboard
      this.stats.renderMetrics(statsData);

      // Dynamically populate model filters dropdown
      this.populateModelFilter(statsData.models_breakdown || []);

    } catch (e) {
      console.error('Stats loading error: ', e);
    }
  }

  async loadLogs() {
    const listContainer = document.getElementById('logs-list');
    
    // Build filter queries
    const modelFilter = document.getElementById('filter-model').value;
    const statusFilter = document.getElementById('filter-status').value;

    let url = `/api/logs?limit=${this.pageSize}&offset=${this.currentPage * this.pageSize}&search=${encodeURIComponent(this.searchQuery)}`;
    
    if (modelFilter) url += `&model=${encodeURIComponent(modelFilter)}`;
    if (statusFilter) {
      // Map success/error to numeric equivalents
      if (statusFilter === 'success') {
        url += '&status=200'; // SQLite matches 200 explicitly, backend supports dynamic filters
      } else if (statusFilter === 'error') {
        url += '&status=500'; // backend will show failed
      }
    }

    try {
      const response = await fetch(url, {
        headers: this.getHeaders()
      });

      if (response.status === 401) {
        this.triggerAuthModal();
        return;
      }

      if (!response.ok) throw new Error('Logs fetch failure');
      const logs = await response.json();

      // Update total logs list count (estimate or calculate based on returned items)
      // Since it's a proxy feed, we calculate simple limits
      this.totalLogs = logs.length === this.pageSize ? (this.currentPage + 2) * this.pageSize : (this.currentPage * this.pageSize) + logs.length;

      this.logViewer.renderLogsList(logs);
      this.updatePaginationUI(logs.length);

    } catch (e) {
      listContainer.innerHTML = `
        <div class="empty-state">
          <i class="fa-solid fa-triangle-exclamation" style="color: var(--crimson);"></i>
          <h3>无法载入日志列表</h3>
          <p>${e.message}</p>
        </div>
      `;
    }
  }

  populateModelFilter(modelsList) {
    const dropdown = document.getElementById('filter-model');
    const currentValue = dropdown.value;
    
    // Keep the default "All Models" option
    dropdown.innerHTML = '<option value="">全部模型</option>';
    
    modelsList.forEach(m => {
      const option = document.createElement('option');
      option.value = m.model;
      option.textContent = `${m.model} (${m.count})`;
      dropdown.appendChild(option);
    });

    // Restore selected value
    dropdown.value = currentValue;
  }

  updatePaginationUI(logsReturnedCount) {
    const prevBtn = document.getElementById('btn-prev-page');
    const nextBtn = document.getElementById('btn-next-page');
    const infoSpan = document.getElementById('pagination-info');

    const startIdx = this.currentPage * this.pageSize + 1;
    const endIdx = this.currentPage * this.pageSize + logsReturnedCount;

    if (logsReturnedCount === 0) {
      infoSpan.textContent = '暂无拦截日志记录';
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      return;
    }

    infoSpan.textContent = `显示第 ${startIdx} - ${endIdx} 条记录`;

    prevBtn.disabled = this.currentPage === 0;
    // If we fetched a full page, allow next
    nextBtn.disabled = logsReturnedCount < this.pageSize;
  }
}

// Instantiate and load application on page content load
window.addEventListener('DOMContentLoaded', () => {
  const app = new PromptPulseApp();
  app.init().catch(err => {
    console.error('App failed to initialize: ', err);
  });
});
