/**
 * Stats and Analytics Component
 * Renders high-fidelity interactive SVG charts and metrics lists.
 */
export const StatsComponent = {
  renderMetrics(stats) {
    // Format large numbers
    const formatNum = (n) => new Intl.NumberFormat().format(n);

    // Calculate percentages
    const total = stats.total_requests || 0;
    const success = stats.success_requests || 0;
    const error = stats.error_requests || 0;
    
    const successRate = total > 0 ? Math.round((success / total) * 100) : 0;
    const failRate = total > 0 ? Math.round((error / total) * 100) : 0;

    // Update simple text elements
    document.getElementById('stat-total-calls').textContent = formatNum(total);
    document.getElementById('stat-success-rate').textContent = `${successRate}% 成功率`;
    
    const totalTokens = (stats.total_tokens_input || 0) + (stats.total_tokens_output || 0);
    document.getElementById('stat-total-tokens').textContent = formatNum(totalTokens);
    document.getElementById('stat-token-split').textContent = 
      `${formatNum(stats.total_tokens_input || 0)} 输入 • ${formatNum(stats.total_tokens_output || 0)} 输出`;

    document.getElementById('stat-avg-latency').textContent = `${stats.avg_latency_ms || 0} ms`;

    document.getElementById('stat-failed-requests').textContent = formatNum(error);
    document.getElementById('stat-fail-percentage').textContent = `${failRate}% 失败率`;

    // Render Sub-components
    this.renderVolumeChart(stats.daily_volume || []);
    this.renderTopModels(stats.models_breakdown || []);
    this.renderLatencyTimeline(stats.recent_latency || []);
  },

  renderVolumeChart(dailyData) {
    const container = document.getElementById('volume-chart-container');
    if (!container) return;

    if (!dailyData || dailyData.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <i class="fa-solid fa-chart-line"></i>
          <h3>暂无接口走势数据</h3>
          <p>向本地代理端口发送一些请求后，本走势图表将自动刷新并展示流量趋势。</p>
        </div>
      `;
      return;
    }

    // Set SVG parameters
    const width = 600;
    const height = 180;
    const paddingLeft = 40;
    const paddingRight = 20;
    const paddingTop = 15;
    const paddingBottom = 25;

    const chartW = width - paddingLeft - paddingRight;
    const chartH = height - paddingTop - paddingBottom;

    // Get max value for scaling
    const maxVal = Math.max(...dailyData.map(d => d.count), 5); // default min height is 5

    // Build SVG points
    const points = [];
    const stepX = dailyData.length > 1 ? chartW / (dailyData.length - 1) : chartW;

    dailyData.forEach((d, i) => {
      const x = paddingLeft + i * stepX;
      const y = paddingTop + chartH - (d.count / maxVal) * chartH;
      points.push({ x, y, data: d });
    });

    // Create SVG elements
    let svgHtml = `
      <svg viewBox="0 0 ${width} ${height}" class="chart-svg">
        <defs>
          <linearGradient id="chart-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--primary)" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="var(--primary)" stop-opacity="0.0"/>
          </linearGradient>
        </defs>
    `;

    // Draw Grid Lines (Horizontal)
    const gridLinesCount = 4;
    for (let i = 0; i <= gridLinesCount; i++) {
      const yVal = paddingTop + (chartH / gridLinesCount) * i;
      const labelVal = Math.round(maxVal - (maxVal / gridLinesCount) * i);
      
      svgHtml += `
        <line x1="${paddingLeft}" y1="${yVal}" x2="${width - paddingRight}" y2="${yVal}" class="chart-grid-line" />
        <text x="${paddingLeft - 10}" y="${yVal + 3}" class="chart-axis-text" text-anchor="end">${labelVal}</text>
      `;
    }

    // Draw Line & Area path
    if (points.length > 0) {
      let linePath = `M ${points[0].x} ${points[0].y}`;
      let areaPath = `M ${points[0].x} ${paddingTop + chartH} L ${points[0].x} ${points[0].y}`;

      for (let i = 1; i < points.length; i++) {
        // Curve construction using cubic-bezier approximation
        const prev = points[i - 1];
        const curr = points[i];
        const cpX1 = prev.x + (curr.x - prev.x) / 2;
        const cpY1 = prev.y;
        const cpX2 = prev.x + (curr.x - prev.x) / 2;
        const cpY2 = curr.y;

        linePath += ` C ${cpX1} ${cpY1}, ${cpX2} ${cpY2}, ${curr.x} ${curr.y}`;
        areaPath += ` C ${cpX1} ${cpY1}, ${cpX2} ${cpY2}, ${curr.x} ${curr.y}`;
      }

      areaPath += ` L ${points[points.length - 1].x} ${paddingTop + chartH} Z`;

      svgHtml += `<path d="${areaPath}" class="chart-area" />`;
      svgHtml += `<path d="${linePath}" class="chart-line" />`;
    }

    // Draw dots and X Axis Labels
    points.forEach((p) => {
      // Shorten date from YYYY-MM-DD to MM-DD
      const dateParts = p.data.date.split('-');
      const displayDate = dateParts.length > 2 ? `${dateParts[1]}-${dateParts[2]}` : p.data.date;

      svgHtml += `
        <circle cx="${p.x}" cy="${p.y}" r="4" class="chart-dot">
          <title>${p.data.date}: 调用量 ${p.data.count} 次 (已拦截 ${p.data.total_tokens || 0} Token)</title>
        </circle>
        <text x="${p.x}" y="${height - 5}" class="chart-axis-text" text-anchor="middle">${displayDate}</text>
      `;
    });

    svgHtml += `</svg>`;
    container.innerHTML = svgHtml;
  },

  renderTopModels(models) {
    const container = document.getElementById('model-list-container');
    if (!container) return;

    if (!models || models.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding: 20px 0;">
          <i class="fa-solid fa-microchip"></i>
          <h3>暂无已捕获的模型调用记录</h3>
        </div>
      `;
      return;
    }

    // Get maximum requests count to scale progress bars
    const maxCount = Math.max(...models.map(m => m.count), 1);
    const totalRequests = models.reduce((acc, curr) => acc + curr.count, 0);

    let html = '';
    models.forEach((m) => {
      const percentage = Math.round((m.count / totalRequests) * 100);
      const widthPct = (m.count / maxCount) * 100;

      html += `
        <div class="model-row">
          <div class="model-info-row">
            <span class="model-label-name">${m.model}</span>
            <span class="model-stats-text"><strong>${m.count}</strong> 次请求 (${percentage}%)</span>
          </div>
          <div class="model-progress-bar-bg" title="累计消耗 Token: ${m.total_tokens || 0}">
            <div class="model-progress-bar" style="width: ${widthPct}%"></div>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  },

  renderLatencyTimeline(recentLatency) {
    const container = document.getElementById('latency-timeline-container');
    if (!container) return;

    if (!recentLatency || recentLatency.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding: 20px 0; min-width: 100%;">
          <i class="fa-solid fa-clock-rotate-left"></i>
          <h3>暂无已捕获的响应耗时指标</h3>
        </div>
      `;
      return;
    }

    // Get max duration
    const maxDuration = Math.max(...recentLatency.map(l => l.duration), 1000); // minimum scale is 1s

    let html = '';
    // Reverse array to show chronological order from left to right
    [...recentLatency].reverse().forEach((l) => {
      const heightPct = Math.max((l.duration / maxDuration) * 100, 4); // minimum bar height is 4%
      const dateStr = new Date(l.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const isErr = l.status >= 400 || l.status === 0;

      html += `
        <div class="latency-bar-container" title="请求时间: ${dateStr}&#10;拦截模型: ${l.model}&#10;代理耗时: ${l.duration} ms&#10;状态代码: ${l.status}">
          <div class="latency-bar ${isErr ? 'err' : ''}" style="height: ${heightPct}px;"></div>
        </div>
      `;
    });

    container.innerHTML = html;
  }
};
