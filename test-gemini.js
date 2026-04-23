const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

async function testGemini() {
  console.log('Testing Gemini API...');
  console.log('API Key exists:', !!process.env.GEMINI_API_KEY);
  
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY not found in .env file');
    return;
  }
  
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  
  // Use the correct model names from the API response
  const models = [
    'models/gemini-2.0-flash',
    'models/gemini-2.5-flash',
    'models/gemini-2.5-pro'
  ];
  
  console.log('\n🔍 Testing correct model names...');
  
  for (const modelName of models) {
    console.log(`\nTrying model: ${modelName}`);
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent("Say 'Hello! I am working!' in one sentence.");
      const response = await result.response;
      console.log(`✅ ${modelName} works! Response:`, response.text());
      console.log('\n🎉 SUCCESS! Use this model name in your code.');
      return;
    } catch (err) {
      console.log(`❌ ${modelName} failed:`, err.message);
    }
  }
  
  console.log('\n⚠️ No models worked. Trying direct REST API...');
  
  // Fallback to direct REST API
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: "Say 'Hello! I am working!' in one sentence."
            }]
          }]
        })
      }
    );
    
    const data = await response.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log('✅ Direct REST API works! Response:', reply);
  } catch (err) {
    console.error('Direct REST API also failed:', err.message);
  }
}

testGemini();