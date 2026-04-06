import type { RouteActionValue } from './types';
import { _deserialize } from '@qwik.dev/core/internal';
import { QACTION_KEY } from './constants';

/**
 * Submit an action to the server and get the result.
 *
 * POSTs to `/routePath/?qaction={actionId}` with `Accept: application/json`. The server runs the
 * action and returns the result in an envelope: d=data, e=error, s=status, h=hashes, l=loaders.
 */
export async function submitAction(
  action: NonNullable<RouteActionValue>,
  routePath: string
): Promise<
  | {
      status: number;
      data?: unknown;
      error?: unknown;
      loaderHashes?: string[];
      loaderValues?: Record<string, unknown>;
    }
  | undefined
> {
  const pathBase = routePath.endsWith('/') ? routePath : routePath + '/';
  const url = `${pathBase}?${QACTION_KEY}=${encodeURIComponent(action.id)}`;

  const actionData = action.data;
  let fetchOptions: RequestInit;

  if (actionData instanceof FormData) {
    fetchOptions = {
      method: 'POST',
      body: actionData,
      headers: {
        Accept: 'application/json',
      },
    };
  } else {
    fetchOptions = {
      method: 'POST',
      body: JSON.stringify(actionData),
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        Accept: 'application/json',
      },
    };
  }

  const response = await fetch(url, fetchOptions);

  if (response.redirected) {
    const redirectedURL = new URL(response.url);
    if (redirectedURL.origin !== location.origin) {
      location.href = redirectedURL.href;
      return undefined;
    }
    location.href = redirectedURL.href;
    return undefined;
  }

  if ((response.headers.get('content-type') || '').includes('json')) {
    const text = await response.text();
    const parsed = _deserialize<{
      d?: unknown;
      e?: unknown;
      s?: number;
      h?: string[];
      l?: Record<string, unknown>;
    }>(text);
    return {
      status: parsed?.s ?? response.status,
      data: parsed?.d,
      error: parsed?.e,
      loaderHashes: parsed?.h,
      loaderValues: parsed?.l,
    };
  }

  return undefined;
}
