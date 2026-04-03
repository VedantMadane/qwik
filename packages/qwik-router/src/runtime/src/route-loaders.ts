import { implicit$FirstArg, isDev, isServer, type QRL } from '@qwik.dev/core';
import {
  _deserialize,
  _getContextEvent,
  _resolveContextWithoutSequentialScope,
  _verifySerializable,
  createAsync$,
  SerializerSymbol,
  type AsyncSignal,
  type SerializationStrategy,
} from '@qwik.dev/core/internal';
import type {
  RequestEvent as RequestEventBase,
  RequestEventLoader as ServerRequestEventLoader,
} from '@qwik.dev/router/middleware/request-handler';
// Import directly from leaf modules to avoid circular dependency:
// route-loaders.ts → middleware barrel → runtime/src/ (same module group)
import { _asyncRequestStore } from '../../middleware/request-handler/async-request-store';
import { RedirectMessage } from '../../middleware/request-handler/redirect-handler';
import { ServerError } from '../../middleware/request-handler/server-error';
import { DEFAULT_LOADERS_SERIALIZATION_STRATEGY } from './constants';
import { RouteLoaderCtxContext, RouteStateContext } from './contexts';
import type {
  DataValidator,
  LoaderConstructor,
  LoaderConstructorQRL,
  LoaderInternal,
  LoaderOptions,
  RequestEvent,
  RequestEventLoader,
  RouteModule,
  ValidatorReturn,
} from './types';

/**
 * Route loaders read data before the route rendering starts, based on the route being navigated to.
 * They automatically update when the route changes on the client, and can also be made to poll for
 * changes.
 *
 * They are represented by an AsyncSignal.
 */

const REQUEST_ROUTE_LOADER_STATE = '@routeLoaderState';
const REQUEST_LOADER_PATHS_STORE = '@loaderPathsStore';
const REQUEST_ROUTE_LOADERS = '@routeLoaders';

/** Header name sent by client to tell the server the actual page URL for loader requests. */
export const FULLPATH_HEADER = 'X-Qwik-fullpath';

/**
 * Response envelope for loader.json requests. Exactly one of `d`, `r`, or `e` is set.
 *
 * - `d` — data: the loader's successful return value
 * - `r` — redirect: URL to navigate to (from `throw redirect()`)
 * - `e` — error: a ServerError (from `fail()` or `throw serverError()`)
 */
export type LoaderResponse = {
  d?: unknown;
  r?: string;
  e?: InstanceType<typeof ServerError>;
};

/**
 * Reactive context for route loaders. On the server this is stored in sharedMap, on the client it's
 * a store that gets updated on navigation.
 *
 * - `loaderPaths`: loader ID → fetch path (the longest route path for that loader)
 * - `pageUrl`: the full page URL (used for search and the X-Qwik-fullpath header on fetch)
 * - `manifestHash`: the build manifest hash (part of the fetch URL)
 */
export type RouteLoaderCtx = {
  loaderPaths: Record<string, string | undefined>;
  pageUrl: URL;
  manifestHash: string;
  basePath: string;
  /** SPA navigation function, set by the router component. noSerialize'd. */
  goto?: (url: string) => void;
};

class ServerRouteLoaderCapture {
  constructor(
    readonly hash: string,
    readonly qrl: QRL<(event: RequestEventLoader) => unknown>,
    readonly validators: DataValidator[] | undefined
  ) {}

  load() {
    const requestEv = getRequestEvent();
    // Use pre-computed value from loadersMiddleware if available,
    // to avoid re-running the loader after the response stream is open.
    const values = getRouteLoaderValues(requestEv);
    if (this.hash in values) {
      return values[this.hash];
    }
    return getRouteLoaderData(this.qrl, this.validators, requestEv);
  }

  [SerializerSymbol]() {
    return this.hash;
  }
}

const isRequestEvent = (value: unknown): value is RequestEvent =>
  !!value &&
  typeof value === 'object' &&
  Object.prototype.hasOwnProperty.call(value, 'sharedMap') &&
  Object.prototype.hasOwnProperty.call(value, 'cookie');

const isLoaderInternal = (value: unknown): value is LoaderInternal =>
  typeof value === 'function' && (value as LoaderInternal).__brand === 'server_loader';

const getLoaderInterval = (expires: number | undefined, poll: boolean | undefined) => {
  const magnitude = expires ? Math.abs(expires) * 1000 : 0;
  return poll === true ? magnitude : -magnitude;
};

/**
 * Fetch a single loader's data from the server.
 *
 * URL pattern: `{basePath}{routePath}/q-loader-{loaderId}.{manifestHash}.json`
 */
