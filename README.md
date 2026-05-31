# PromptPulse

这是一个轻量、好用的**本地 LLM API 请求收集器和网关代理**。

### 为什么写它？
在开发大模型应用的时候，我们经常需要看客户端发出去的 Prompt 到底长什么样（特别是多轮对话拼接后的完整上下文），以及模型回过来的真实内容。如果每次都去翻云端日志或者在代码里写 `console.log` 会非常抓狂。

PromptPulse 就是为了解决这个痛点写的。它作为代理挂在你的客户端和真实大模型上游之间，静默记录所有的请求和回复（包括 **SSE 流式打字机** 响应），并提供了一个挺好看的暗黑风中文控制台，让你能一眼看清所有的 Prompt 细节，甚至能一键把历史请求导入沙盒里重新测试。

---

## 💡 它能做什么？

- **通吃 OpenAI 和 Gemini 格式**：
  - **OpenAI 兼容接口**：拦截 `POST /v1/chat/completions`。
  - **Google Gemini 接口**：拦截 `POST /v1beta/models/...` 的普通生成和流式生成请求。
- **无感拦截流式响应 (SSE)**：透传流式 Chunk 时，后台会默默帮你把所有的碎片字符拼成完整的回复并存入数据库，客户端的打字效果完全不受影响。
- **对话流统一渲染**：把 Gemini 复杂的 `contents` 树自动转化并对齐成直观的 `messages` 数组，在控制面板里都能用对话气泡精美展示。
- **双重密码隔离**：
  - **控制台登录密码**：网页登录用它解锁。
  - **网关 API Key**：你的代码/客户端调用代理时鉴权用它，各司其职。
- **开箱即用的离线沙盒**：
  - 基于 Node 22 原生内置的 SQLite 模块（`node:sqlite`），**不需要安装和编译任何复杂的 C++ 底层依赖**，Windows 上直接就能跑。
  - 默认自带离线 Mock 模式，不配置 Key 也能在本地假装调用 OpenAI/Gemini 体验流式效果。

---

## 📂 项目结构

```
├── server.js                  # 服务端主入口（网关代理 + SSE 捕获逻辑）
├── database.js                # 本地 SQLite 初始化与查询方法（Node 22 原生 SQLite）
├── config.json                # 配置端口（默认 3000）
├── public/                    # 控制台网页前端代码（免打包构建，即改即生效）
│   ├── index.html             # 结构骨架
│   ├── styles.css             # 极光暗黑风格样式表
│   └── components/            # 图表、日志、沙盒、设置等功能组件
```

---

## 🚀 快速上手

### 1. 跑起来
确保你使用的是 Node.js 22+ 版本，直接拉下依赖并启动：

```bash
# 装一下极其轻量级的 express 和 cors
npm install

# 跑起来，数据库文件 prompt_pulse.db 会自动在根目录创建
npm start
```

服务起来后：
* **网页控制台**：`http://localhost:3000`
* **OpenAI 代理地址**：`http://localhost:3000/v1`
* **Gemini 代理地址**：`http://localhost:3000/v1beta`

### 2. 客户端接入

#### 🐍 Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    api_key="你的真实API密钥",
    base_url="http://localhost:3000/v1" # 指向本地 PromptPulse 代理
)

response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "你好，请确认你的工作状态！"}],
    stream=True
)
```

#### 🌐 Gemini 接口 (curl 示例)
```bash
curl -X POST "http://localhost:3000/v1beta/models/gemini-2.5-flash:generateContent?key=你的Gemini密钥" \
     -H "Content-Type: application/json" \
     -d '{"contents": [{"parts": [{"text": "你好！"}]}]}'
```

---

## 🛡️ 安全配置
在控制台的 **“全局设置”** 里可以单独配置两个密码：
* **控制面板登录密码**：设置后，访问网页控制台必须输入密码解锁。
* **外部网关 API 密钥**：设置后，你的代码请求代理接口时必须在 `x-collector-key` 头或 `Bearer` 中带上这个 Key。

---

## 📄 许可证
MIT