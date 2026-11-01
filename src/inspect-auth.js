import {safePublicUrl} from './utils.js';

// Turnstile authorizes a short browsing session for one publisher/source URL.
// No browsing-session records or user identifiers are saved to server storage.
export const INSPECT_SESSION_MS = 60 * 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(bytes) {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeBase64url(input) {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]+$/.test(input)) throw new Error('Malformed ticket');
  const value = input.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(value.padEnd(Math.ceil(value.length / 4) * 4, '=')), item => item.charCodeAt(0));
}
async function signingKey(secret) {
  if (typeof secret !== 'string' || secret.length < 12) throw new Error('Turnstile signing key not configured');
  return crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign','verify']);
}
async function sourceDigest(sourceUrl) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(safePublicUrl(sourceUrl)));
  return base64url(new Uint8Array(hash));
}
function normalizedHostname(url) {
  return new URL(safePublicUrl(url)).hostname.toLowerCase().replace(/^www\./, '');
}
async function clientBinding(key, request) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const agent = request.headers.get('User-Agent') || '';
  const input = encoder.encode('journalist-inspect-client-v1|' + ip + '|' + agent);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, input))).slice(0, 32);
}

export async function issueInspectTicket(secret, request, sourceUrl, now = Date.now()) {
  const source = safePublicUrl(sourceUrl);
  const key = await signingKey(secret);
  const payload = {
    v:1,
    purpose:'inspect',
    expires:now + INSPECT_SESSION_MS,
    origin:new URL(request.url).origin,
    client:await clientBinding(key, request),
    host:normalizedHostname(source),
    source:await sourceDigest(source)
  };
  const encoded = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = base64url(new Uint8Array(await crypto.subtle.sign('HMAC',key,
    encoder.encode('journalist-inspect-v1|' + encoded))));
  return {accessTicket:encoded+'.'+signature, expiresAt:new Date(payload.expires).toISOString()};
}

/**
 * 'inspect' permits re-reading the original author/article URL with pagination.
 * 'article' permits extraction only from the same publisher as that source.
 */
export async function validateInspectTicket(secret, request, ticket, requestedUrl, operation, now = Date.now()) {
  if (typeof ticket !== 'string' || ticket.length > 3000 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket) ||
      !['inspect','article'].includes(operation)) return false;
  try {
    const [encoded, signature] = ticket.split('.');
    const key = await signingKey(secret);
    const authentic = await crypto.subtle.verify('HMAC',key,decodeBase64url(signature),
      encoder.encode('journalist-inspect-v1|' + encoded));
    if (!authentic) return false;
    const payload = JSON.parse(decoder.decode(decodeBase64url(encoded)));
    if (payload?.v !== 1 || payload.purpose !== 'inspect' ||
        !Number.isFinite(payload.expires) || payload.expires <= now ||
        payload.expires > now + INSPECT_SESSION_MS ||
        payload.origin !== new URL(request.url).origin ||
        payload.client !== await clientBinding(key,request) ||
        typeof payload.host !== 'string' || typeof payload.source !== 'string') return false;
    const target = safePublicUrl(requestedUrl);
    if (normalizedHostname(target) !== payload.host) return false;
    if (operation === 'inspect') return payload.source === await sourceDigest(target);
    return true;
  } catch {
    return false;
  }
}
