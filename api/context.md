# Context primitives

Slim vendored subset of chord's async-context library. Used internally for cancellation-safe execution; exported for hosts that build on the same vocabulary.

## `Context` and `ContextKey`

```typescript
import { Context, createContextKey, withContextValue } from "pico-agent";

const requestKey = createContextKey<{ id: string }>("request");

const ctx = Context.background();
const requestCtx = withContextValue(ctx, requestKey, { id: "req-42" });
const value = requestCtx.get(requestKey);   // { id: "req-42" } | undefined
```

Keys are typed and unique per `createContextKey` call — no string-typed globals.

## Cancellation binding

```typescript
import { withAbortSignal, withoutAbortSignal } from "pico-agent";

const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

const cancellable = withAbortSignal(ctx, controller.signal);
const detached = withoutAbortSignal(cancellable);   // same values, no cancellation
```

## `withCancel` — manual cancellation

```typescript
import { withCancel } from "pico-agent";

const [ctx, cancel] = withCancel(Context.background());
// ...hand ctx to async work...
cancel();   // everything bound to ctx is signalled
```

## `awaitWithContext` — restore context across awaits

```typescript
import { awaitWithContext } from "pico-agent";

const result = await awaitWithContext(requestCtx, doAsyncWork());  // work observes requestCtx
```

## Predefined contexts

```typescript
import { BACKGROUND_CONTEXT, TODO_CONTEXT } from "pico-agent";
```

`BACKGROUND_CONTEXT` for detached work (survives request cancellation), `TODO_CONTEXT` for placeholders in scaffolding.
