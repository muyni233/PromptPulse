const fetch = globalThis.fetch;

async function runTests() {
  console.log('\n======================================================');
  console.log('🤖 Running PromptPulse Gemini API Integration Tests');
  console.log('======================================================\n');

  // Test 1: Standard generateContent request
  console.log('🔹 Test 1: Sending standard generateContent request...');
  try {
    const startTime = Date.now();
    const response = await fetch('http://127.0.0.1:3000/v1beta/models/gemini-2.5-flash:generateContent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connection': 'close'
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: '你好，请确认你的正常工作状态。' }]
          }
        ],
        generationConfig: {
          temperature: 0.7
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Server returned error: ${response.status} ${response.statusText}`);
    }

    const duration = Date.now() - startTime;
    const data = await response.json();
    console.log(`✅ Success (HTTP ${response.status}) in ${duration}ms!`);
    console.log(`🤖 Response Text: "${data.candidates[0].content.parts[0].text}"`);
    console.log(`📊 Tokens: ${data.usageMetadata.promptTokenCount} input, ${data.usageMetadata.candidatesTokenCount} output\n`);
  } catch (err) {
    console.error('❌ Test 1 Failed: ', err.message);
  }

  // Test 2: Streaming streamGenerateContent request
  console.log('🔹 Test 2: Sending streaming streamGenerateContent request...');
  try {
    const startTime = Date.now();
    const response = await fetch('http://127.0.0.1:3000/v1beta/models/gemini-2.5-flash:streamGenerateContent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connection': 'close'
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: '请输出一个简短的内容流测试。' }]
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Server returned error: ${response.status} ${response.statusText}`);
    }

    console.log(`✅ Success (HTTP ${response.status}) connection opened! Streaming chunks:`);
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedText = '';
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunkStr = decoder.decode(value, { stream: true });
      buffer += chunkStr;

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          // Parse candidate text from Gemini chunk
          let clean = line;
          if (clean.startsWith('[')) clean = clean.slice(1).trim();
          if (clean.endsWith(']')) clean = clean.slice(0, -1).trim();
          if (clean.startsWith(',')) clean = clean.slice(1).trim();

          try {
            const parsed = JSON.parse(clean);
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (text) {
              process.stdout.write(text);
              accumulatedText += text;
            }
          } catch (e) {
            // Ignore incomplete
          }
        }
      }
    }
    
    const duration = Date.now() - startTime;
    console.log(`\n\n✅ Stream finished in ${duration}ms!`);
    console.log(`📊 Accumulated text length: ${accumulatedText.length} characters.\n`);

  } catch (err) {
    console.error('❌ Test 2 Failed: ', err.message);
  }

  console.log('======================================================');
  console.log('🎉 Gemini Integration Verification Completed!');
  console.log('======================================================\n');
  process.exit(0);
}

runTests();
