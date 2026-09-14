import { SESSION_COOKIE, clearCookie, revokeSession } from '../server/auth.mjs';

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ success: false });
  await revokeSession(request);
  clearCookie(response, SESSION_COOKIE);
  return response.status(200).json({ success: true });
}
