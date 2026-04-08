// Per-session storage so the mpa and spa Playwright describe blocks (and any
// other parallel workers) don't race on a shared module-level array.
// The session id is carried in a cookie set by the root action.
const sessionData = new Map<string, string[]>();

export const SESSION_COOKIE = 'issue2644-session';

export const getSessionData = (sessionId: string | undefined): string[] => {
  if (!sessionId) {
    return [];
  }
  let data = sessionData.get(sessionId);
  if (!data) {
    data = [];
    sessionData.set(sessionId, data);
  }
  return data;
};

export const createSessionId = () =>
  `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
