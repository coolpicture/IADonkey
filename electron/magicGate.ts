import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AppConfig } from '../src/types';

// Cryptographic keys extracted from MagicWare.MagicGate
const RIJN_KEY = Buffer.from([
  69, 229, 180, 207, 34, 6, 164, 125, 129, 204, 146, 10, 216, 32, 118, 162,
  117, 215, 101, 158, 70, 139, 159, 214, 87, 44, 97, 39, 203, 198, 170, 248,
]);

const RIJN_IV = Buffer.from([
  16, 23, 243, 15, 75, 150, 130, 237, 168, 84, 21, 214, 153, 151, 68, 133,
]);

const FAST_WAKE_THRESHOLD_MS = 4000;
const WAKEUP_TOTAL_TIMEOUT_MS = 90000;
const WAKEUP_ATTEMPT_TIMEOUT_MS = 30000;
const WAKEUP_RETRY_DELAY_MS = 1500;
const POST_WAKEUP_SETTLE_MS = 400;
const HANDSHAKE_TIMEOUT_MS = 20000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 500 || status === 502 || status === 503 || status === 504 || status >= 520;
}

/**
 * Computes the internal password hash using AES-256-CBC and SHA-256
 */
export function getMagicPasswordHash(salt: string, plainPassword: string): string {
  if (!salt || !plainPassword) return '';

  const plainBytes = Buffer.from(salt + plainPassword, 'utf16le');
  const remainder = plainBytes.length % 16;
  const padLen = remainder === 0 ? 0 : 16 - remainder;
  const paddedBytes = Buffer.concat([plainBytes, Buffer.alloc(padLen, 0)]);

  const cipher = crypto.createCipheriv('aes-256-cbc', RIJN_KEY, RIJN_IV);
  cipher.setAutoPadding(false);

  const encrypted = Buffer.concat([cipher.update(paddedBytes), cipher.final()]);
  const sha256 = crypto.createHash('sha256').update(encrypted).digest();
  return sha256.toString('utf8');
}

/**
 * Computes the signature key passed as AuthenticationKey
 */
export function getAuthenticationKey(salt: string, plainPassword: string, requestKey: string): string {
  const hash = getMagicPasswordHash(salt, plainPassword);
  const toSign = [salt, hash, requestKey].join('|');
  const sha256 = crypto.createHash('sha256').update(Buffer.from(toSign, 'utf8')).digest();
  return sha256.toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}

/**
 * Automatically imports and decrypts MagicGate credentials from Wox settings if available
 */
export function tryImportWoxCredentials(): { username: string; password: string } | null {
  try {
    const appData = process.env.APPDATA || '';
    const woxSettingsPath = path.join(appData, 'Wox', 'Settings', 'Plugins', 'Wox.MagicGate', 'Settings.json');
    if (!fs.existsSync(woxSettingsPath)) {
      return null;
    }

    const raw = fs.readFileSync(woxSettingsPath, 'utf-8');
    const settings = JSON.parse(raw);
    const username = (settings.Username || '').trim();
    const encPass = (settings.EncryptedPassword || '').trim();

    if (!encPass) {
      return username ? { username, password: '' } : null;
    }

    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(encPass)) {
      console.warn('[MagicGate] Invalid Base64 in Wox EncryptedPassword, skipping DPAPI decrypt.');
      return username ? { username, password: '' } : null;
    }

    const psScript = [
      'Add-Type -AssemblyName System.Security;',
      '$b = [Convert]::FromBase64String($env:WOX_ENC_PASS);',
      '$d = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
      '[Console]::Write([System.Text.Encoding]::UTF8.GetString($d));',
    ].join(' ');

    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      env: { ...process.env, WOX_ENC_PASS: encPass },
      encoding: 'utf-8',
      windowsHide: true,
    });

    if (res.error || res.status !== 0) {
      throw res.error || new Error(res.stderr || 'DPAPI decrypt failed');
    }

    const password = (res.stdout || '').trim();

    return { username, password };
  } catch (err) {
    console.warn('[MagicGate] Could not auto-import credentials from Wox:', err);
    return null;
  }
}

/**
 * Performs handshake with AutoLogin.ashx and constructs the signed auto-login URL.
 * Supports sleeping test instances by waiting for instance wake-up first and then
 * executing a delayed fresh handshake once the server is responsive.
 */
