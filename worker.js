const TARGET = "https://brad.cdnconnect.site:8443";

export default {
  async fetch(request, env, ctx) {
    const incoming = new URL(request.url);

    // ------------------------------------------
    // Health check
    // ------------------------------------------
    if (incoming.pathname === "/health" && request.method === "GET") {
      return new Response("Worker OK", {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    // ------------------------------------------
    // Build origin URL
    // Preserve exact XHTTP path and query
    // ------------------------------------------
    const target = new URL(TARGET);

    target.pathname = incoming.pathname;
    target.search = incoming.search;

    // ------------------------------------------
    // Detect WebSocket / XHTTP upgrade
    // ------------------------------------------
    const upgrade = request.headers.get("Upgrade");
    const connection =
      request.headers.get("Connection")?.toLowerCase() || "";

    const isUpgrade =
      upgrade &&
      connection.includes("upgrade") &&
      upgrade.toLowerCase() === "websocket";

    // ------------------------------------------
    // XHTTP upgrade
    // ------------------------------------------
    if (isUpgrade) {
      const clientPair = new WebSocketPair();

      const clientSocket = clientPair[0];
      const workerSocket = clientPair[1];

      workerSocket.accept();

      // Copy incoming headers
      const headers = new Headers(request.headers);

      // Worker must create the backend upgrade itself
      headers.delete("Host");

      headers.set("Connection", "Upgrade");
      headers.set("Upgrade", "websocket");

      // Cloudflare/client websocket extensions must not
      // be forwarded blindly to Xray.
      headers.delete("Sec-WebSocket-Extensions");

      // Keep Sec-WebSocket-Protocol because VLESS/XHTTP
      // clients may use it for negotiation / early data.
      const protocol = request.headers.get(
        "Sec-WebSocket-Protocol"
      );

      if (protocol) {
        headers.set("Sec-WebSocket-Protocol", protocol);
      }

      let backendResponse;

      try {
        backendResponse = await fetch(target.toString(), {
          method: "GET",
          headers,
          redirect: "manual",
        });
      } catch (err) {
        try {
          workerSocket.close(1011, "Backend connection failed");
        } catch {}

        return new Response(
          "Backend connection failed: " +
            (err?.message || String(err)),
          {
            status: 502,
          }
        );
      }

      // ------------------------------------------
      // Backend must return HTTP 101
      // ------------------------------------------
      if (
        backendResponse.status !== 101 ||
        !backendResponse.webSocket
      ) {
        let body = "";

        try {
          body = await backendResponse.text();
        } catch {}

        try {
          workerSocket.close(
            1011,
            "Backend rejected XHTTP upgrade"
          );
        } catch {}

        return new Response(
          "Backend XHTTP upgrade failed: HTTP " +
            backendResponse.status +
            (body ? "\n" + body.slice(0, 500) : ""),
          {
            status: 502,
          }
        );
      }

      const backendSocket = backendResponse.webSocket;

      backendSocket.accept();

      // ------------------------------------------
      // Bridge client <-> Xray
      // ------------------------------------------

      let closed = false;

      const closeBoth = (code = 1011, reason = "Closed") => {
        if (closed) return;

        closed = true;

        try {
          workerSocket.close(code, reason);
        } catch {}

        try {
          backendSocket.close(code, reason);
        } catch {}
      };

      const sendToBackend = async (data) => {
        if (closed) return;

        try {
          if (data instanceof Blob) {
            data = await data.arrayBuffer();
          }

          if (backendSocket.readyState === 1) {
            backendSocket.send(data);
          }
        } catch {
          closeBoth(1011, "Client to backend relay failed");
        }
      };

      const sendToClient = async (data) => {
        if (closed) return;

        try {
          if (data instanceof Blob) {
            data = await data.arrayBuffer();
          }

          if (workerSocket.readyState === 1) {
            workerSocket.send(data);
          }
        } catch {
          closeBoth(1011, "Backend to client relay failed");
        }
      };

      workerSocket.addEventListener("message", (event) => {
        ctx.waitUntil(sendToBackend(event.data));
      });

      backendSocket.addEventListener("message", (event) => {
        ctx.waitUntil(sendToClient(event.data));
      });

      workerSocket.addEventListener("close", (event) => {
        closeBoth(
          event.code || 1000,
          event.reason || "Client closed"
        );
      });

      backendSocket.addEventListener("close", (event) => {
        closeBoth(
          event.code || 1000,
          event.reason || "Backend closed"
        );
      });

      workerSocket.addEventListener("error", () => {
        closeBoth(1011, "Client socket error");
      });

      backendSocket.addEventListener("error", () => {
        closeBoth(1011, "Backend socket error");
      });

      return new Response(null, {
        status: 101,
        webSocket: clientSocket,
      });
    }

    // ------------------------------------------
    // Normal HTTP/XHTTP request
    // ------------------------------------------

    const headers = new Headers(request.headers);

    // Let fetch generate the correct Host for:
    // brad.cdnconnect.site:8443
    headers.delete("Host");

    // Do not forward Cloudflare-specific client IP headers
    headers.delete("cf-connecting-ip");
    headers.delete("x-forwarded-for");
    headers.delete("x-real-ip");

    // These are only relevant to websocket upgrade
    headers.delete("Connection");
    headers.delete("Upgrade");

    try {
      const response = await fetch(target.toString(), {
        method: request.method,
        headers,
        body:
          request.method === "GET" ||
          request.method === "HEAD"
            ? undefined
            : request.body,
        redirect: "manual",
      });

      return response;
    } catch (err) {
      return new Response(
        "Origin error: " +
          (err?.message || String(err)),
        {
          status: 502,
        }
      );
    }
  },
};