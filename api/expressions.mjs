import { requireUser } from '../server/auth.mjs';
import { supabaseRequest } from '../server/supabase.mjs';

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  const auth = await requireUser(request);
  if (!auth) return response.status(401).json({ success: false, error: 'NOT_LOGGED_IN' });

  if (request.method === 'GET') return listExpressions(auth.user.id, response);
  if (request.method === 'POST') return createExpression(auth.user.id, request, response);
  if (request.method === 'PATCH') return updateExpression(auth.user.id, request, response);
  if (request.method === 'DELETE') return deleteExpression(auth.user.id, request, response);
  return response.status(405).json({ success: false, error: 'METHOD_NOT_ALLOWED' });
}

async function listExpressions(userId, response) {
  const owner = encodeURIComponent(userId);
  const expressions = await supabaseRequest(
    `expressions?owner_id=eq.${owner}&deleted_at=is.null&select=id,content,context_summary,source_type,source_url,created_at,updated_at&order=created_at.desc`
  );
  if (!expressions.ok || !Array.isArray(expressions.data)) {
    return response.status(502).json({ success: false, error: 'EXPRESSIONS_LOOKUP_FAILED' });
  }

  const consents = await supabaseRequest(
    `expression_consents?owner_id=eq.${owner}&select=expression_id,matching_allowed,excerpt_allowed,contact_allowed,identity_disclosure,discoverable_until,consented_at,revoked_at`
  );
  if (!consents.ok || !Array.isArray(consents.data)) {
    return response.status(502).json({ success: false, error: 'CONSENTS_LOOKUP_FAILED' });
  }

  const consentByExpression = new Map(consents.data.map(item => [item.expression_id, item]));
  const data = expressions.data.map(item => ({
    ...item,
    consent: consentByExpression.get(item.id) || null,
  }));
  return response.status(200).json({ success: true, data });
}

async function createExpression(userId, request, response) {
  const parsed = readExpressionInput(request.body);
  if (!parsed.ok) return response.status(400).json({ success: false, error: parsed.error });

  const result = await supabaseRequest('expressions', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: {
      owner_id: userId,
      content: parsed.content,
      context_summary: parsed.contextSummary,
      source_type: 'private_authorized',
    },
  });
  if (!result.ok || !Array.isArray(result.data) || !result.data[0]) {
    return response.status(502).json({ success: false, error: 'EXPRESSION_CREATE_FAILED' });
  }
  return response.status(201).json({ success: true, data: result.data[0] });
}

async function updateExpression(userId, request, response) {
  const expressionId = readId(request.body?.expressionId);
  if (!expressionId) return response.status(400).json({ success: false, error: 'INVALID_EXPRESSION_ID' });
  const parsed = readExpressionInput(request.body);
  if (!parsed.ok) return response.status(400).json({ success: false, error: parsed.error });

  const result = await supabaseRequest(
    `expressions?id=eq.${encodeURIComponent(expressionId)}&owner_id=eq.${encodeURIComponent(userId)}&deleted_at=is.null`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: {
        content: parsed.content,
        context_summary: parsed.contextSummary,
        updated_at: new Date().toISOString(),
      },
    }
  );
  if (!result.ok) return response.status(502).json({ success: false, error: 'EXPRESSION_UPDATE_FAILED' });
  if (!Array.isArray(result.data) || !result.data[0]) {
    return response.status(404).json({ success: false, error: 'EXPRESSION_NOT_FOUND' });
  }
  return response.status(200).json({ success: true, data: result.data[0] });
}

async function deleteExpression(userId, request, response) {
  const expressionId = readId(request.body?.expressionId || request.query?.expressionId);
  if (!expressionId) return response.status(400).json({ success: false, error: 'INVALID_EXPRESSION_ID' });

  const now = new Date().toISOString();
  const result = await supabaseRequest(
    `expressions?id=eq.${encodeURIComponent(expressionId)}&owner_id=eq.${encodeURIComponent(userId)}&deleted_at=is.null`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: { deleted_at: now, updated_at: now },
    }
  );
  if (!result.ok) return response.status(502).json({ success: false, error: 'EXPRESSION_DELETE_FAILED' });
  if (!Array.isArray(result.data) || !result.data[0]) {
    return response.status(404).json({ success: false, error: 'EXPRESSION_NOT_FOUND' });
  }

  await supabaseRequest(
    `expression_consents?expression_id=eq.${encodeURIComponent(expressionId)}&owner_id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: {
        matching_allowed: false,
        excerpt_allowed: false,
        contact_allowed: false,
        revoked_at: now,
        updated_at: now,
      },
    }
  );
  return response.status(200).json({ success: true });
}

function readExpressionInput(body) {
  const content = typeof body?.content === 'string' ? body.content.trim() : '';
  const contextSummary = typeof body?.contextSummary === 'string'
    ? body.contextSummary.trim()
    : '';
  if (!content || content.length > 10000) return { ok: false, error: 'INVALID_CONTENT' };
  if (contextSummary.length > 1000) return { ok: false, error: 'INVALID_CONTEXT' };
  return { ok: true, content, contextSummary: contextSummary || null };
}

function readId(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : '';
}
