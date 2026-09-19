import { GatewayError } from "./http";

/** Own the network stream so timeout and client cancellation live until EOF. */
export async function fetchUpstream(
  url: string,
  init: RequestInit,
  clientSignal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  const abort = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => abort.abort(clientSignal.reason);
  const clean = () => {
    clearTimeout(timer);
    clientSignal.removeEventListener("abort", cancel);
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      abort.abort(new Error("Upstream idle timeout"));
    }, timeoutMs);
  };
  const failure = () => clientSignal.aborted
    ? new GatewayError(499, "client_cancelled", "Client cancelled the request")
    : timedOut
      ? new GatewayError(504, "upstream_timeout", `Upstream was idle for ${timeoutMs} ms`)
      : new GatewayError(502, "upstream_unavailable", "Could not read a response from the upstream");

  if (clientSignal.aborted) cancel();
  else clientSignal.addEventListener("abort", cancel, { once: true });
  arm();
  try {
    const response = await fetch(url, { ...init, redirect: "manual", signal: abort.signal });
    if (!response.body) {
      clean();
      return response;
    }
    reader = response.body.getReader();
    const source = reader;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (abort.signal.aborted) throw failure();
          arm();
          const next = await source.read();
          if (next.done) {
            clean();
            source.releaseLock();
            controller.close();
          } else {
            // No idle timer while downstream backpressure prevents another read.
            clearTimeout(timer);
            controller.enqueue(next.value);
          }
        } catch {
          clean();
          controller.error(failure());
          await source.cancel().catch(() => undefined);
        }
      },
      async cancel(reason) {
        clean();
        abort.abort(reason);
        await source.cancel(reason).catch(() => undefined);
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch {
    clean();
    if (reader) await reader.cancel().catch(() => undefined);
    throw failure();
  }
}
