/**
 * classifier-cache.ts - Shared memory cache for classification results
 *
 * Cross-process shared memory for PromptProcessing.hook.ts classification.
 * Uses MEMORY/STATE/classifier-cache/ — PAI's canonical shared state filesystem.
 *
 * Two caches:
 * 1. Compiled system prompt cache — avoids rebuilding buildContextPrompt() text
 * 2. Inference result cache — skips re-running inference for identical prompts
 *
 * TRIGGER: Called by PromptProcessing.hook.ts
 * STORAGE: <memoryDir>/STATE/classifier-cache/
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

import { getMemoryDir, memoryPath } from './paths';
import { getIdentity, getPrincipal } from './identity';

interface CachedResult {
  session_id: string;
  prompt_hash: string;
  tab_title: string | null;
  session_name: string | null;
  mode: 'MINIMAL' | 'NATIVE' | 'ALGORITHM' | null;
  tier: number | null;
  mode_reason: string | null;
  timestamp: string;
}

interface CompiledPromptCache {
  identity_key: string;
  include_session_name: boolean;
  system_prompt: string;
  timestamp: string;
}

function cacheDir(): string {
  const dir = join(getMemoryDir(), 'STATE', 'classifier-cache');
  try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  return dir;
}

function resultPath(sessionId: string): string {
  return join(cacheDir(), `${sessionId}.json`);
}

function promptPath(key: string): string {
  return join(cacheDir(), `prompt-${key}.json`);
}

function shortHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const chr = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return Math.abs(hash).toString(36).slice(0, 10);
}

export function computePromptHash(prompt: string): string {
  const normalized = prompt
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
    .toLowerCase();
  return shortHash(normalized);
}

export function computeIdentityKey(): string {
  try {
    const identity = getIdentity();
    const principal = getPrincipal();
    return shortHash(`${identity.name}:${principal.name}`);
  } catch {
    return 'default';
  }
}

export function loadCompiledPrompt(identityKey: string, includeSessionName: boolean): string | null {
  try {
    const pk = shortHash(`${identityKey}:${includeSessionName}`);
    const path = promptPath(pk);
    if (!existsSync(path)) return null;
    const data: CompiledPromptCache = JSON.parse(readFileSync(path, 'utf-8'));
    if (data.identity_key === identityKey && data.include_session_name === includeSessionName) {
      return data.system_prompt;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCompiledPrompt(identityKey: string, includeSessionName: boolean, systemPrompt: string): void {
  try {
    const pk = shortHash(`${identityKey}:${includeSessionName}`);
    writeFileSync(promptPath(pk), JSON.stringify({
      identity_key: identityKey,
      include_session_name: includeSessionName,
      system_prompt: systemPrompt,
      timestamp: new Date().toISOString(),
    }), 'utf-8');
  } catch {
    /* best-effort */
  }
}

export function loadCachedResult(sessionId: string, promptHash: string): CachedResult | null {
  try {
    const path = resultPath(sessionId);
    if (!existsSync(path)) return null;
    const data: CachedResult = JSON.parse(readFileSync(path, 'utf-8'));
    if (data.prompt_hash === promptHash && data.session_id === sessionId) {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCachedResult(result: CachedResult): void {
  try {
    writeFileSync(resultPath(result.session_id), JSON.stringify(result), 'utf-8');
  } catch {
    /* best-effort */
  }
}

export function clearSessionCache(sessionId: string): void {
  try {
    const path = resultPath(sessionId);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best-effort */
  }
}
