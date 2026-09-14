export default async function handler(request) {
  const appId = process.env.ZHIHU_APP_ID;
  const appKey = process.env.ZHIHU_APP_KEY;
  const redirectUri = process.env.ZHIHU_REDIRECT_URI;
  const siteUrl = process.env.URL || new URL(request.url).origin;

  if (!appId || !appKey || !redirectUri) {
    return new Response('缺少知乎环境变量', { status: 500 });
  }

  const callbackUrl = new URL(request.url);
  const code = callbackUrl.searchParams.get('authorization_code') || callbackUrl.searchParams.get('code');
  if (!code) return new Response('知乎没有返回 authorization_code', { status: 400 });

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
    return new Response('知乎授权失败，请查看 Netlify Function 日志', { status: 502 });
  }

  const userResponse = await fetch('https://openapi.zhihu.com/user', {
    headers: { Authorization: `${tokenData.token_type || 'Bearer'} ${tokenData.access_token}` },
  });
  const userInfo = await userResponse.json().catch(() => null);
  if (!userResponse.ok || !userInfo) {
    return new Response(`知乎授权成功，但未能读取用户资料（HTTP ${userResponse.status}）`, { status: 502 });
  }

  const apiCode = Number(userInfo.code ?? userInfo.Code);
  if (Number.isFinite(apiCode) && apiCode !== 0 && apiCode !== 20004) {
    return new Response(`知乎用户资料接口返回业务错误（code ${apiCode}）`, { status: 502 });
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
    zhihuUserId = await deriveInternalUserId(tokenData.access_token);
    user.name = '知乎授权用户';
  }
  if (!zhihuUserId) {
    const topKeys = Object.keys(userInfo).join(', ') || '无';
    const userKeys = Object.keys(user).join(', ') || '无';
    return new Response(
      `知乎返回的用户资料没有用户 ID。顶层字段：${topKeys}；资料字段：${userKeys}`,
      { status: 502 }
    );
  }

  const saved = await saveToSupabase(user, zhihuUserId, tokenData);
  if (!saved.ok) {
    return new Response(`知乎授权成功，但未能保存到 Supabase：${saved.error}`, { status: 502 });
  }

  const successUrl = new URL('/?zhihu=authorized&database=saved', siteUrl);
  successUrl.searchParams.set(
    'supabase_project',
    new URL(process.env.SUPABASE_URL).hostname.split('.')[0]
  );
  return Response.redirect(successUrl.toString(), 302);
}

async function saveToSupabase(user, zhihuUserId, tokenData) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return { ok: false, error: 'Netlify 中缺少 Supabase 环境变量' };
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

export const config = { path: '/.netlify/functions/zhihu-callback' };

function normalizeZhihuUser(rawUser) {
  if (typeof rawUser !== 'string') return rawUser;

  try {
    const parsed = JSON.parse(rawUser);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // 知乎当前接口可能直接返回稳定的用户标识字符串。
  }

  return { id: rawUser };
}

async function deriveInternalUserId(accessToken) {
  const bytes = new TextEncoder().encode(accessToken);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `oauth_${hex}`;
}
