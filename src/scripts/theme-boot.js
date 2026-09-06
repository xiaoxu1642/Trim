// theme-boot.js - 首帧前同步主题（原 index.html 内联脚本）
// 原 内联写法被 CSP（script-src 'self'）拦截，主题引导从未生效；
// 改为外部文件后在解析时同步执行，效果不变：在首个可见帧前应用
// 已保存主题或系统主题，避免浅色系统先闪出深色（与启动黑闪优化配套）。
(function () {
  try {
    const stored = localStorage.getItem('winclean-theme') || 'auto';
    const resolved = stored === 'auto'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : stored;
    document.body.className = 'theme-' + (resolved === 'light' ? 'light' : 'dark');
  } catch (_) {}
})();
