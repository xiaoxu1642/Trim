// theme-boot.js - 首帧前应用浅色主题（v2.1：应用恒浅色，不再读取保存主题或系统主题）
// 原 内联写法被 CSP（script-src 'self'）拦截，主题引导从未生效；
// 改为外部文件后在解析时同步执行，在首个可见帧前挂好 theme-light，避免启动闪色。
(function () {
  try {
    document.body.className = 'theme-light';
  } catch (_) {}
})();
