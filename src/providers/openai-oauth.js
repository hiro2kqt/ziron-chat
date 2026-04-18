/**
 * OpenAI Codex OAuth implementation
 * Simplified version inspired by openclaw
 */

import { createServer } from 'http';
import { randomBytes, createHash } from 'crypto';
import { exec } from 'child_process';
import logger from '../utils/logger.js';

// OpenAI OAuth configuration
const OPENAI_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';  // OpenAI Codex client ID
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const CALLBACK_PORT = 1455;

/**
 * Generate PKCE code verifier and challenge
 * @returns {{verifier: string, challenge: string}}
 */
function generatePKCE() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256')
    .update(verifier)
    .digest('base64url');

  return { verifier, challenge };
}

/**
 * Generate random state for OAuth
 * @returns {string}
 */
function generateState() {
  return randomBytes(16).toString('hex');
}

/**
 * Build OAuth authorization URL
 * @param {{challenge: string, state: string}} params
 * @returns {string}
 */
function buildAuthorizationUrl({ challenge, state }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email offline_access',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'pi',
  });

  return `${OPENAI_AUTH_URL}?${params.toString()}`;
}

/**
 * Start OAuth callback server
 * @param {string} expectedState
 * @returns {Promise<string>} Authorization code
 */
function startCallbackServer(expectedState) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        const errorDesc = url.searchParams.get('error_description') || error;
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>✗ Authentication failed</h1><p>${errorDesc}</p>`);
        server.close();
        reject(new Error(errorDesc));
        return;
      }

      if (!code || state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>✗ Invalid callback</h1><p>Missing code or state mismatch.</p>');
        server.close();
        reject(new Error('Invalid OAuth callback'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <head>
            <title>Authentication Successful</title>
            <style>
              body { font-family: system-ui; padding: 40px; text-align: center; }
              h1 { color: #10b981; }
            </style>
          </head>
          <body>
            <h1>Authentication successful!</h1>
            <p>You can close this window and return to your terminal.</p>
          </body>
        </html>
      `);

      server.close();
      resolve(code);
    });

    server.listen(CALLBACK_PORT, () => {
      logger.debug(`OAuth callback server listening on port ${CALLBACK_PORT}`);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth timeout - no response received within 5 minutes'));
    }, 5 * 60 * 1000);
  });
}

/**
 * Exchange authorization code for tokens
 * @param {{code: string, verifier: string}} params
 * @returns {Promise<Object>} Tokens
 */
async function exchangeCodeForTokens({ code, verifier }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code: code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  });

  const response = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${response.status} - ${error}`);
  }

  return await response.json();
}

/**
 * Parse user email from ID token
 * @param {string} idToken
 * @returns {string|null}
 */
function parseEmailFromIdToken(idToken) {
  try {
    // ID token is JWT: header.payload.signature
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.email || null;
  } catch {
    return null;
  }
}

/**
 * Open URL in browser
 * @param {string} url
 */
function openBrowser(url) {
  const platform = process.platform;
  const command =
    platform === 'win32' ? `start "" "${url}"` :
    platform === 'darwin' ? `open "${url}"` :
    `xdg-open "${url}"`;

  exec(command, (err) => {
    if (err) {
      logger.warn('Could not auto-open browser');
    }
  });
}

/**
 * Run OpenAI Codex OAuth flow
 * @param {{isRemote: boolean}} options
 * @returns {Promise<Object>} OAuth credentials
 */
export async function runOAuthFlow(options = {}) {
  const isRemote = options.isRemote || false;

  // Generate PKCE and state
  const { verifier, challenge } = generatePKCE();
  const state = generateState();

  // Build authorization URL
  const authUrl = buildAuthorizationUrl({ challenge, state });

  logger.info('');
  logger.info('◇  OAuth URL ready\n');
  logger.info('Open this URL in your ' + (isRemote ? 'LOCAL ' : '') + 'browser:\n');
  console.log(authUrl);
  logger.info('');

  // Start callback server
  const callbackPromise = startCallbackServer(state);

  // Auto-open browser if not remote
  if (!isRemote) {
    setTimeout(() => openBrowser(authUrl), 1000);
  }

  // Wait for callback
  logger.info('Waiting for authorization...');
  const code = await callbackPromise;

  logger.info('✓ Authorization received, exchanging for tokens...');

  // Exchange code for tokens
  const tokens = await exchangeCodeForTokens({ code, verifier });

  // Parse email from ID token
  const email = tokens.id_token ? parseEmailFromIdToken(tokens.id_token) : null;

  // Calculate expiry time
  const expiresAt = tokens.expires_in
    ? Date.now() + tokens.expires_in * 1000
    : null;

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt,
    email: email || 'unknown',
  };
}

/**
 * Refresh OAuth tokens
 * @param {string} refreshToken
 * @returns {Promise<Object>}
 */
export async function refreshTokens(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });

  const response = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${response.status} - ${error}`);
  }

  const tokens = await response.json();

  const expiresAt = tokens.expires_in
    ? Date.now() + tokens.expires_in * 1000
    : null;

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || refreshToken,  // Reuse old if not provided
    expiresAt,
  };
}

export default { runOAuthFlow, refreshTokens };
