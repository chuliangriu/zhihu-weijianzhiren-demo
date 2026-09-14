import { requireUser } from '../server/auth.mjs';

export default async function handler(request, response) {
  if (request.method !== 'GET') return response.status(405).json({ success: false });
  const auth = await requireUser(request);
  if (!auth) return response.status(401).json({ success: false, error: 'NOT_LOGGED_IN' });
  response.setHeader('Cache-Control', 'no-store');
  return response.status(200).json({ success: true, user: auth.user });
}
