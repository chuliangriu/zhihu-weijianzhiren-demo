export default async function handler() {
  const appId = process.env.ZHIHU_APP_ID;
  const redirectUri = process.env.ZHIHU_REDIRECT_URI;

  if (!appId || !redirectUri) {
    return new Response('缺少 ZHIHU_APP_ID 或 ZHIHU_REDIRECT_URI 环境变量', { status: 500 });
  }

  const authorizeUrl = new URL('https://openapi.zhihu.com/authorize');
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('app_id', appId);
  authorizeUrl.searchParams.set('response_type', 'code');

  return Response.redirect(authorizeUrl.toString(), 302);
}

export const config = { path: '/.netlify/functions/zhihu-login' };
