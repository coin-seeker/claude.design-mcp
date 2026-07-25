import { logEvent } from './log.mjs';
import { classifyTurnRequest } from './turn-classify.mjs';

const requestMethod = (request) => typeof request.method === 'function' ? request.method() : request.method;
const requestUrl = (request) => typeof request.url === 'function' ? request.url() : request.url;
const responseStatus = (response) => typeof response.status === 'function' ? response.status() : response.status;
const responseRequest = (response) => typeof response.request === 'function' ? response.request() : response.request;
const responseUrl = (response) => typeof response.url === 'function' ? response.url() : response.url;

function matches(request, kinds, postOnly) {
  const kind = classifyTurnRequest(requestUrl(request));
  return kinds.includes(kind) && (!postOnly || requestMethod(request) === 'POST');
}

function timeoutAfter(ms, message) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}

export async function observeTurnAction(page, action, options) {
  const kinds = options.kinds;
  const timeoutMs = Number(options.timeoutMs);
  const postOnly = options.postOnly === true;
  let resolveRequest;
  let rejectRequest;
  let resolveResponse;
  let rejectResponse;
  const requestObserved = new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
  const responseObserved = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
  const onRequest = (request) => {
    if (!matches(request, kinds, postOnly)) return;
    const kind = classifyTurnRequest(requestUrl(request));
    logEvent('turn.request', { kind, method: requestMethod(request), url: requestUrl(request) });
    resolveRequest(request);
  };
  const onResponse = (response) => {
    const request = responseRequest(response);
    const candidate = request || { method: 'POST', url: responseUrl(response) };
    if (!matches(candidate, kinds, postOnly)) return;
    const kind = classifyTurnRequest(requestUrl(candidate));
    const status = responseStatus(response);
    logEvent('turn.response', { kind, status, url: responseUrl(response) });
    if (status >= 400 && options.requireResponse === true) rejectResponse(new Error(`${kind} request returned HTTP ${status}`));
    else resolveResponse(response);
  };
  const onRequestFailed = (request) => {
    if (!matches(request, kinds, postOnly)) return;
    const kind = classifyTurnRequest(requestUrl(request));
    const failure = typeof request.failure === 'function' ? request.failure() : request.failure;
    const error = String(failure?.errorText || failure || 'request failed');
    logEvent('turn.request_failed', { kind, method: requestMethod(request), url: requestUrl(request), error });
    const failureError = new Error(`${kind} request failed: ${error}`);
    rejectRequest(failureError);
    if (options.requireResponse === true) rejectResponse(failureError);
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  const requestTimeout = timeoutAfter(timeoutMs, options.requestTimeoutMessage);
  const responseTimeout = options.requireResponse === true
    ? timeoutAfter(timeoutMs, options.responseTimeoutMessage || options.requestTimeoutMessage)
    : { promise: null, clear: () => {} };
  const requestResult = Promise.race([requestObserved, requestTimeout.promise]);
  const responseResult = responseTimeout.promise ? Promise.race([responseObserved, responseTimeout.promise]) : null;
  try {
    await Promise.all([action(), requestResult]);
    if (responseResult) await responseResult;
  } finally {
    requestTimeout.clear();
    responseTimeout.clear();
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
  }
}
