import { createHash } from 'node:crypto';
import {
  OAUTH_STATE_COOKIE,
  clearCookie,
  createSession,
  readCookie,
} from '../server/auth.mjs';
import { supabaseRequest } from '../server/supabase.mjs';
import { encryptToken } from '../server/token-crypto.mjs';

export default async function handler(request, response) {
  if (request.method !== 'GET') return response.status(405).send('Method Not Allowed');

  const expectedState = readCookie(request, OAUTH_STATE_COOKIE);
  const receivedState = firstString(request.query.state);
  if (!expectedState || !receivedState || expectedState !== receivedState) {
    return response.status(400).send('知乎登录 state 校验失败，请从登录按钮重新开始');
  }
  clearCookie(response, OAUTH_STATE_COOKIE);

  const appId = process.env.ZHIHU_APP_ID;
  const appKey = process.env.ZHIHU_APP_KEY;
  const redirectUri = process.env.ZHIHU_REDIRECT_URI;
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

  const identity = await resolveZhihuIdentity(tokenData);
  const savedUser = await saveUserAndAccount(identity, tokenData);
  if (!savedUser.ok) {
    return response.status(502).send(`知乎授权成功，但保存登录信息失败：${savedUser.error}`);
  }

  try {
    await createSession(savedUser.userId, response);
  } catch (error) {
    return response.status(502).send(error instanceof Error ? error.message : '创建登录会话失败');
  }

  await supabaseRequest('audit_events', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: { actor_user_id: savedUser.userId, event_type: 'oauth_login', resource_type: 'user' },
  });

  return response.redirect(302, new URL('/?login=success', getSiteUrl(request)).toString());
}

async function resolveZhihuIdentity(tokenData) {
  const tokenIdentity = tokenData.open_id || tokenData.openid || tokenData.user_id || tokenData.uid || tokenData.sub;
  if (tokenIdentity) {
    return { externalId: String(tokenIdentity), name: '知乎授权用户', avatarUrl: null, profileUrl: null };
  }

  const userResponse = await fetch('https://openapi.zhihu.com/user', {
    headers: { Authorization: `${tokenData.token_type || 'Bearer'} ${tokenData.access_token}` },
  });
  const userInfo = await userResponse.json().catch(() => null);
  const apiCode = Number(userInfo?.code ?? userInfo?.Code);
  if (userResponse.ok && userInfo && (!Number.isFinite(apiCode) || apiCode === 0)) {
    const raw = userInfo.data || userInfo.Data || userInfo.user || userInfo.User || userInfo;
    const user = normalizeUser(raw);
    const externalId = user.id || user.user_id || user.userId || user.uid || user.url_token || user.urlToken;
    if (externalId) {
      return {
        externalId: String(externalId),
        name: user.name || user.display_name || user.nickname || '知乎授权用户',
        avatarUrl: user.avatar_url || user.avatarUrl || user.avatar || null,
        profileUrl: user.url || user.profile_url || null,
      };
    }
  }

  // 当前应用收到 code 20004 时无法取得真实资料，只能使用不可逆 Token 哈希作为 Demo 身份。
  return {
    externalId: `oauth_${createHash('sha256').update(tokenData.access_token).digest('hex')}`,
    name: '知乎授权用户',
    avatarUrl: null,
    profileUrl: null,
  };
}

async function saveUserAndAccount(identity, tokenData) {
  const userResponse = await supabaseRequest('users?on_conflict=zhihu_user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: {
      zhihu_user_id: identity.externalId,
      display_name: identity.name,
      avatar_url: identity.avatarUrl,
      profile_url: identity.profileUrl,
      updated_at: new Date().toISOString(),
    },
  });
  if (!userResponse.ok || !Array.isArray(userResponse.data) || !userResponse.data[0]?.id) {
    return { ok: false, error: `users 表写入失败（HTTP ${userResponse.status}）` };
  }

  const userId = userResponse.data[0].id;
  const accountResponse = await supabaseRequest('zhihu_accounts?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: {
      user_id: userId,
      access_token: encryptToken(tokenData.access_token),
      token_type: tokenData.token_type || 'Bearer',
      expires_at: tokenData.expires_in
        ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
        : null,
      token_storage_version: 'encrypted_v1',
      updated_at: new Date().toISOString(),
    },
  });
  return accountResponse.ok
    ? { ok: true, userId }
    : { ok: false, error: `zhihu_accounts 表写入失败（HTTP ${accountResponse.status}）` };
}

function normalizeUser(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return { id: raw };
}

function firstString(value) {
  return Array.isArray(value) ? value[0] : typeof value === 'string' ? value : '';
}

function getSiteUrl(request) {
  if (process.env.SITE_URL) return process.env.SITE_URL;
  return `${firstString(request.headers['x-forwarded-proto']) || 'https'}://${request.headers.host}`;
}
