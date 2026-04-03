import { _serialize, isDev } from '@qwik.dev/core/internal';
import type { LoaderInternal, RequestEvent, RequestHandler } from '../../../runtime/src/types';
import { type RequestEventInternal } from '../request-event-core';
import { IsQAction, IsQLoader, QLoaderId } from '../request-path';
import {
  getRouteLoaderResponse,
  resolveRouteLoaderByHash,
  FULLPATH_HEADER,
  type LoaderResponse,
} from '../../../runtime/src/route-loaders';
import { RedirectMessage } from '../redirect-handler';
import { ServerError } from '../server-error';

/**
 * Early handler that wraps `next()` for JSON API requests (q-loader and q-action).
 *
 * For `IsQLoader` requests, it also rewrites the URL using the `X-Qwik-fullpath` header so that
 * downstream middleware sees the real page URL.
 *
 * By calling `await next()` inside a try/catch, middleware redirects and errors are captured and
 * returned as JSON envelopes instead of HTTP redirects/error pages. This keeps SPA navigation
 * intact on the client.
 */
export function jsonRequestWrapper(): RequestHandler {
  return async (requestEvent: RequestEvent) => {
    const requestEv = requestEvent as RequestEventInternal;

    const isLoader = requestEv.sharedMap.has(IsQLoader);
    const isActionJson =
      requestEv.sharedMap.has(IsQAction) &&
      requestEv.request.headers.get('accept')?.includes('application/json');

    if (!isLoader && !isActionJson) {
      return;
    }

    // For loaders: rewrite URL using X-Qwik-fullpath header so middleware sees the real route
    if (isLoader) {
      const pagePath = requestEv.request.headers.get(FULLPATH_HEADER);
      if (pagePath) {
        try {
          requestEv.url.pathname = pagePath;
        } catch {
          // Invalid — ignore
        }
      }
    }

    // Wrap all downstream handlers in try/catch so middleware redirects/errors
    // become JSON responses instead of HTTP redirects/error pages
    try {
      await requestEv.next();
    } catch (err) {
      if (requestEv.headersSent) {
        return;
      }
      if (err instanceof RedirectMessage) {
        if (isLoader) {
          const location = requestEv.headers.get('Location') || '/';
          requestEv.headers.delete('Location');
          await sendLoaderResponse(requestEv, { r: location });
        } else {
          // Action redirects: let HTTP redirect propagate — client handles via response.redirected
          throw err;
        }
      } else if (err instanceof ServerError) {
        if (isLoader) {
          await sendLoaderResponse(requestEv, { e: err });
        } else {
          await sendActionResponse(requestEv, { e: err, s: err.status });
        }
      } else if (err instanceof Error) {
        console.error('JSON request error:', err);
        const message = isDev
          ? `${err.message}\n(this is only visible in dev mode)`
          : 'Internal Server Error';
        const se = new ServerError(500, message);
        if (isLoader) {
          await sendLoaderResponse(requestEv, { e: se });
        } else {
          await sendActionResponse(requestEv, { e: se, s: 500 });
        }
      } else {
        throw err; // AbortMessage etc.
      }
    }
  };
}

/**
 * Handler that executes the requested loader and returns the result as JSON. Runs AFTER
 * plugin/route middleware, so middleware redirects/errors are handled by `jsonRequestWrapper`. The
 * loader function's own redirects/errors are caught by getRouteLoaderResponse and serialized in the
 * LoaderResponse envelope ({ d, r, e }).
 */
export function loaderHandler(routeLoaders: LoaderInternal[]): RequestHandler {
  return async (requestEvent: RequestEvent) => {
    const requestEv = requestEvent as RequestEventInternal;

    if (!requestEv.sharedMap.has(IsQLoader)) {
      return;
    }

    if (requestEv.headersSent || requestEv.exited) {
      return;
    }

    const loaderId = requestEv.sharedMap.get(QLoaderId) as string;
    const loader = resolveRouteLoaderByHash(routeLoaders, loaderId);

    if (!loader) {
      requestEv.json(404, { error: 'Loader not found' });
      return;
    }

    const responseData = await getRouteLoaderResponse(loader.__qrl, loader.__validators, requestEv);
    await sendLoaderResponse(requestEv, responseData, loader);
  };
}

async function sendLoaderResponse(
  requestEv: RequestEventInternal,
  responseData: LoaderResponse,
  loader?: LoaderInternal
) {
  const data = await _serialize(responseData);
  requestEv.headers.set('Content-Type', 'application/json; charset=utf-8');
  if (responseData.d !== undefined && loader?.__expires && loader.__expires > 0) {
    requestEv.cacheControl({ maxAge: loader.__expires });
  }
  requestEv.send(200, data);
}

async function sendActionResponse(
  requestEv: RequestEventInternal,
  responseData: Record<string, unknown>
) {
  const data = await _serialize(responseData);
  requestEv.headers.set('Content-Type', 'application/json; charset=utf-8');
  requestEv.send((responseData.s as number) || 200, data);
}
