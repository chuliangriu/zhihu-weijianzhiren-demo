return new Response(`知乎授权成功，但未能保存到 Supabase：${saved.error}`, { status: 502 });
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
    return { ok: false, error: `知乎用户信息接口返回 HTTP ${response.status}` };
  }
  const data = await response.json().catch(() => null);
  if (!data) return { ok: false, error: '知乎用户信息接口没有返回 JSON' };
  return { ok: true, data };
}

async function saveToSupabase(userInfo, tokenData) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY');
    return { ok: false, error: 'Netlify 中缺少 Supabase 环境变量' };
  }

  const user = userInfo.data || userInfo;
  const zhihuUserId = String(user.id || user.user_id || user.uid || '').trim();
  if (!zhihuUserId) {
    console.error('知乎用户信息中没有用户 ID');
    return { ok: false, error: '知乎返回的用户资料没有用户 ID' };
  }

  const headers = {
    apikey: serviceKey,
    'Content-Type': 'application/json',
  };
  // 新版 sb_secret_ 密钥通过 apikey 传递；旧版 service_role JWT 还需要 Bearer。
  if (!serviceKey.startsWith('sb_secret_')) headers.Authorization = `Bearer ${serviceKey}`;
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
  if (!accountResponse.ok) {
    console.error('Supabase 知乎账号写入失败', accountResponse.status, await accountResponse.text());
    return { ok: false, error: `zhihu_accounts 表写入失败（HTTP ${accountResponse.status}）` };
  }
  return { ok: true };
}

export const config = { path: '/.netlify/functions/zhihu-callback' };