/** Fetch a loader's JSON response from the server. Returns the LoaderResponse envelope. */
export const fetchRouteLoaderData = async (
  loaderId: string,
  routePath: string | undefined,
  manifestHash: string,
  opts?: {
    pageUrl?: URL;
    basePath?: string;
    ignoreCache?: boolean;
    signal?: AbortSignal;
  }
): Promise<LoaderResponse | undefined> => {
  if (!routePath) {
    return undefined;
  }
  // Ensure the route path includes the base path (root trie loaders get '/' but
  // need the full base path for fetching)
  let resolvedPath = routePath;
  const basePath = opts?.basePath ?? '/';
  if (basePath !== '/' && !resolvedPath.startsWith(basePath)) {
    resolvedPath = basePath + resolvedPath.slice(1);
  }
  const pathBase = resolvedPath.endsWith('/') ? resolvedPath : resolvedPath + '/';
  const pageUrl = opts?.pageUrl;
  const search = pageUrl?.search ?? '';
  // TODO allowList search params + compat flag that allows search params
  const url = `${pathBase}q-loader-${loaderId}.${manifestHash}.json${search}`;

  const headers: Record<string, string> = {};
  if (pageUrl && pageUrl.pathname !== pathBase) {
    // TODO disable when nocompat
    headers[FULLPATH_HEADER] = pageUrl.pathname;
  }

  const response = await fetch(url, {
    signal: opts?.signal,
    cache: opts?.ignoreCache ? 'reload' : 'default',
    headers,
  });
  // Middleware redirects produce HTTP 3xx — convert to LoaderResponse
  if (response.redirected) {
    return { r: response.url };
  }
  if (!response.ok) {
    return undefined;
  }
  const text = await response.text();
  return _deserialize<LoaderResponse>(text) ?? undefined;
};

const createRouteLoaderSignal = (loader: LoaderInternal, routeLoaderCtx: RouteLoaderCtx) => {
  const capture = isServer
    ? new ServerRouteLoaderCapture(loader.__id, loader.__qrl, loader.__validators)
    : loader.__id;
  return createAsync$(
    async ({ track, info, abortSignal }) => {
      if (isServer) {
        return (capture as ServerRouteLoaderCapture).load();
      }
      const id = capture as string;
      // Track reactive dependencies so the signal re-fetches when the route path changes
      const routePath = track(routeLoaderCtx.loaderPaths, id) as string | undefined;
      // TODO strict mode that doesn't pass the full url and only passes allowed search params, returning previous otherwise
      const pageUrl = track(routeLoaderCtx, 'pageUrl') as URL;
      const mHash = routeLoaderCtx.manifestHash;
      const basePath = routeLoaderCtx.basePath;
      // If info contains a pre-loaded value (from action response), use it directly.
      // track() was already called above to maintain subscriptions.
      if (info && typeof info === 'object' && '__v' in (info as object)) {
        return (info as { __v: unknown }).__v;
      }
      // If the loader isn't present on the current route, throw so the signal
      // enters NEEDS_COMPUTATION state (prevents returning stale data)
      if (!routePath) {
        throw new Error(`Loader ${id} not available on current route`);
      }
      // Fetch from server
      const response = await fetchRouteLoaderData(id, routePath, mHash, {
        pageUrl,
        basePath,
        ignoreCache: info === true,
        signal: abortSignal,
      });
      if (!response) {
        throw new Error(`Loader ${id} returned empty response`);
      }
      if (response.r) {
        // Redirect — use SPA goto if available, else full page nav
        const goto = routeLoaderCtx.goto;
        if (goto) {
          goto(response.r);
        } else {
          location.href = response.r;
        }
        // Throw so the signal enters NEEDS_COMPUTATION (don't set value to undefined)
        throw new Error(`Loader ${id} redirected to ${response.r}`);
      }
      if (response.e) {
        // Error — throw so AsyncSignal enters error state
        throw response.e;
      }
      return response.d;
    },

    {
      serializationStrategy: loader.__serializationStrategy,
      interval: getLoaderInterval(loader.__expires, loader.__poll),
    }
  );
};

