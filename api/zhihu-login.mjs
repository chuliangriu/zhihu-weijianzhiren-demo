export default function handler(request, response) {
  if (request.method !== 'GET') {
    return response.status(405).send('Method Not Allowed');
  }

  const appId = process.env.ZHIHU_APP_ID;
  const redirectUri = process.env.ZHIHU_REDIRECT_URI;
  if (!appId || !redirectUri) {
    return response.status(500).send('缺少 ZHIHU_APP_ID 或 ZHIHU_REDIRECT_URI 环境变量');
  }

  const authorizeUrl = new URL('https://openapi.zhihu.com/authorize');
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('app_id', appId);
  authorizeUrl.searchParams.set('response_type', 'code');

  return response.redirect(302, authorizeUrl.toString());
}
