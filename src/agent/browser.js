(() => {
  'use strict';

  if (window.__traceflowBrowserInstalled) return;
  window.__traceflowBrowserInstalled = true;

  const EVENT_PATH = '/__traceflow/browser-event';
  const MAX_BODY = 48_000;
  const originalFetch = window.fetch.bind(window);
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  function id() {
    return globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function externalUrl(value) {
    try {
      const url = new URL(value, location.href);
      if (!/^https?:$/.test(url.protocol) || url.origin === location.origin) return null;
      const hostname = url.hostname.toLowerCase();
      if (hostname === 'localhost' || hostname.endsWith('.localhost') || /^127(?:\.\d+){3}$/.test(hostname) || hostname === '[::1]' || hostname === '::1') return null;
      return url;
    } catch {
      return null;
    }
  }

  function bodyText(value) {
    if (value == null) return '';
    let text;
    if (typeof value === 'string') text = value;
    else if (value instanceof URLSearchParams) text = value.toString();
    else if (value instanceof ArrayBuffer) text = `[binary body: ${value.byteLength} bytes]`;
    else if (ArrayBuffer.isView(value)) text = `[binary body: ${value.byteLength} bytes]`;
    else return '[non-text body]';
    return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n… truncated` : text;
  }

  function headersObject(value) {
    try {
      return Object.fromEntries(new Headers(value).entries());
    } catch {
      return {};
    }
  }

  function responseHeaders(value) {
    const headers = {};
    try {
      value.trim().split(/[\r\n]+/).forEach((line) => {
        const split = line.indexOf(':');
        if (split > 0) headers[line.slice(0, split).trim().toLowerCase()] = line.slice(split + 1).trim();
      });
    } catch {
      // Browsers can hide cross-origin response headers.
    }
    return headers;
  }

  async function readResponseBody(response) {
    if (!response.body?.getReader) return bodyText(await response.text());
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let truncated = false;
    try {
      while (text.length <= MAX_BODY) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.length > MAX_BODY) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
      text += decoder.decode();
    } catch {
      return '';
    }
    return truncated ? `${text.slice(0, MAX_BODY)}\n… truncated` : text;
  }

  function emit(event) {
    void originalFetch(EVENT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => {});
  }

  function context(url, method) {
    return {
      type: 'span',
      traceId: id(),
      spanId: id(),
      parentId: null,
      from: 'browser',
      to: url.host,
      method: String(method || 'GET').toUpperCase(),
      path: `${url.pathname}${url.search}`,
    };
  }

  window.fetch = async function traceflowFetch(input, init = {}) {
    const rawUrl = typeof input === 'string' || input instanceof URL ? input : input?.url;
    const url = externalUrl(rawUrl);
    if (!url) return originalFetch(input, init);

    const method = init.method || input?.method || 'GET';
    const ctx = context(url, method);
    const headers = new Headers(input?.headers || {});
    new Headers(init.headers || {}).forEach((value, key) => headers.set(key, value));
    emit({
      ...ctx,
      phase: 'start',
      at: Date.now(),
      requestHeaders: headersObject(headers),
      requestBody: bodyText(init.body),
    });

    try {
      const response = await originalFetch(input, init);
      void readResponseBody(response.clone()).then((body) => {
        emit({
          ...ctx,
          phase: 'end',
          at: Date.now(),
          status: response.status,
          responseHeaders: headersObject(response.headers),
          responseBody: bodyText(body),
        });
      }, () => {
        emit({ ...ctx, phase: 'end', at: Date.now(), status: response.status });
      });
      return response;
    } catch (error) {
      emit({ ...ctx, phase: 'end', at: Date.now(), status: 0, error: error?.message || 'Request failed' });
      throw error;
    }
  };

  XMLHttpRequest.prototype.open = function traceflowOpen(method, url) {
    this.__traceflow = { url: externalUrl(url), method, headers: {} };
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function traceflowSetRequestHeader(name, value) {
    if (this.__traceflow) this.__traceflow.headers[String(name).toLowerCase()] = String(value);
    return originalSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function traceflowSend(body) {
    const meta = this.__traceflow;
    if (!meta?.url) return originalSend.apply(this, arguments);
    const ctx = context(meta.url, meta.method);
    emit({
      ...ctx,
      phase: 'start',
      at: Date.now(),
      requestHeaders: meta.headers,
      requestBody: bodyText(body),
    });
    this.addEventListener('loadend', () => {
      let responseBody = '';
      try {
        if (!this.responseType || this.responseType === 'text') responseBody = bodyText(this.responseText);
      } catch {
        // Cross-origin response details can be restricted.
      }
      emit({
        ...ctx,
        phase: 'end',
        at: Date.now(),
        status: this.status || 0,
        responseHeaders: responseHeaders(this.getAllResponseHeaders()),
        responseBody,
      });
    }, { once: true });
    return originalSend.apply(this, arguments);
  };
})();
