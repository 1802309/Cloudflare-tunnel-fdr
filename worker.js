const BACKEND_URL = "https://brad.cdnconnect.site:8443";

const DEBUG = true;
const MAX_RETRIES = 3;
const MAX_EARLY_DATA_BYTES = 64 * 1024;

function log(...args) {
  if (DEBUG) console.log("[xhttp]", ...args);
}

function errorLog(...args) {
  if (DEBUG) console.error("[xhttp]", ...args);
}

function textResponse(status, message) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/*
 * XHTTP in this Worker is handled through the same
 * websocket-upgrade mechanism used by the reference
 * cf-xray-proxy implementation.
 */
function hasUpgradeRequest(request) {
  const connection =
    request.headers.get("Connection")?.toLowerCase() ?? "";

  const upgrade =
    request.headers.get("Upgrade")?.toLowerCase() ?? "";

  return (
    Boolean(upgrade) &&
    connection.includes("upgrade") &&
    upgrade === "websocket"
  );
}

function buildBackendUrl(inboundUrl) {
  const backend = new URL(BACKEND_URL);

  // Preserve exact incoming path + query.
  backend.pathname = inboundUrl.pathname;
  backend.search = inboundUrl.search;

  return backend;
}

function buildPassthroughHeaders(request) {
  const headers = new Headers(request.headers);

  // Let fetch generate the backend Host.
  headers.delete("Host");

  return headers;
}

function buildBackendUpgradeHeaders(request) {
  const headers = new Headers(request.headers);

  // Backend TLS/SNI comes from BACKEND_URL.
  headers.delete("Host");

  headers.set("Connection", "Upgrade");
  headers.set("Upgrade", "websocket");

  // Do not forward Cloudflare/client websocket
  // extension negotiation blindly.
  headers.delete("Sec-WebSocket-Extensions");

  const protocol =
    headers.get("Sec-WebSocket-Protocol");

  if (protocol) {
    headers.set(
      "Sec-WebSocket-Protocol",
      protocol
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .join(", ")
    );
  } else {
    headers.delete("Sec-WebSocket-Protocol");
  }

  return headers;
}

function parseMode(url, request) {
  const fromQuery =
    url.searchParams.get("mode")?.toLowerCase();

  const fromHeader =
    request.headers
      .get("x-xhttp-mode")
      ?.toLowerCase();

  const mode =
    fromQuery ??
    fromHeader ??
    "auto";

  if (
    mode === "auto" ||
    mode === "packet-up"
  ) {
    return mode;
  }

  throw new Error(
    "Invalid xhttp mode. Supported values are auto and packet-up."
  );
}

function parseEarlyDataHint(url) {
  const raw =
    url.searchParams.get("ed");

  if (raw === null) {
    return 0;
  }

  const parsed = Number(raw);

  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < 0
  ) {
    throw new Error(
      "Invalid early-data hint."
    );
  }

  return Math.min(
    parsed,
    MAX_EARLY_DATA_BYTES
  );
}

const NEGOTIATION_TOKENS =
  new Set([
    "trojan",
    "vless",
    "vmess",
  ]);

function decodeBase64Url(value) {
  const normalized =
    value
      .replace(/-/g, "+")
      .replace(/_/g, "/");

  const padding =
    (4 -
      (normalized.length % 4)) %
    4;

  const binary = atob(
    normalized +
      "=".repeat(padding)
  );

  const output =
    new Uint8Array(binary.length);

  for (
    let i = 0;
    i < binary.length;
    i++
  ) {
    output[i] =
      binary.charCodeAt(i);
  }

  return output;
}

