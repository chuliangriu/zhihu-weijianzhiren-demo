export async function supabaseRequest(path, options = {}) {
  const baseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) throw new Error('缺少 Supabase 环境变量');

  const headers = {
    apikey: serviceKey,
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (!serviceKey.startsWith('sb_secret_')) headers.Authorization = `Bearer ${serviceKey}`;

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { ok: response.ok, status: response.status, data };
}
