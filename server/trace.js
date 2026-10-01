/**
 * Optional Langfuse tracing.
 *
 * Tracing is off unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set, and
 * the OpenTelemetry packages are imported lazily so that an ordinary install
 * neither loads them nor opens a socket. Bitrate is a local-first tool that
 * binds to loopback and works with no account anywhere, and that has to stay
 * true: adding observability must not turn it into something that phones home.
 *
 * Langfuse's span type is explicitly meant for non-LLM operations, so this is
 * the appropriate tool rather than a workaround. One trace is one download, and
 * the steps inside it are the things that actually vary: how the source was
 * resolved, whether the size came back, and how the bytes were fetched.
 *
 * Names are verb-first and stable, because Langfuse dashboards and evaluators
 * reference them as if they were an API. Anything run-specific goes in metadata.
 */

const state = {
  enabled: false,
  startActiveObservation: null,
  startObservation: null,
  processor: null,
  sdk: null,
  reason: 'not initialised',
};

export const tracingStatus = () => ({ enabled: state.enabled, reason: state.reason });

/** Where traces are labelled. Tests default to a separate environment. */
const environment = () => process.env.LANGFUSE_ENVIRONMENT || 'development';

/**
 * Load the SDK and wire a span processor that exports to Langfuse.
 *
 * Returns false rather than throwing when tracing cannot start. A broken
 * observability layer should never be the reason a download fails.
 */
export async function initTracing() {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    state.reason = 'LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are not both set';
    return false;
  }

  try {
    const [sdkMod, otelMod, tracingMod] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@langfuse/otel'),
      import('@langfuse/tracing'),
    ]);

    const processor = new otelMod.LangfuseSpanProcessor();
    const sdk = new sdkMod.NodeSDK({ spanProcessors: [processor] });
    sdk.start();

    state.sdk = sdk;
    state.processor = processor;
    state.startActiveObservation = tracingMod.startActiveObservation;
    state.startObservation = tracingMod.startObservation;
    state.enabled = true;
    state.reason = 'enabled';
    return true;
  } catch (err) {
    state.reason = `unavailable: ${err.message}`;
    return false;
  }
}

/**
 * Run `fn` inside a named observation.
 *
 * With tracing off this is a direct call, so instrumented code costs one
 * function call and a boolean check. `fn` receives the span, which it may
 * ignore, and may report intermediate detail with `span.update`.
 *
 * `output` may be a value or a function of the step's return value, for when the
 * interesting part of a result is a summary rather than the value itself.
 */
export async function withSpan(name, fn, {
  input,
  output,
  metadata,
  tags,
  asType,
  level,
  env = environment(),
} = {}) {
  if (!state.enabled) return fn(null);

  // Only asType is read from the options bag. Input, metadata and environment
  // are not: they are applied through span.update below, because the
  // observation type is all the options carry.
  return state.startActiveObservation(name, async (span) => {
    try {
      // Langfuse has no per-observation tag field, so the dimensions worth
      // filtering on go in metadata, which the UI can filter just as well.
      const initial = {};
      if (input !== undefined) initial.input = input;
      if (metadata) initial.metadata = { ...metadata };
      if (tags?.length) initial.metadata = { ...(initial.metadata || {}), tags: [...tags] };
      if (env) initial.environment = env;
      if (Object.keys(initial).length) span.update(initial);

      const result = await fn(span);
      // An explicit output wins, otherwise whatever the step returned is the
      // most useful thing to record. A function is treated as a transform over
      // that result, so a step can report a summary instead of its raw return
      // value, which is often an internal handle nobody else should see.
      const resolved = typeof output === 'function' ? output(result) : output !== undefined ? output : result;
      span.update({ output: resolved === undefined ? null : resolved });
      // Severity is usually only knowable once the work has finished, so it is
      // resolved the same lazy way.
      if (level !== undefined) {
        span.update({ level: typeof level === 'function' ? level(result) : level });
      }
      return result;
    } catch (err) {
      span.update({
        level: 'ERROR',
        statusMessage: err.message,
        output: { error: err.message },
      });
      throw err;
    }
  }, { asType: asType || 'span' });
}

/** Convenience for a leaf step with no meaningful return value. */
export const step = (name, fn, opts) => withSpan(name, fn, opts);

/**
 * Open a span that outlives the function that started it.
 *
 * withSpan is for work you await. A download is not like that: the engine
 * starts a child process and returns immediately, so a span wrapped around the
 * start would close before any bytes moved and record an empty outcome.
 *
 * The returned `release` is what ends the span. Until it is called the callback
 * stays suspended, which is what keeps the observation current: the context
 * manager binds the active context to the inside of that callback, so whatever
 * `start` launches from there carries it, and the engines' own spans nest
 * underneath instead of dangling at the trace root.
 *
 * That is the whole reason this exists rather than a plain startObservation,
 * which produces a flat tree. It also means `start` must be called from here
 * and not from the caller afterwards: the caller's own context is a different
 * one, and work it starts would not be part of this trace.
 *
 * Synchronous on purpose. initTracing has already run by the time any job
 * starts, and making this async would leave a gap between a job being queued
 * and its cancellation handle existing.
 *
 * Returns null when tracing is off, so callers can hold it unconditionally.
 */
export function startSpan(name, options, start) {
  if (!state.enabled) {
    // Same work, same order, no trace.
    const handle = start();
    return { handle, closed: Promise.resolve(), release: () => {} };
  }

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // withSpan's callback runs synchronously as far as the launch is concerned,
  // so this is populated before startSpan returns.
  const handleRef = { value: null };

  // output and level are forwarded as functions so withSpan evaluates them
  // when the gate resolves, which is the only moment the outcome is known.
  const closed = withSpan(name, async () => {
    handleRef.value = start();
    await gate;
    return handleRef.value;
  }, options);

  return {
    closed,
    release,
    get handle() { return handleRef.value; },
  };
}

/**
 * Push buffered spans out without tearing tracing down.
 *
 * Exporter batching means a span is not sent the moment it ends, so anything
 * that reads traces shortly after the work finished has to ask for a flush
 * first. Cheap, and it leaves tracing alive for the next download.
 */
export async function flushTracing() {
  if (!state.processor) return false;
  try {
    await state.processor.forceFlush();
    return true;
  } catch (err) {
    console.error('[trace] flush failed:', err.message);
    return false;
  }
}

/**
 * Flush and stop. Required before a short-lived process exits, otherwise
 * buffered spans are lost, which is exactly the case for the eval runner and
 * the CLI.
 */
export async function shutdownTracing() {
  if (!state.sdk) return;
  const sdk = state.sdk;
  state.sdk = null;
  state.processor = null;
  state.startActiveObservation = null;
  state.startObservation = null;
  state.enabled = false;
  try {
    await sdk.shutdown();
  } catch (err) {
    console.error('[trace] shutdown failed:', err.message);
  }
}
