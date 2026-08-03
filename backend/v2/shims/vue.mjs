// Glue shim: replaces `vue` for server-side operation.
// APT's RateLimiter.ts + trade/common.ts ONLY use the reactivity primitives
// `shallowReactive`/`shallowRef` as plain containers (array resp. { value }).
// Headless, we don't need real reactivity — plain identity wrappers are enough.

export const shallowReactive = (x) => x
export const reactive = (x) => x
export const shallowReadonly = (x) => x
export const readonly = (x) => x
export const toRaw = (x) => x
export const markRaw = (x) => x

export const shallowRef = (value) => ({ value })
export const ref = (value) => ({ value })
export const computed = (getter) => ({ get value () { return getter() } })

export default {
  shallowReactive, reactive, shallowReadonly, readonly, toRaw, markRaw,
  shallowRef, ref, computed
}
