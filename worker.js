export default {
 async fetch(request, env) {
   const TARGET = (env.TARGET_DOMAIN || "").replace(/\/$/, "");

   if (!TARGET) {
     return new Response("Missing TARGET_DOMAIN", { status: 500 });
   }

   const url = new URL(request.url);
   const targetUrl = TARGET + url.pathname + url.search;

   const newHeaders = new Headers(request.headers);
   newHeaders.set("host", new URL(TARGET).hostname);
   newHeaders.delete("cf-connecting-ip");
   newHeaders.delete("x-forwarded-for");
   newHeaders.delete("x-real-ip");

   return fetch(targetUrl, {
     method: request.method,
     headers: newHeaders,
     body: request.method === "GET" || request.method === "HEAD"
       ? undefined
       : request.body,
   });
 }
};