export async function getMagicGateAutoLoginUrl(targetUrl: string, config: AppConfig): Promise<string> {
  let username = config.magicgate?.username?.trim();
  let password = config.magicgate?.password?.trim();

  // If credentials are empty in config, attempt to load from Wox
  if (!username || !password) {
    const woxCreds = tryImportWoxCredentials();
    if (woxCreds) {
      if (!username && woxCreds.username) username = woxCreds.username;
      if (!password && woxCreds.password) password = woxCreds.password;
    }
  }

  if (!username || !password) {
    throw new Error('Chybí přihlašovací údaje pro MagicGate. Zadejte je v Nastavení aplikace.');
  }

  const parsed = new URL(targetUrl.startsWith('http') ? targetUrl : `https://${targetUrl}`);
  const baseUrl = `${parsed.protocol}//${parsed.host}`;
  const tokenUrl = `${baseUrl}/AutoLogin.ashx?UN=${encodeURIComponent(username)}`;

  const overallStart = Date.now();
  const deadline = overallStart + WAKEUP_TOTAL_TIMEOUT_MS;
  let attempt = 0;
  let wasSleeping = false;
  let tokenText: string | null = null;
  let wakeUpTokenFallback: string | null = null;
  let lastError: unknown = null;

  console.log(`[MagicGate] Requesting handshake from ${baseUrl}/AutoLogin.ashx for user ${username}...`);

  // Phase 1: Initial probe / wake-up loop for sleeping instances
  while (Date.now() < deadline) {
    attempt++;
    const attemptStart = Date.now();
    const remainingMs = deadline - attemptStart;
    if (remainingMs <= 0) break;

    const attemptTimeoutMs = Math.max(5000, Math.min(WAKEUP_ATTEMPT_TIMEOUT_MS, remainingMs));

    try {
      const res = await fetch(tokenUrl, {
        signal: AbortSignal.timeout(attemptTimeoutMs),
        cache: 'no-store',
      });

      const elapsedMs = Date.now() - overallStart;

      if (!res.ok) {
        const statusErr = new Error(`AutoLogin handshake selhal (HTTP ${res.status})`);
        if (isTransientHttpStatus(res.status) && Date.now() + WAKEUP_RETRY_DELAY_MS < deadline) {
          wasSleeping = true;
          lastError = statusErr;
          console.warn(
            `[MagicGate] Instance ${baseUrl} waking up (HTTP ${res.status} on attempt ${attempt} after ${elapsedMs}ms), retrying...`
          );
          await delay(WAKEUP_RETRY_DELAY_MS);
          continue;
        }
        throw statusErr;
      }

      const bodyText = await res.text();
      if (bodyText.startsWith('OK')) {
        // Fast response on first attempt -> instance is already awake, use token directly
        if (attempt === 1 && !wasSleeping && elapsedMs <= FAST_WAKE_THRESHOLD_MS) {
          tokenText = bodyText;
          break;
        }

        // Instance was sleeping (took longer than threshold or required retries)
        wasSleeping = true;
        wakeUpTokenFallback = bodyText;
        console.log(
          `[MagicGate] Sleeping instance ${baseUrl} woke up after ${elapsedMs}ms (attempt ${attempt}). Delaying for fresh handshake...`
        );
        break;
      }

      // Non-OK body: if it looks like an HTML startup/error page during cold start, retry
      const trimmedBody = bodyText.trimStart();
      if ((trimmedBody.startsWith('<') || elapsedMs > FAST_WAKE_THRESHOLD_MS) && Date.now() + WAKEUP_RETRY_DELAY_MS < deadline) {
        wasSleeping = true;
        lastError = new Error(`AutoLogin server odmítl požadavek: ${bodyText.slice(0, 200)}`);
        console.warn(`[MagicGate] Instance ${baseUrl} returned non-OK response during wake-up (attempt ${attempt}), retrying...`);
        await delay(WAKEUP_RETRY_DELAY_MS);
        continue;
      }

      throw new Error(`AutoLogin server odmítl požadavek: ${bodyText}`);
    } catch (err: any) {
      const isTimeoutOrNetwork =
        err?.name === 'TimeoutError' ||
        err?.name === 'AbortError' ||
        err?.name === 'TypeError' ||
        /timeout|aborted|fetch failed|ECONN|ENOTFOUND|UND_ERR/i.test(String(err?.message || err));

      if (isTimeoutOrNetwork && Date.now() + WAKEUP_RETRY_DELAY_MS < deadline) {
        wasSleeping = true;
        lastError = err;
        console.warn(
          `[MagicGate] Instance ${baseUrl} did not respond on attempt ${attempt} (${err?.message || err}), waiting for wake-up...`
        );
        await delay(WAKEUP_RETRY_DELAY_MS);
        continue;
      }

      throw err;
    }
  }

  // Phase 2: Delayed fresh handshake once the sleeping instance has woken up
  if (wasSleeping && !tokenText) {
    await delay(POST_WAKEUP_SETTLE_MS);
    try {
      console.log(`[MagicGate] Executing delayed handshake on warmed-up instance ${baseUrl}/AutoLogin.ashx...`);
      const freshRes = await fetch(tokenUrl, {
        signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
        cache: 'no-store',
      });
      if (freshRes.ok) {
        const freshText = await freshRes.text();
        if (freshText.startsWith('OK')) {
          tokenText = freshText;
        }
      }
    } catch (freshErr: any) {
      console.warn(`[MagicGate] Delayed fresh handshake failed, checking fallback token:`, freshErr?.message || freshErr);
      lastError = freshErr;
    }

    if (!tokenText && wakeUpTokenFallback) {
      tokenText = wakeUpTokenFallback;
    }
  }

  if (!tokenText) {
    throw lastError instanceof Error
      ? lastError
      : new Error('AutoLogin handshake vypršel (spící instance se neprobudila v časovém limitu 90 s).');
  }

  const rawKey = tokenText.substring(2);
  let requestKey = rawKey;
  let salt = username;

  if (rawKey.includes('|')) {
    const parts = rawKey.split('|');
    requestKey = parts[0];
    salt = parts[1] || username;
  }

  const authKey = getAuthenticationKey(salt, password, requestKey);

  const autoLoginUrl = `${baseUrl}/AutoLogin.ashx?AuthenticationKey=${encodeURIComponent(
    authKey
  )}&AuthenticationName=${encodeURIComponent(username)}&RequestKey=${encodeURIComponent(requestKey)}`;

  console.log(`[MagicGate] Handshake successful for ${baseUrl}/AutoLogin.ashx (user: ${username})`);
  return autoLoginUrl;
}
