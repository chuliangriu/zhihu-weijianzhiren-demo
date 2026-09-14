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

  // 当前先完成 OAuth 烟雾测试，不把 access_token 放进浏览器 URL。
  // 后续接入 Supabase 时，应在这里将 token 加密保存到数据库。
  const successUrl = new URL('/?zhihu=authorized', siteUrl);
  return Response.redirect(successUrl.toString(), 302);
}

export const config = { path: '/.netlify/functions/zhihu-callback' };
