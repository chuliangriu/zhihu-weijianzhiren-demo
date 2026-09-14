import { requireUser } from '../server/auth.mjs';
import { supabaseRequest } from '../server/supabase.mjs';

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') {
    return response.status(405).json({ success: false, error: 'METHOD_NOT_ALLOWED' });
  }

  const auth = await requireUser(request);
  if (!auth) return response.status(401).json({ success: false, error: 'NOT_LOGGED_IN' });

  const queryText = typeof request.body?.queryText === 'string'
    ? request.body.queryText.trim().slice(0, 2000)
    : '';
  const consents = await supabaseRequest(
    `expression_consents?owner_id=neq.${encodeURIComponent(auth.user.id)}&matching_allowed=eq.true&excerpt_allowed=eq.true&revoked_at=is.null&select=expression_id,owner_id,contact_allowed,identity_disclosure,discoverable_until&limit=50`
  );
  if (!consents.ok || !Array.isArray(consents.data)) {
    return response.status(502).json({ success: false, error: 'CANDIDATE_LOOKUP_FAILED' });
  }

  const now = Date.now();
  const active = shuffle(consents.data.filter(item => {
    if (!item.discoverable_until) return true;
    const expiry = Date.parse(item.discoverable_until);
    return Number.isFinite(expiry) && expiry > now;
  }));

  let consent = null;
  let expression = null;
  for (const candidate of active) {
    const result = await supabaseRequest(
      `expressions?id=eq.${encodeURIComponent(candidate.expression_id)}&owner_id=eq.${encodeURIComponent(candidate.owner_id)}&deleted_at=is.null&select=id,content,context_summary&limit=1`
    );
    if (result.ok && Array.isArray(result.data) && result.data[0]) {
      consent = candidate;
      expression = result.data[0];
      break;
    }
  }

  if (!consent || !expression) {
    return response.status(200).json({ success: true, data: null });
  }

  let identityLabel = '匿名用户';
  if (consent.identity_disclosure !== 'anonymous') {
    const owners = await supabaseRequest(
      `users?id=eq.${encodeURIComponent(consent.owner_id)}&select=display_name&limit=1`
    );
    identityLabel = owners.data?.[0]?.display_name || '知乎授权用户';
  }

  const excerpt = limitedText(expression.content, 320);
  const context = limitedText(expression.context_summary, 500) || null;
  const inserted = await supabaseRequest('discovery_results', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: {
      viewer_id: auth.user.id,
      source_expression_id: expression.id,
      source_owner_id: consent.owner_id,
      query_text: queryText || null,
      excerpt_snapshot: excerpt,
      context_snapshot: context,
      identity_label: identityLabel,
      contact_allowed: consent.contact_allowed,
      relation_summary: '这条表达可能与你正在关心的事情有关。',
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
  });
  const result = inserted.data?.[0];
  if (!inserted.ok || !result) {
    return response.status(502).json({ success: false, error: 'DISCOVERY_CREATE_FAILED' });
  }

  await supabaseRequest('audit_events', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: {
      actor_user_id: auth.user.id,
      event_type: 'discovery_created',
      resource_type: 'discovery_result',
      resource_id: result.id,
    },
  });

  return response.status(200).json({
    success: true,
    data: {
      id: result.id,
      quote: result.excerpt_snapshot,
      context: result.context_snapshot,
      identity: result.identity_label,
      contactAllowed: result.contact_allowed,
      relation: result.relation_summary,
      expiresAt: result.expires_at,
    },
  });
}

function limitedText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}
