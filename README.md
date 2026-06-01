# PromptPulse

PromptPulse 是一个极其轻巧且好用的**大模型 API 调试代理与请求捕获网关**。

在开发 AI 应用时，我们经常需要弄清楚：客户端发出去的 Prompt 在经过层层编排后到底长什么样？模型返回的真实数据和 Token 消耗是多少？特别是在使用流式输出（SSE）时，断点调试和抓包都会变得非常痛苦。

PromptPulse 专为解决此痛点而设计。它能够无感地代理本地的 OpenAI 与 Gemini 格式请求，完整捕获、解析并聚合每一次对话数据（包括流式响应和多轮对话结构），并提供一个直观、精美的极光暗黑风格 Dashboard。

---

## ✨ 核心特性

- **🚀 零外部数据库依赖**：利用 Node.js 22 原生内置的 SQLite 模块（`node:sqlite`），无须安装或编译任何复杂的本地 C++ 驱动或第三方数据库，开箱即用，对 Windows 环境极其友好。
- **🔌 双协议透明代理**：
  - **OpenAI 兼容协议**：完美支持 `/v1/chat/completions`。
  - **Google Gemini 协议**：完美支持 `/v1beta/models/:generateContent` 和 `/v1beta/models/:streamGenerateContent`。
- **🛡️ 纯透明的 Key 转发与透传**：网关本身**不做任何 API 密钥验证或拦截**。客户端发送的密钥（如 `Authorization: Bearer KEY` 或 `?key=KEY`）会完整且安全地透传给真实上游，完美兼容现有 SDK。
- **⚡ 流式 SSE 响应无感捕获**：在透传 SSE 打字机流式响应的同时，后台能够实时重组碎片字符，将其拼接成完整响应存入数据库，不影响客户端毫秒级的首字延迟。
- **🧩 统一日志视界与会话气泡**：支持自动解析 Gemini 特有的复杂 `contents` 树并对齐至标准 `messages` 数组，在控制台统一提供精美的对话气泡渲染。
- **💡 离线沙盒与 Mock 引擎**：未配置真实密钥时，默认开启内置的离线 Mock 引擎，可秒级响应高保真的模拟流式或标准对话，方便离线开发与联调。
- **🔒 安全隔离控制台**：配置 `dashboard_password` 即可一键启用控制面板的密码保护，实现 API 网关零门槛使用，而后台日志与敏感配置只有你能看。

---

## 📂 项目结构

```
├── server.js                  # 服务端主程序（代理路由 + SSE 捕获逻辑）
├── database.js                # SQLite 数据库服务（免安装原生 SQLite）
├── config.json                # 系统级端口配置（默认 3000）
├── public/                    # 极光暗黑控制台前端（纯 HTML5/Vanilla CSS，免编译打包）
│   ├── index.html             # UI 布局结构
│   ├── styles.css             # 前端样式设计
│   └── components/            # 图表、日志、沙盒与设置等核心交互组件
```

---

## 🚀 快速上手

### 1. 启动服务
确保你已安装 **Node.js 22+**，直接克隆代码并运行：

```bash
# 安装轻量级运行时依赖（express, cors）
npm install

# 启动服务，系统会自动初始化本地 SQLite 数据库文件 prompt_pulse.db
npm start
```

服务成功运行后：
* 📊 **网页控制台**：[http://localhost:3000](http://localhost:3000)
* 🔌 **OpenAI 代理端点**：`http://localhost:3000/v1`
* 🔌 **Gemini 代理端点**：`http://localhost:3000/v1beta`

---

## 💻 客户端接入示例

使用 PromptPulse 代理非常简单，你只需在现有 SDK 中将 `baseURL` 指向本地网关，并传入你的真实上游密钥即可。

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-your-real-openai-key",  # 真实的 OpenAI 密钥，网关会自动安全地透传给上游
    base_url="http://localhost:3000/v1"  # 切换到 PromptPulse 本地网关地址
)

response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "你好，请确认你的代理状态。"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### Google Gemini API (curl)

```bash
curl -X POST "http://localhost:3000/v1beta/models/gemini-2.5-flash:generateContent?key=your-gemini-key" \
     -H "Content-Type: application/json" \
     -d '{"contents": [{"parts": [{"text": "你好，这是一次测试！"}]}]}'
```

---

## 🛡️ 安全与配置

通过控制面板的 **“全局设置”** (Settings)，你可以：
1. **控制面板登录密码**：设置后，访问网页 Dashboard 必须输入密码解锁，保证本地调试日志的隐私性。
2. **默认上游网关**：配置默认的上游 API Base URL 和 API 密钥（如默认的 OpenAI / Gemini 官方链接）。当你的客户端请求头中未显式包含 API 密钥时，网关将使用此处配置的全局默认密钥完成调用。

---

## 📄 开源协议

基于 [MIT License](LICENSE) 开源。