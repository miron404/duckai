// ==UserScript==
// @name         duck.ai jsa диагностика
// @namespace    duckai-diagnostics
// @version      1.0.0
// @description  Готовит свежий x-vqd-hash-1 в настоящем браузере, проверяет запрос к /duckchat/v1/chat и выдаёт данные для проверки из Termux
// @match        https://duck.ai/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Зачем это нужно
 * ---------------
 * Сервер (Termux) считает VQD-челлендж в JSDOM, и duck.ai отвечает на такие
 * запросы 418 ERR_CHALLENGE. Этот скрипт делает то же самое в настоящем
 * браузере и позволяет разделить две причины:
 *
 *   1. «Тест» — отправляет запрос к /duckchat/v1/chat с настоящим jsa и ровно
 *      теми заголовками, которые отправляет сервер. Если тут 200 — значит наш
 *      набор заголовков и логика jsa верны, а разница в чём-то ещё.
 *   2. «Скопировать» — выдаёт JSON с jsa/UA/заголовками, чтобы прогнать
 *      `bun run probe --jsa=...` на телефоне из Termux (тот же IP).
 *      Если там 418, а в браузере 200 — решает не jsa, а транспорт/сессия.
 *
 * Запросов тратится мало, но всё равно: не жми кнопки десятки раз, duck.ai
 * начинает отвечать 429 ERR_RATE_LIMIT.
 */