const getLoaderOptions = (rest: (LoaderOptions | DataValidator)[]) => {
  let serializationStrategy: SerializationStrategy = DEFAULT_LOADERS_SERIALIZATION_STRATEGY;
  let expires: number | undefined;
  let poll: boolean | undefined;
  let eTag: LoaderOptions['eTag'] | undefined;
  const validators: DataValidator[] = [];

  if (rest.length === 1) {
    const options = rest[0];
    if (options && typeof options === 'object') {
      if ('validate' in options) {
        validators.push(options);
      } else {
        if (options.serializationStrategy) {
          serializationStrategy = options.serializationStrategy;
        }
        if (options.validation) {
          validators.push(...options.validation);
        }
        if ('expires' in options) {
          expires = options.expires;
        }
        if ('poll' in options) {
          poll = options.poll;
        }
        if ('eTag' in options) {
          eTag = options.eTag;
        }
      }
    }
  } else if (rest.length > 1) {
    validators.push(...(rest.filter(Boolean) as DataValidator[]));
  }

  return {
    validators: validators.reverse(),
    serializationStrategy,
    expires,
    poll,
    eTag,
  };
};

export const getRequestEvent = (thisArg?: unknown): RequestEvent => {
  if (!isServer) {
    throw new Error('getRequestEvent() can only be used on the server.');
  }
  const requestEvent =
    (_asyncRequestStore?.getStore() as RequestEvent | undefined) ||
    [thisArg, _getContextEvent()].find(isRequestEvent);
  if (!requestEvent) {
    throw new Error('Unable to determine the current RequestEvent.');
  }
  return requestEvent;
};

const REQUEST_ROUTE_LOADER_VALUES = '@routeLoaderValues';

export function getRouteLoaderState(
  requestEv: RequestEventBase
): Record<string, AsyncSignal<unknown>> {
  let state = requestEv.sharedMap.get(REQUEST_ROUTE_LOADER_STATE) as
    | Record<string, AsyncSignal<unknown>>
    | undefined;
  if (!state) {
    state = {};
    requestEv.sharedMap.set(REQUEST_ROUTE_LOADER_STATE, state);
  }
  return state;
}

/** Get/create the record of pre-loaded loader values (used by middleware before component). */
export function getRouteLoaderValues(requestEv: RequestEventBase): Record<string, unknown> {
  let values = requestEv.sharedMap.get(REQUEST_ROUTE_LOADER_VALUES) as
    | Record<string, unknown>
    | undefined;
  if (!values) {
    values = {};
    requestEv.sharedMap.set(REQUEST_ROUTE_LOADER_VALUES, values);
  }
  return values;
}

/** Store the route loader internals on the request for SSG to read. */
export function setRouteLoaders(requestEv: RequestEventBase, loaders: LoaderInternal[]) {
  requestEv.sharedMap.set(REQUEST_ROUTE_LOADERS, loaders);
}

/** Get the route loader internals stored on the request. */
export function getRouteLoaders(requestEv: RequestEventBase): LoaderInternal[] {
  return requestEv.sharedMap.get(REQUEST_ROUTE_LOADERS) ?? [];
}

export function getRouteLoaderCtx(requestEv: RequestEventBase): RouteLoaderCtx {
  let ctx = requestEv.sharedMap.get(REQUEST_LOADER_PATHS_STORE) as RouteLoaderCtx | undefined;
  if (!ctx) {
    ctx = {
      loaderPaths: {},
      pageUrl: new URL(requestEv.url.href),
      manifestHash: '',
      basePath: requestEv.basePathname || '/',
    };
    requestEv.sharedMap.set(REQUEST_LOADER_PATHS_STORE, ctx);
  }
  return ctx;
}

/** Update the loader paths store on client-side navigation. */
export const updateRouteLoaderCtx = (
  ctx: RouteLoaderCtx,
  loaderPaths: Record<string, string> | undefined,
  pageUrl: URL
) => {
  ctx.pageUrl = pageUrl;
  for (const key of Object.keys(ctx.loaderPaths)) {
    if (!loaderPaths?.[key]) {
      ctx.loaderPaths[key] = undefined;
    }
  }
  // Add/update paths
  if (loaderPaths) {
    for (const [key, value] of Object.entries(loaderPaths)) {
      ctx.loaderPaths[key] = value;
    }
  }
};

export const getModuleRouteLoaders = (mods: readonly (RouteModule | undefined)[]) => {
  const routeLoaders: LoaderInternal[] = [];
  const seen = new Set<string>();
  for (const mod of mods) {
    if (!mod) {
      continue;
    }
    for (const value of Object.values(mod)) {
      if (isLoaderInternal(value) && !seen.has(value.__id)) {
        seen.add(value.__id);
        routeLoaders.push(value);
      }
    }
  }
  return routeLoaders;
};

export const ensureRouteLoaderSignal = (
  loader: LoaderInternal,
  state: Record<string, AsyncSignal<unknown>>,
  routeLoaderCtx: RouteLoaderCtx
) => {
  return (state[loader.__id] ||= createRouteLoaderSignal(loader, routeLoaderCtx));
};

