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
  if (!code) {
    return new Response('知乎没有返回 authorization_code', { status: 400 });
  }

  const body = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  });

  const tokenResponse = await fetch('https://openapi.zhihu.com/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const tokenData = await tokenResponse.json().catch(() => ({}));

  if (!tokenResponse.ok || !tokenData.access_token) {
    console.error('知乎 token 交换失败', tokenResponse.status, tokenData);
    return new Response('知乎授权失败，请查看 Netlify Function 日志', { status: 502 });
  }

  const userInfo = await fetchZhihuUserInfo(tokenData.access_token, tokenData.token_type || 'Bearer');
  if (userInfo) {
    try {
      await saveToSupabase(userInfo, tokenData);
    } catch (error) {
      console.error('Supabase 写入异常', error);
    }
  }

  const successUrl = new URL('/?zhihu=authorized', siteUrl);
  return Response.redirect(successUrl.toString(), 302);
}

async function fetchZhihuUserInfo(accessToken, tokenType) {
  const response = await fetch('https://openapi.zhihu.com/user', {
    headers: { Authorization: `${tokenType} ${accessToken}` },
  });
  if (!response.ok) {
    console.error('知乎用户信息获取失败', response.status);
    return null;
  }
  return response.json().catch(() => null);
}

async function saveToSupabase(userInfo, tokenData) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY');
    return;
  }

  const user = userInfo.data || userInfo;
  const zhihuUserId = String(user.id || user.user_id || user.uid || '').trim();
  if (!zhihuUserId) {
    console.error('知乎用户信息中没有用户 ID');
    return;
  }

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
  const base = supabaseUrl.replace(/\/$/, '') + '/rest/v1';
  const userResponse = await fetch(`${base}/users?on_conflict=zhihu_user_id`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      zhihu_user_id: zhihuUserId,
      display_name: user.name || user.display_name || null,
      avatar_url: user.avatar_url || user.avatar || null,
      profile_url: user.url || user.profile_url || null,
      updated_at: new Date().toISOString(),
    }),
  });
  const savedUsers = await userResponse.json().catch(() => []);
  if (!userResponse.ok || !Array.isArray(savedUsers) || !savedUsers[0]?.id) {
    console.error('Supabase 用户写入失败', userResponse.status, savedUsers);
    return;
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
  if (!accountResponse.ok) {
    console.error('Supabase 知乎账号写入失败', accountResponse.status, await accountResponse.text());
  }
}

export const config = { path: '/.netlify/functions/zhihu-callback' };
