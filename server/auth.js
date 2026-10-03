/**
 * Authentication, and the check that makes it optional.
 *
 * The API has no login, which is the right call for a desktop app bound to
 * loopback: a process on the same machine can already read the download
 * directory, so an unauthenticated loopback API hands an attacker nothing they did
 * not already have.
 *
 * The danger is the transition. Setting BITRATE_HOST=0.0.0.0 turns a local app
 * into a network service with full read/write control over the download
 * directory, and nothing forces anyone to notice. So rather than trusting the
 * README to say "put authentication in front of this first", a non-loopback bind
 * without a token is a startup error. The insecure configuration is not
 * reachable; it has to be asked for by name.
 */
import crypto from 'node:crypto';
import net from 'node:net';
import { AUTH_TOKEN } from './config.js';

export class AuthError extends Error {
  constructor(message = 'Authentication required.') {
    super(message);
    this.name = 'AuthError';
    this.statusCode = 401;
  }
}

const stripBrackets = (h) => String(h || '').replace(/^\[/, '').replace(/\]$/, '');

/**
 * Does this bind address accept connections from other machines?
 *
 * 0.0.0.0 and :: bind every interface, which is the case that matters, so they
 * are explicitly *not* loopback. Treating them as local is the exact mistake this
 * module exists to prevent.
 */
export function isLoopbackBind(host) {
  const h = stripBrackets(host).toLowerCase();
  if (!h || h === '0.0.0.0' || h === '::' || h === '0:0:0:0:0:0:0:0') return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (net.isIP(h) === 4) return h.startsWith('127.');
  if (net.isIP(h) === 6) {
    const groups = h.split(':').filter(Boolean);
    // ::1
    if (groups.length === 1 && Number.parseInt(groups[0], 16) === 1) return true;
    return false;
  }
  return false;
}

/**
 * Refuse to start on a non-loopback bind with no token.
 *
 * Throws rather than warns. A warning is a line in a log that nobody reads, and
 * the consequence is a machine on the network that can be told to fetch any URL
 * it likes and to delete any file it can name.
 */
export function assertBindingIsSafe(host) {
  if (isLoopbackBind(host)) return { required: false, reason: 'loopback bind' };
  if (AUTH_TOKEN) return { required: true, reason: 'remote bind with a token configured' };
  throw new Error(
    `Refusing to bind ${host}: that is reachable from the network and this API has no `
    + 'authentication. Set BITRATE_AUTH_TOKEN to a long random string, or bind to '
    + '127.0.0.1 to keep it local.\n'
    + 'The API can start any download and delete any file in the download directory, '
    + 'so exposing it unauthenticated is not a configuration this will allow.',
  );
}

/** Length-independent comparison, so a token cannot be recovered a byte at a time. */
function tokensMatch(presented) {
  if (!presented || !AUTH_TOKEN) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(AUTH_TOKEN);
  // timingSafeEqual throws on a length mismatch, which is itself a leak, so the
  // lengths are compared first and the constant-time compare only runs when they
  // could plausibly match.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function presentedToken(req) {
  const auth = req.headers?.authorization;
  if (auth && /^bearer /i.test(auth)) return auth.slice(7).trim();
  const custom = req.headers?.['x-bitrate-token'];
  if (custom) return String(custom).trim();
  return null;
}

/**
 * Require the token when one is configured.
 *
 * A no-op on a tokenless install, which is the default. EventSource and media
 * elements cannot set headers, so the query string is accepted too; that is only
 * safe over loopback or behind TLS, which is why the remote-bind check exists.
 */
export function authenticate(req) {
  if (!AUTH_TOKEN) return { required: false };
  if (tokensMatch(presentedToken(req))) return { required: true, ok: true };
  // `access_token` rather than `token`, so a media URL that gets copied out of
  // the app and pasted somewhere else does not carry a credential by accident.
  const query = req.query?.access_token;
  if (typeof query === 'string' && tokensMatch(query)) return { required: true, ok: true };
  throw new AuthError();
}

export const authRequired = () => Boolean(AUTH_TOKEN);

/** Never reveal the token, not even to a loopback caller that authenticated. */
export const authStatus = () => ({
  required: authRequired(),
  bound: AUTH_TOKEN ? 'remote' : 'local',
});