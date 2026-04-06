import { _serialize } from '@qwik.dev/core/internal';
import type { LoaderInternal, RequestEvent, RequestHandler } from '../../../runtime/src/types';
import { type RequestEventInternal } from '../request-event-core';
import { IsQLoader, QLoaderId } from '../request-path';
import {
  getRouteLoaderResponse,
  resolveRouteLoaderByHash,
  FULLPATH_HEADER,
} from '../../../runtime/src/route-loaders';

/**
 * Early handler that detects q-loader requests and rewrites the URL to the real page path. This
 * runs BEFORE plugin/route middleware so that middleware (onGet, onRequest, etc.) sees the correct
 * route URL and can redirect/guard as expected.
 *
 * Note that this runs _after_ the route has already been matched, so it won't affect which route is
 * selected.
 */
export function loaderUrlRewrite(): RequestHandler {
  return (requestEvent: RequestEvent) => {
    const requestEv = requestEvent as RequestEventInternal;

    if (!requestEv.sharedMap.has(IsQLoader)) {
      return;
    }

    // Use the X-Qwik-fullpath header to reconstruct the actual page URL.
    // This ensures middleware sees the real route, not the q-loader-*.json path.
    const pagePath = requestEv.request.headers.get(FULLPATH_HEADER);
    if (pagePath) {
      try {
        requestEv.url.pathname = pagePath;
      } catch {
        // Invalid — ignore
      }
    }
  };
}

/**
 * Handler that executes the requested loader and returns the result as JSON. Runs AFTER
 * plugin/route middleware, so middleware redirects/errors are handled normally (HTTP 3xx). The
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

    const data = await _serialize(responseData);
    requestEv.headers.set('Content-Type', 'application/json; charset=utf-8');

    if (responseData.d !== undefined && loader.__expires && loader.__expires > 0) {
      requestEv.cacheControl({ maxAge: loader.__expires });
    }

    requestEv.send(200, data);
  };
}