function encodeBase64Url(input) {
  let binary = "";

  for (const value of input) {
    binary += String.fromCharCode(
      value
    );
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function parseEarlyData(
  headerValue,
  maxBytes
) {
  if (maxBytes <= 0) {
    return {
      data: null,
      errorMessage: null,
      shouldStripProtocolHeader: false,
    };
  }

  const tokens =
    (headerValue ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

  if (tokens.length === 0) {
    return {
      data: null,
      errorMessage: null,
      shouldStripProtocolHeader: false,
    };
  }

  // Keep VLESS / VMess / Trojan negotiation
  // tokens untouched.
  if (
    tokens.some((token) =>
      NEGOTIATION_TOKENS.has(
        token.toLowerCase()
      )
    )
  ) {
    return {
      data: null,
      errorMessage: null,
      shouldStripProtocolHeader: false,
    };
  }

  // Early-data extraction is only valid when
  // there is exactly one auxiliary token.
  if (tokens.length !== 1) {
    return {
      data: null,
      errorMessage: null,
      shouldStripProtocolHeader: false,
    };
  }

  const token = tokens[0];

  if (
    !token ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    return {
      data: null,
      errorMessage: null,
      shouldStripProtocolHeader: false,
    };
  }

  let decoded;

  try {
    decoded = decodeBase64Url(token);
  } catch {
    return {
      data: null,
      errorMessage: null,
      shouldStripProtocolHeader: false,
    };
  }

  // Canonical base64url check.
  if (
    encodeBase64Url(decoded) !==
    token
  ) {
    return {
      data: null,
      errorMessage: null,
      shouldStripProtocolHeader: false,
    };
  }

  if (
    decoded.byteLength >
    maxBytes
  ) {
    return {
      data: null,
      errorMessage:
        `xhttp early-data exceeds limit ` +
        `(${decoded.byteLength} > ${maxBytes} bytes).`,
      shouldStripProtocolHeader: false,
    };
  }

  return {
    data: decoded,
    errorMessage: null,
    shouldStripProtocolHeader: true,
  };
}

function safeClose(
  socket,
  code = 1011,
  reason = "Closed"
) {
  let safeCode = code;

  if (
    !Number.isInteger(safeCode) ||
    safeCode < 1000 ||
    safeCode > 4999 ||
    safeCode === 1005 ||
    safeCode === 1006
  ) {
    safeCode = 1011;
  }

  const safeReason =
    String(reason).slice(0, 123);

  try {
    socket.close(
      safeCode,
      safeReason
    );
  } catch {
    try {
      socket.close();
    } catch {}
  }
}

function closePair(
  firstSocket,
  secondSocket,
  code = 1011,
  reason = "Closed"
) {
  safeClose(
    firstSocket,
    code,
    reason
  );

  safeClose(
    secondSocket,
    code,
    reason
  );
}

function bridgeSockets(
  clientSocket,
  backendSocket
) {
  let closed = false;

  const closeBoth = (
    code = 1011,
    reason = "Relay failure"
  ) => {
    if (closed) {
      return;
    }

    closed = true;

    safeClose(
      clientSocket,
      code,
      reason
    );

    safeClose(
      backendSocket,
      code,
      reason
    );
  };

  const forward = (
    destination,
    payload,
    direction
  ) => {
    if (
      closed ||
      destination.readyState !== 1
    ) {
      return;
    }

    // Cloudflare can expose Blob payloads.
    if (payload instanceof Blob) {
      payload
        .arrayBuffer()
        .then((buffer) => {
          if (
            closed ||
            destination.readyState !== 1
          ) {
            return;
          }

          try {
            destination.send(
              buffer
            );
          } catch (error) {
            errorLog(
              "relay error",
              direction,
              error
            );

            closeBoth(
              1011,
              "Relay failure"
            );
          }
        })
        .catch((error) => {
          errorLog(
            "relay error",
            direction,
            error
          );

          closeBoth(
            1011,
            "Relay failure"
          );
        });

      return;
    }

    try {
      destination.send(
        payload
      );
    } catch (error) {
      errorLog(
        "relay error",
        direction,
        error
      );

      closeBoth(
        1011,
        "Relay failure"
      );
    }
  };

  const onClientMessage =
    (event) => {
      forward(
        backendSocket,
        event.data,
        "client->backend"
      );
    };

  const onBackendMessage =
    (event) => {
      forward(
        clientSocket,
        event.data,
        "backend->client"
      );
    };

  const onClientClose =
    (event) => {
      closeBoth(
        event.code || 1000,
        event.reason ||
          "Client closed connection"
      );
    };

  const onBackendClose =
    (event) => {
      closeBoth(
        event.code || 1000,
        event.reason ||
          "Backend closed connection"
      );
    };

  const onClientError =
    () => {
      closeBoth(
        1011,
        "Client socket error"
      );
    };

  const onBackendError =
    () => {
      closeBoth(
        1011,
        "Backend socket error"
      );
    };

  clientSocket.addEventListener(
    "message",
    onClientMessage
  );

  backendSocket.addEventListener(
    "message",
    onBackendMessage
  );

  clientSocket.addEventListener(
    "close",
    onClientClose
  );

  backendSocket.addEventListener(
    "close",
    onBackendClose
  );

  clientSocket.addEventListener(
    "error",
    onClientError
  );

  backendSocket.addEventListener(
    "error",
    onBackendError
  );
}

async function fetchWithTimeout(
  url,
  init,
  timeoutMs
) {
  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    return await fetch(
      url,
      {
        ...init,
        signal:
          controller.signal,
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    const requestUrl =
      new URL(request.url);

    /*
     * ------------------------------------------------
     * Health
     * ------------------------------------------------
     */

    if (
      request.method.toUpperCase() ===
        "GET" &&
      requestUrl.pathname ===
        "/health"
    ) {
      return jsonResponse(
        200,
        {
          status: "ok",
          transport: "xhttp",
        }
      );
    }

    /*
     * ------------------------------------------------
     * Debug status
     * ------------------------------------------------
     */

    if (
      request.method.toUpperCase() ===
        "GET" &&
      requestUrl.pathname ===
        "/status"
    ) {
      return jsonResponse(
        200,
        {
          debug: DEBUG,
          transportDefault:
            "xhttp",
          backend:
            BACKEND_URL,
        }
      );
    }

    /*
     * ------------------------------------------------
     * Build exact backend path
     * ------------------------------------------------
     */

    const backendUrl =
      buildBackendUrl(
        requestUrl
      );

    /*
     * ------------------------------------------------
     * Normal HTTP/XHTTP passthrough
     * ------------------------------------------------
     */

    if (
      !hasUpgradeRequest(
        request
      )
    ) {
      try {
        const response =
          await fetchWithTimeout(
            backendUrl.toString(),
            {
              method:
                request.method,
              headers:
                buildPassthroughHeaders(
                  request
                ),
              body:
                request.method ===
                  "GET" ||
                request.method ===
                  "HEAD"
                  ? undefined
                  : request.body,
              redirect:
                "manual",
            },
            15000
          );

        return response;
      } catch (error) {
        errorLog(
          "passthrough error",
          error
        );

        return textResponse(
          502,
          "Unable to connect to backend service."
        );
      }
    }

    /*
     * ------------------------------------------------
     * XHTTP Upgrade
     * ------------------------------------------------
     */

    let mode;
    let earlyDataHint;

    try {
      mode = parseMode(
        requestUrl,
        request
      );

      earlyDataHint =
        parseEarlyDataHint(
          requestUrl
        );
    } catch (error) {
      return textResponse(
        400,
        error instanceof Error
          ? error.message
          : "Invalid xhttp options."
      );
    }

    /*
     * Create Cloudflare-side WebSocket pair.
     */

    const socketPair =
      new WebSocketPair();

    const clientSocket =
      socketPair[0];

    const workerSocket =
      socketPair[1];

    workerSocket.accept();

    /*
     * Build backend upgrade headers.
     */

    const backendHeaders =
      buildBackendUpgradeHeaders(
        request
      );

    /*
     * Parse optional XHTTP early data.
     */

    const earlyData =
      parseEarlyData(
        request.headers.get(
          "Sec-WebSocket-Protocol"
        ),
        earlyDataHint
      );

    if (
      earlyData.errorMessage
    ) {
      closePair(
        workerSocket,
        clientSocket,
        1002,
        "Invalid early-data"
      );

      return textResponse(
        400,
        earlyData.errorMessage
      );
    }

    if (
      earlyData.shouldStripProtocolHeader
    ) {
      backendHeaders.delete(
        "Sec-WebSocket-Protocol"
      );
    }

    log(
      "dialing backend",
      {
        backendUrl:
          backendUrl.toString(),
        mode,
        earlyDataHint,
        earlyDataBytes:
          earlyData.data
            ?.byteLength ?? 0,
      }
    );

    let lastStatus =
      null;

    let lastError =
      null;

    /*
     * Backend retry loop.
     */

    for (
      let attempt = 1;
      attempt <= MAX_RETRIES;
      attempt++
    ) {
      try {
        const backendResponse =
          await fetchWithTimeout(
            backendUrl.toString(),
            {
              method: "GET",
              headers:
                backendHeaders,
              redirect:
                "manual",
            },
            15000
          );

        /*
         * Xray must accept the websocket
         * upgrade with HTTP 101.
         */

        if (
          backendResponse.status ===
            101 &&
          backendResponse.webSocket
        ) {
          const backendSocket =
            backendResponse.webSocket;

          backendSocket.accept();

          /*
           * Forward early data as first
           * websocket payload when present.
           */

          if (
            earlyData.data &&
            earlyData.data.byteLength >
              0
          ) {
            try {
              backendSocket.send(
                earlyData.data
              );
            } catch (error) {
              errorLog(
                "early-data forward error",
                error
              );

              safeClose(
                backendSocket,
                1011,
                "Failed to forward early-data"
              );

              closePair(
                workerSocket,
                clientSocket,
                1011,
                "Failed to forward early-data"
              );

              return textResponse(
                502,
                "Failed to forward xhttp early-data."
              );
            }
          }

          /*
           * Full duplex bridge:
           *
           * V2Box -> Worker -> Xray
           * Xray  -> Worker -> V2Box
           */

          bridgeSockets(
            workerSocket,
            backendSocket
          );

          return new Response(
            null,
            {
              status: 101,
              webSocket:
                clientSocket,
            }
          );
        }

        /*
         * Backend rejected upgrade.
         */

        lastStatus =
          backendResponse.status;

        try {
          await backendResponse.body?.cancel();
        } catch {}

        log(
          "backend rejected upgrade",
          {
            status:
              lastStatus,
            mode,
            attempt,
            maxAttempts:
              MAX_RETRIES,
          }
        );

        const retryable =
          lastStatus === 408 ||
          lastStatus === 429 ||
          lastStatus >= 500;

        if (
          !retryable ||
          attempt >=
            MAX_RETRIES
        ) {
          break;
        }
      } catch (error) {
        lastError =
          error;

        errorLog(
          "backend connection attempt failed",
          {
            attempt,
            maxAttempts:
              MAX_RETRIES,
            mode,
            error,
          }
        );

        if (
          attempt >=
          MAX_RETRIES
        ) {
          break;
        }
      }

      /*
       * Small exponential retry delay.
       */

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            Math.min(
              1000 *
                Math.pow(
                  2,
                  attempt - 1
                ),
              4000
            )
          )
      );
    }

    closePair(
      workerSocket,
      clientSocket,
      1011,
      "Unable to connect to backend"
    );

    if (
      lastStatus !== null
    ) {
      return textResponse(
        502,
        `Backend xhttp upgrade failed ` +
          `(status ${lastStatus}, mode ${mode}).`
      );
    }

    return textResponse(
      502,
      "Unable to connect to backend service for xhttp transport."
    );
  },
};