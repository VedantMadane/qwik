import { _serialize, _verifySerializable, isDev } from '@qwik.dev/core/internal';
import type {
  ActionInternal,
  DataValidator,
  JSONObject,
  LoaderInternal,
  RequestEvent,
  RequestHandler,
  ValidatorReturn,
} from '../../../runtime/src/types';
import { getRouteLoaderData, getRouteLoaderValues } from '../../../runtime/src/route-loaders';
import { type RequestEventInternal } from '../request-event-core';
import { IsQAction, QActionId } from '../request-path';
import type { QRL } from '@qwik.dev/core';
import type { RequestEventBase } from '../types';
import { ServerError } from '../server-error';

/**
 * Handler for action requests (`?qaction={actionId}`).
 *
 * When the request has `Accept: application/json`, returns the action result as JSON. Otherwise,
 * falls through to let the page render (progressive enhancement for forms).
 *
 * If the action has no `invalidate` list, all loaders are re-run and their values are sent back
 * alongside the action result. If `invalidate` is specified, only those loader hashes are sent
 * (without values) for the client to re-fetch individually.
 */
export function actionHandler(
  routeActions: ActionInternal[],
  routeLoaders: LoaderInternal[]
): RequestHandler {
  return async (requestEvent: RequestEvent) => {
    const requestEv = requestEvent as RequestEventInternal;

    if (!requestEv.sharedMap.has(IsQAction)) {
      return;
    }

    // Only intercept when the client accepts JSON (fetch-based submissions).
    // Otherwise, fall through to let actionsMiddleware handle it for page renders
    // (progressive enhancement for forms).
    if (!requestEv.request.headers.get('accept')?.includes('application/json')) {
      return;
    }

    if (requestEv.headersSent || requestEv.exited) {
      return;
    }

    const actionId = requestEv.sharedMap.get(QActionId) as string;
    const method = requestEv.method;
    const devMode = isDev;

    if (devMode && method === 'GET') {
      console.warn(
        'Seems like you are submitting a Qwik Action via GET request. Qwik Actions should be submitted via POST request.\nMake sure your <form> has method="POST" attribute, like this: <form method="POST">'
      );
    }

    if (method !== 'POST') {
      return;
    }

    // Find the action
    let action: ActionInternal | undefined;
    for (const routeAction of routeActions) {
      if (routeAction.__id === actionId) {
        action = routeAction;
      }
    }

    // Try global actions map if not found in route
    if (!action) {
      const serverActionsMap = globalThis._qwikActionsMap as
        | Map<string, ActionInternal>
        | undefined;
      action = serverActionsMap?.get(actionId);
    }

    if (!action) {
      requestEv.json(404, { error: 'Action not found' });
      return;
    }

    // Execute the action
    const data = await requestEv.parseBody();
    if (!data || typeof data !== 'object') {
      throw new Error(`Expected request data for the action id ${actionId} to be an object`);
    }

    let actionError: ServerError | undefined;
    let actionData: unknown;

    try {
      const result = await runValidators(requestEv, action.__validators, data, devMode);
      if (!result.success) {
        actionError = requestEv.fail(result.status ?? 500, result.error);
      } else {
        const actionResolved = devMode
          ? await measure(requestEv, action.__qrl.getHash(), () =>
              action!.__qrl.call(requestEv, result.data as JSONObject, requestEv)
            )
          : await action.__qrl.call(requestEv, result.data as JSONObject, requestEv);
        if (devMode) {
          verifySerializable(actionResolved, action.__qrl);
        }
        if (actionResolved instanceof ServerError) {
          actionError = actionResolved;
        } else {
          actionData = actionResolved;
        }
      }
    } catch (err) {
      if (err instanceof ServerError) {
        actionError = err;
      } else if (err instanceof Error) {
        console.error('Action error:', err);
        actionError = new ServerError(500, 'Internal Server Error');
      } else {
        // RedirectMessage, AbortMessage, etc. — re-throw for middleware
        throw err;
      }
    }

    requestEv.sharedMap.set('@actionResult', actionError ?? actionData);

    // Build response envelope: d=data, e=error, s=status, h=hashes, l=loaders
    const responseData: Record<string, unknown> = {
      ...(actionError ? { e: actionError } : { d: actionData }),
      s: actionError ? actionError.status : requestEv.status(),
    };

    if (action.__invalidate) {
      // Action specifies which loaders to invalidate — send only hashes, client re-fetches
      responseData.h = action.__invalidate;
    } else {
      // No invalidate list — re-run ALL loaders and send their values back.
      // Store in request's loaderValues so cross-loader resolveValue() works.
      const loaderValues = getRouteLoaderValues(requestEv);
      await Promise.all(
        routeLoaders.map(async (loader) => {
          loaderValues[loader.__id] = await getRouteLoaderData(
            loader.__qrl,
            loader.__validators,
            requestEv
          );
        })
      );
      responseData.l = loaderValues;
    }

    const serialized = await _serialize(responseData);
    requestEv.headers.set('Content-Type', 'application/json; charset=utf-8');
    requestEv.send(actionError ? actionError.status : 200, serialized);
  };
}

async function runValidators(
  requestEv: RequestEvent,
  validators: DataValidator[] | undefined,
  data: unknown,
  devMode: boolean
) {
  let lastResult: ValidatorReturn = { success: true, data };
  if (validators) {
    for (const validator of validators) {
      if (devMode) {
        lastResult = await measure(requestEv, `validator$`, () =>
          validator.validate(requestEv, data)
        );
      } else {
        lastResult = await validator.validate(requestEv, data);
      }
      if (!lastResult.success) {
        return lastResult;
      } else {
        data = lastResult.data;
      }
    }
  }
  return lastResult;
}

function verifySerializable(data: any, qrl: QRL) {
  try {
    _verifySerializable(data, undefined);
  } catch (e: any) {
    if (e instanceof Error && qrl.dev) {
      (e as any).loc = qrl.dev;
    }
    throw e;
  }
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}

async function measure<T>(
  requestEv: RequestEventBase,
  name: string,
  fn: () => T
): Promise<Awaited<T>> {
  const start = now();
  try {
    return await fn();
  } finally {
    const duration = now() - start;
    let measurements = requestEv.sharedMap.get('@serverTiming');
    if (!measurements) {
      requestEv.sharedMap.set('@serverTiming', (measurements = []));
    }
    measurements.push([name, duration]);
  }
}