(function () {
  "use strict";

  const originalFetch = window.fetch.bind(window);

  /** Последний настоящий запрос сайта к /duckchat/v1/chat. */
  let capturedRequest = null;
  /** Последний подготовленный нами jsa. */
  let lastJsa = null;
  /** Последний тестовый ответ. */
  let lastTest = null;

  // ---------------------------------------------------------------- перехват

  function headersToObject(headers) {
    const out = {};
    try {
      new Headers(headers).forEach((value, key) => {
        out[key] = value;
      });
    } catch (error) {
      /* пустой набор заголовков */
    }
    return out;
  }

  window.fetch = function (input, init) {
    let url = "";
    try {
      url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
    } catch (error) {
      url = "";
    }

    const isChat = url.indexOf("/duckchat/v1/chat") !== -1;
    if (!isChat) return originalFetch(input, init);

    const requestHeaders = headersToObject(
      (init && init.headers) || (input instanceof Request ? input.headers : undefined),
    );

    let body = init && init.body;
    if (!body && input instanceof Request) {
      try {
        body = input.clone().text();
      } catch (error) {
        body = undefined;
      }
    }

    capturedRequest = { url, headers: requestHeaders, body };

    const pending = originalFetch(input, init);
    pending
      .then((response) => {
        capturedRequest = Object.assign({}, capturedRequest || {}, {
          status: response.status,
        });
        // jsa из ответа сервера — самый «свежий» из возможных
        const freshJsa = response.headers.get("x-vqd-hash-1");
        if (freshJsa) capturedRequest.responseJsa = freshJsa;
        render();
        return response;
      })
      .catch(() => {});
    return pending;
  };

  // -------------------------------------------------------------- jsa в браузере

  /**
   * Повторяет то, что делает сам duck.ai: берёт челлендж из /duckchat/v1/status,
   * выполняет его в offscreen-iframe, хеширует client_hashes и добавляет meta.
   */
  async function buildJsa() {
    const statusResponse = await originalFetch("/duckchat/v1/status", {
      headers: {
        accept: "*/*",
        "cache-control": "no-store",
        pragma: "no-cache",
        "x-vqd-accept": "1",
      },
      credentials: "include",
    });
    if (!statusResponse.ok) {
      throw new Error("status: HTTP " + statusResponse.status);
    }

    const challenge = statusResponse.headers.get("x-vqd-hash-1");
    if (!challenge) throw new Error("status: нет заголовка x-vqd-hash-1");

    const script = atob(challenge);
    const startedAt = Date.now();

    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
    iframe.style.cssText = "position:absolute;left:-9999px;top:-9999px;width:0;height:0;border:0";
    iframe.srcdoc =
      '<!DOCTYPE html><html><head>' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\';">' +
      "</head><body></body></html>";

    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("челлендж не отработал за 5 c")), 5000);
      iframe.onload = () => {
        try {
          const doc = iframe.contentDocument;
          if (!doc) throw new Error("нет доступа к iframe");

          const callbackName = "__duckaiJsaProbe";
          window[callbackName] = (error, value) => {
            clearTimeout(timer);
            if (error) reject(error instanceof Error ? error : new Error(String(error)));
            else resolve(value);
          };

          const element = doc.createElement("script");
          element.textContent =
            "try { window.parent." + callbackName + "(null, " + script + "); }" +
            " catch (e) { window.parent." + callbackName + "(e, null); }";
          doc.body.appendChild(element);
        } catch (error) {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      (document.body || document.documentElement).appendChild(iframe);
    });

    if (!result || typeof result !== "object" || !Array.isArray(result.client_hashes)) {
      throw new Error("челлендж вернул неожиданный результат");
    }

    const clientHashes = await Promise.all(
      result.client_hashes.map(async (value) => {
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(String(value)),
        );
        let binary = "";
        for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
        return btoa(binary);
      }),
    );

    // В настоящем браузере client_hashes[0] — уже правильный user agent,
    // подменять его не нужно (в отличие от JSDOM на сервере).
    const meta = Object.assign({}, result.meta || {}, {
      origin: location.origin,
      stack: new Error().stack || "no-stack",
      duration: String(Date.now() - startedAt),
    });

    iframe.remove();

    return btoa(JSON.stringify(Object.assign({}, result, { client_hashes: clientHashes, meta })));
  }

  function feVersion() {
    const version = window.__DDG_BE_VERSION__ || "dev";
    const sha = window.__DDG_FE_CHAT_HASH__ || "hash";
    // Сайт присылает уже готовое значение; если есть — берём его.
    if (capturedRequest && capturedRequest.headers["x-fe-version"]) {
      return capturedRequest.headers["x-fe-version"];
    }
    return version + "-" + sha;
  }

  function feSignals() {
    return btoa(JSON.stringify({ start: Date.now(), events: [], end: 0 }));
  }

  function journeyId() {
    if (capturedRequest && capturedRequest.headers["x-ddg-journey-id"]) {
      return capturedRequest.headers["x-ddg-journey-id"];
    }
    let id = "";
    for (let index = 0; index < 32; index++) {
      id += "0123456789abcdef"[Math.floor(Math.random() * 16)];
    }
    return id;
  }

  // -------------------------------------------------------------- тест запроса

  /** Заголовки ровно такие, какие отправляет сервер из src/duckai.ts. */
  function serverHeaders(jsa) {
    const headers = {
      accept: "text/event-stream",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      "content-type": "application/json",
      pragma: "no-cache",
      priority: "u=0",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "x-ddg-journey-id": journeyId(),
      "x-fe-signals": feSignals(),
      "x-vqd-hash-1": jsa,
    };
    const version = feVersion();
    if (version) headers["x-fe-version"] = version;
    return headers;
  }

  async function testRequest() {
    status("отправляю запрос…");
    try {
      const jsa = lastJsa || (await buildJsa());
      lastJsa = jsa;

      const response = await originalFetch("/duckchat/v1/chat", {
        method: "POST",
        headers: serverHeaders(jsa),
        credentials: "include",
        body: JSON.stringify({
          model: "gpt-6-luna",
          messages: [{ role: "user", content: "Reply with the single word: pong" }],
          canUseTools: true,
        }),
      });

      const text = await response.text();
      lastTest = { status: response.status, body: text.slice(0, 400) };
      status(
        "тест: " + response.status + " " +
          (response.status === 200 ? text.slice(0, 120) : text.slice(0, 160)),
      );
    } catch (error) {
      status("тест упал: " + (error && error.message ? error.message : error));
    }
    render();
  }

  /** Контроль: тот же запрос, но с jsa, который только что отправил сам сайт. */
  async function testCaptured() {
    const siteJsa =
      (capturedRequest && (capturedRequest.responseJsa || capturedRequest.headers["x-vqd-hash-1"])) || "";
    if (!siteJsa) {
      status("сначала отправь сообщение в чате duck.ai");
      return;
    }
    status("повторяю запрос с jsa сайта…");
    try {
      const response = await originalFetch("/duckchat/v1/chat", {
        method: "POST",
        headers: serverHeaders(siteJsa),
        credentials: "include",
        body: JSON.stringify({
          model: "gpt-6-luna",
          messages: [{ role: "user", content: "Reply with the single word: pong" }],
          canUseTools: true,
        }),
      });
      const text = await response.text();
      status(
        "jsa сайта: " + response.status + " " +
          (response.status === 200 ? text.slice(0, 120) : text.slice(0, 160)),
      );
    } catch (error) {
      status("упало: " + (error && error.message ? error.message : error));
    }
    render();
  }

  // ------------------------------------------------------------- интерфейс

  function payload() {
    return JSON.stringify(
      {
        userAgent: navigator.userAgent,
        feVersion: feVersion(),
        feSignals: feSignals(),
        journeyId: journeyId(),
        jsa: lastJsa,
        jsaLength: lastJsa ? lastJsa.length : 0,
        lastTest,
        capturedSiteRequest: capturedRequest
          ? {
              status: capturedRequest.status,
              feVersion: capturedRequest.headers["x-fe-version"],
              jsaLength: (capturedRequest.headers["x-vqd-hash-1"] || "").length,
            }
          : null,
      },
      null,
      2,
    );
  }

  let panel = null;
  let statusElement = null;
  let textArea = null;

  function status(message) {
    if (!statusElement) return;
    statusElement.textContent = message;
  }

  function button(label, onClick) {
    const element = document.createElement("button");
    element.textContent = label;
    element.style.cssText =
      "margin:0 6px 6px 0;padding:10px 12px;font-size:14px;border-radius:8px;" +
      "border:1px solid #444;background:#1f1f1f;color:#eee";
    element.addEventListener("click", () => {
      Promise.resolve(onClick()).catch((error) => status("ошибка: " + error));
    });
    return element;
  }

  function render() {
    if (!textArea) return;
    textArea.value = payload();
  }

  function mountPanel() {
    if (panel || !document.body) return;

    panel = document.createElement("div");
    panel.style.cssText =
      "position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;" +
      "background:#111;color:#eee;border:1px solid #444;border-radius:10px;" +
      "padding:8px;font:13px/1.4 monospace;max-height:60vh;overflow:auto;" +
      "box-shadow:0 4px 24px rgba(0,0,0,.5)";

    const title = document.createElement("div");
    title.textContent = "duck.ai jsa диагностика";
    title.style.cssText = "font-weight:bold;margin-bottom:6px";

    statusElement = document.createElement("div");
    statusElement.textContent = "отправь любое сообщение в чате, затем нажми «Тест»";
    statusElement.style.cssText = "margin-bottom:6px;color:#9ad";

    const buttons = document.createElement("div");

    buttons.appendChild(
      button("Тест (наши заголовки)", testRequest),
    );
    buttons.appendChild(
      button("Тест (jsa сайта)", testCaptured),
    );
    buttons.appendChild(
      button("Свежий jsa", async () => {
        status("считаю челлендж…");
        lastJsa = await buildJsa();
        status("jsa готов: " + lastJsa.length + " символов");
        render();
      }),
    );
    buttons.appendChild(
      button("Скопировать", async () => {
        render();
        textArea.focus();
        textArea.select();
        try {
          await navigator.clipboard.writeText(textArea.value);
          status("скопировано в буфер");
        } catch (error) {
          status("выдели текст в поле ниже и скопируй вручную");
        }
      }),
    );
    buttons.appendChild(
      button("Скрыть", () => {
        panel.remove();
        panel = null;
      }),
    );

    textArea = document.createElement("textarea");
    textArea.readOnly = true;
    textArea.style.cssText =
      "width:100%;height:150px;margin-top:4px;background:#000;color:#8f8;" +
      "border:1px solid #333;border-radius:6px;font:12px/1.35 monospace;padding:6px";

    const hint = document.createElement("div");
    hint.textContent =
      "Для Termux: скопируй JSON, нужен userAgent (в X_USER_AGENT) и jsa " +
      "(bun run probe --jsa='…').";
    hint.style.cssText = "margin-top:6px;color:#888";

    panel.appendChild(title);
    panel.appendChild(statusElement);
    panel.appendChild(buttons);
    panel.appendChild(textArea);
    panel.appendChild(hint);
    document.body.appendChild(panel);
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountPanel);
  } else {
    mountPanel();
  }
})();
