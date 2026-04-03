/**
 * Post-install patches for Qwen3.5 compatibility and UI fixes.
 * Run after pnpm install to apply necessary patches to dependencies.
 */
const { readFileSync, writeFileSync } = require('fs');
const { join } = require('path');

const appDir = process.env.APP_DIR || '/app';

// Patch 1: Fix @ai-sdk/openai to treat Qwen models as non-reasoning
// (prevents sending "developer" role which Qwen doesn't support)
const aiSdkPath = join(appDir, 'node_modules/@ai-sdk/openai/dist/index.mjs');
try {
  let content = readFileSync(aiSdkPath, 'utf8');
  const oldCheck = 'const isReasoningModel = !(modelId.startsWith("gpt-3") || modelId.startsWith("gpt-4") || modelId.startsWith("chatgpt-4o") || modelId.startsWith("gpt-5-chat"));';
  const newCheck = 'const isReasoningModel = !(modelId.startsWith("gpt-3") || modelId.startsWith("gpt-4") || modelId.startsWith("chatgpt-4o") || modelId.startsWith("gpt-5-chat") || modelId.startsWith("Qwen") || modelId.startsWith("qwen"));';
  if (content.includes(oldCheck)) {
    content = content.replace(oldCheck, newCheck);
    writeFileSync(aiSdkPath, content, 'utf8');
    console.log('[PATCH] Applied Qwen role compatibility fix to @ai-sdk/openai');
  } else {
    console.log('[PATCH] @ai-sdk/openai already patched or structure changed');
  }
} catch (e) {
  console.warn('[PATCH] Could not patch @ai-sdk/openai:', e.message);
}

// Patch 2: Fix web-search plugin to use plain text URLs (no markdown links that trigger embeds)
const webSearchPath = join(appDir, 'node_modules/@elizaos/plugin-web-search/dist/index.js');
try {
  let content = readFileSync(webSearchPath, 'utf8');
  const oldFormat = '(result2, index) => `${index + 1}. [${result2.title}](${result2.url})`';
  const newFormat = `(result2, index) => {
            const url = result2.url || '';
            const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
            const displayUrl = isYouTube ? url.replace('https://', '').replace('http://', '') : url;
            return \`\${index + 1}. \${result2.title}\${displayUrl ? \` — \${displayUrl}\` : ''}\`;
          }`;
  if (content.includes(oldFormat)) {
    content = content.replace(oldFormat, newFormat);
    writeFileSync(webSearchPath, content, 'utf8');
    console.log('[PATCH] Applied plain-text URL fix to plugin-web-search');
  } else {
    console.log('[PATCH] plugin-web-search already patched or structure changed');
  }
} catch (e) {
  console.warn('[PATCH] Could not patch plugin-web-search:', e.message);
}

console.log('[PATCH] All patches applied');
