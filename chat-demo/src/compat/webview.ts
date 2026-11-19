// 上传和路由动画使用 allSettled，Mermaid 和它的链接校验依赖其余两项。
import 'core-js/modules/es.promise.all-settled.js'
import 'core-js/modules/web.structured-clone.js'
import 'core-js/modules/web.url.can-parse.js'

// Chromium 74 有 Fetch 的 Blob 响应体，但还没有 Blob 的读取方法。
// stream 必须保留流式读取，避免备份大文件时一次性分配整个 Blob。
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    configurable: true,
    writable: true,
    value(this: Blob) { return new Response(this).arrayBuffer() },
  })
}
if (typeof Blob.prototype.stream !== 'function') {
  Object.defineProperty(Blob.prototype, 'stream', {
    configurable: true,
    writable: true,
    value(this: Blob) { return new Response(this).body },
  })
}
