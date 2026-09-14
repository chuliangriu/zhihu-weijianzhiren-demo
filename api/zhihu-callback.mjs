import { createHash } from 'node:crypto';

export default async function handler(request, response) {
  if (request.method !== 'GET') return response.status(405).send('Method Not Allowed');

  const appId = process.env.ZHIHU_APP_ID;
  const appKey = process.env.ZHIHU_APP_KEY;
  const redirectUri = process.env.ZHIHU_REDIRECT_URI;
  const siteUrl = getSiteUrl(request);
  if (!appId || !appKey || !redirectUri) return response.status(500).send('缺少知乎环境变量');

  const code = firstString(request.query.authorization_code) || firstString(request.query.code);
  if (!code) return response.status(400).send('知乎没有返回 authorization_code');

  const tokenResponse = await fetch('https://openapi.zhihu.com/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      app_id: appId,
      app_key: appKey,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    }),
  });
  const tokenData = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenData.access_token) {
    return response.status(502).send('知乎授权失败，请查看 Vercel Function 日志');
  }

  const userResponse = await fetch('https://openapi.zhihu.com/user', {
    headers: { Authorization: `${tokenData.token_type || 'Bearer'} ${tokenData.access_token}` },
  });
  const userInfo = await userResponse.json().catch(() => null);
  if (!userResponse.ok || !userInfo) {
    return response.status(502).send(`知乎授权成功，但未能读取用户资料（HTTP ${userResponse.status}）`);
  }

  const apiCode = Number(userInfo.code ?? userInfo.Code);
  if (Number.isFinite(apiCode) && apiCode !== 0 && apiCode !== 20004) {
    return response.status(502).send(`知乎用户资料接口返回业务错误（code ${apiCode}）`);
  }

  const profileUnavailable = apiCode === 20004;
  const rawUser = profileUnavailable
    ? {}
    : userInfo.data || userInfo.Data || userInfo.user || userInfo.User || userInfo;
  const user = normalizeZhihuUser(rawUser);
  let zhihuUserId = String(
    user.id || user.user_id || user.userId || user.uid || user.url_token || user.urlToken || ''
  ).trim();
  if (profileUnavailable) {
    zhihuUserId = `oauth_${createHash('sha256').update(tokenData.access_token).digest('hex')}`;
    user.name = '知乎授权用户';
  }
  if (!zhihuUserId) return response.status(502).send('知乎返回的用户资料没有用户 ID');

  const saved = await saveToSupabase(user, zhihuUserId, tokenData);
  if (!saved.ok) {
    return response.status(502).send(`知乎授权成功，但未能保存到 Supabase：${saved.error}`);
  }

  const successUrl = new URL('/?zhihu=authorized&database=saved', siteUrl);
  successUrl.searchParams.set('supabase_project', new URL(process.env.SUPABASE_URL).hostname.split('.')[0]);
  return response.redirect(302, successUrl.toString());
}

function getSiteUrl(request) {
  if (process.env.SITE_URL) return process.env.SITE_URL;
  const protocol = firstString(request.headers['x-forwarded-proto']) || 'https';
  return `${protocol}://${request.headers.host}`;
}

function firstString(value) {
  return Array.isArray(value) ? value[0] : typeof value === 'string' ? value : '';
}

function normalizeZhihuUser(rawUser) {
  if (typeof rawUser !== 'string') return rawUser;
  try {
    const parsed = JSON.parse(rawUser);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return { id: rawUser };
}

async function saveToSupabase(user, zhihuUserId, tokenData) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return { ok: false, error: 'Vercel 中缺少 Supabase 环境变量' };
  }

  const headers = { apikey: serviceKey, 'Content-Type': 'application/json' };
  if (!serviceKey.startsWith('sb_secret_')) headers.Authorization = `Bearer ${serviceKey}`;
  const base = `${supabaseUrl.replace(/\/$/, '')}/rest/v1`;

  const userResponse = await fetch(`${base}/users?on_conflict=zhihu_user_id`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      zhihu_user_id: zhihuUserId,
      display_name: user.name || user.display_name || user.nickname || null,
      avatar_url: user.avatar_url || user.avatarUrl || user.avatar || null,
      profile_url:
        user.url || user.profile_url ||
        (user.url_token || user.urlToken ? `https://www.zhihu.com/people/${user.url_token || user.urlToken}` : null),
      updated_at: new Date().toISOString(),
    }),
  });
  const savedUsers = await userResponse.json().catch(() => []);
  if (!userResponse.ok || !Array.isArray(savedUsers) || !savedUsers[0]?.id) {
    return { ok: false, error: `users 表写入失败（HTTP ${userResponse.status}）` };
  }

  const accountResponse = await fetch(`${base}/zhihu_accounts?on_conflict=user_id`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      user_id: savedUsers[0].id,
      access_token: tokenData.access_token,
      token_type: tokenData.token_type || 'Bearer',
      expires_at: tokenData.expires_in
        ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
        : null,
      updated_at: new Date().toISOString(),
    }),
  });
  return accountResponse.ok
    ? { ok: true }
    : { ok: false, error: `zhihu_accounts 表写入失败（HTTP ${accountResponse.status}）` };
}