export const ensureRouteLoaderSignals = (
  mods: readonly (RouteModule | undefined)[],
  state: Record<string, AsyncSignal<unknown>>,
  routeLoaderCtx: RouteLoaderCtx
) => {
  const loaders = getModuleRouteLoaders(mods);
  for (const loader of loaders) {
    ensureRouteLoaderSignal(loader, state, routeLoaderCtx);
  }
  return loaders;
};

/**
 * Inject a pre-loaded value into an AsyncSignal while preserving track() subscriptions. Uses
 * invalidate({ __v }) + $computeIfNeeded$() so the compute function runs synchronously, registers
 * subscriptions via track(), and returns the pre-loaded value without fetching.
 */
export const setLoaderSignalValue = (signal: AsyncSignal<unknown>, value: unknown) => {
  signal.invalidate({ __v: value });
  (signal as any).$computeIfNeeded$();
};

export const resolveRouteLoaderByHash = (
  routeLoaders: readonly LoaderInternal[],
  loaderId: string
) => {
  return routeLoaders.find((loader) => loader.__id === loaderId);
};

/** Run a loader and return its raw value. Errors/redirects propagate as exceptions. */
export const getRouteLoaderData = async (
  loaderQrl: QRL<(event: RequestEventLoader) => unknown>,
  validators: DataValidator[] | undefined,
  requestEv: RequestEvent
) => {
  const loaderRequestEv = requestEv as unknown as RequestEventLoader;

  const result = await runValidators(requestEv, validators, undefined);
  if (!result.success) {
    return loaderRequestEv.fail(result.status ?? 500, result.error);
  }
  const resolved = await loaderQrl.call(
    loaderRequestEv as unknown as ServerRequestEventLoader,
    loaderRequestEv
  );
  const value = typeof resolved === 'function' ? resolved() : resolved;
  if (isDev) {
    verifySerializable(value, loaderQrl);
  }
  return value;
};

/** Run a loader and wrap the result in a LoaderResponse envelope. Catches redirects/errors. */
export const getRouteLoaderResponse = async (
  loaderQrl: QRL<(event: RequestEventLoader) => unknown>,
  validators: DataValidator[] | undefined,
  requestEv: RequestEvent
): Promise<LoaderResponse> => {
  try {
    const value = await getRouteLoaderData(loaderQrl, validators, requestEv);
    if (value instanceof ServerError) {
      return { e: value };
    }
    return { d: value };
  } catch (err) {
    if (err instanceof RedirectMessage) {
      const location = requestEv.headers.get('Location') || '/';
      requestEv.headers.delete('Location');
      return { r: location };
    }
    if (err instanceof ServerError) {
      return { e: err };
    }
    console.error('Loader error:', err);
    return { e: new ServerError(500, 'Internal Server Error') };
  }
};

/** @internal */
export const routeLoaderQrl = ((
  loaderQrl: QRL<(event: RequestEventLoader) => unknown>,
  ...rest: (LoaderOptions | DataValidator)[]
): LoaderInternal => {
  const { validators, serializationStrategy, expires, poll, eTag } = getLoaderOptions(rest);

  function loader() {
    const state = _resolveContextWithoutSequentialScope(RouteStateContext)!;
    const routeLoaderCtx = _resolveContextWithoutSequentialScope(RouteLoaderCtxContext)!;
    const signal = ensureRouteLoaderSignal(loader, state, routeLoaderCtx);
    void signal.promise();
    return signal;
  }

  loader.__brand = 'server_loader' as const;
  loader.__qrl = loaderQrl;
  loader.__validators = validators;
  loader.__id = loaderQrl.getHash();
  loader.__serializationStrategy = serializationStrategy;
  loader.__expires = expires ?? 0;
  loader.__poll = poll ?? false;
  loader.__eTag = eTag;
  Object.freeze(loader);
  return loader;
}) as LoaderConstructorQRL;

/** @public */
export const routeLoader$: LoaderConstructor = /*#__PURE__*/ implicit$FirstArg(routeLoaderQrl);

async function runValidators(
  requestEv: RequestEvent,
  validators: DataValidator[] | undefined,
  data: unknown
) {
  let lastResult: ValidatorReturn = {
    success: true,
    data,
  };
  if (validators) {
    for (const validator of validators) {
      lastResult = await validator.validate(requestEv, data);
      if (!lastResult.success) {
        return lastResult;
      }
      data = lastResult.data;
    }
  }
  return lastResult;
}

function verifySerializable(data: any, qrl: QRL) {
  try {
    _verifySerializable(data, undefined);
  } catch (error: any) {
    if (error instanceof Error && qrl.dev) {
      (error as any).loc = qrl.dev;
    }
    throw error;
  }
}
