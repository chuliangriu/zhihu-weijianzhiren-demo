import { requireUser } from '../server/auth.mjs';
import { supabaseRequest } from '../server/supabase.mjs';

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') {
    return response.status(405).json({ success: false, error: 'METHOD_NOT_ALLOWED' });
  }

  const auth = await requireUser(request);
  if (!auth) return response.status(401).json({ success: false, error: 'NOT_LOGGED_IN' });

  const expressionId = readId(request.body?.expressionId);
  if (!expressionId) {
    return response.status(400).json({ success: false, error: 'INVALID_EXPRESSION_ID' });
  }

  const owned = await supabaseRequest(
    `expressions?id=eq.${encodeURIComponent(expressionId)}&owner_id=eq.${encodeURIComponent(auth.user.id)}&deleted_at=is.null&select=id&limit=1`
  );
  if (!owned.ok || !Array.isArray(owned.data) || !owned.data[0]) {
    return response.status(404).json({ success: false, error: 'EXPRESSION_NOT_FOUND' });
  }

  const allowedIdentity = new Set(['anonymous', 'nickname', 'full']);
  const identityDisclosure = allowedIdentity.has(request.body?.identityDisclosure)
    ? request.body.identityDisclosure
    : 'anonymous';
  const matchingAllowed = request.body?.matchingAllowed === true;
  const excerptAllowed = request.body?.excerptAllowed === true;
  const active = matchingAllowed && excerptAllowed;
  const discoverableUntil = readFutureDate(request.body?.discoverableUntil);
  if (request.body?.discoverableUntil && !discoverableUntil) {
    return response.status(400).json({ success: false, error: 'INVALID_DISCOVERABLE_UNTIL' });
  }

  const now = new Date().toISOString();
  const result = await supabaseRequest('expression_consents?on_conflict=expression_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: {
      expression_id: expressionId,
      owner_id: auth.user.id,
      matching_allowed: active,
      excerpt_allowed: active,
      contact_allowed: active && request.body?.contactAllowed === true,
      identity_disclosure: identityDisclosure,
      discoverable_until: active ? discoverableUntil : null,
      consented_at: active ? now : null,
      revoked_at: active ? null : now,
      updated_at: now,
    },
  });
  if (!result.ok || !Array.isArray(result.data) || !result.data[0]) {
    return response.status(502).json({ success: false, error: 'CONSENT_SAVE_FAILED' });
  }

  await supabaseRequest('audit_events', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: {
      actor_user_id: auth.user.id,
      event_type: active ? 'expression_consent_granted' : 'expression_consent_revoked',
      resource_type: 'expression',
      resource_id: expressionId,
    },
  });
  return response.status(200).json({ success: true, data: result.data[0] });
}

function readId(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : '';
}

function readFutureDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return '';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) return '';
  return new Date(timestamp).toISOString();
}
