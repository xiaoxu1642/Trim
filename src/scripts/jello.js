// 果冻动效（Motion.Lab · jello）
// 点击时为按钮添加 .btn-jello 触发果冻抖动，动画结束后移除以便下次触发
// 范围：各页面头部操作按钮（图四红框同款：全选/扫描大小/开始清理等）、系统维护批量操作按钮
(function () {
  'use strict';

  var SELECTOR = '.page-actions .btn, .maint-batch-actions .btn';

  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion) return;

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest(SELECTOR) : null;
    if (!btn) return;
    btn.classList.remove('btn-jello');
    void btn.offsetWidth; // 强制重排，支持连续点击时重启动画
    btn.classList.add('btn-jello');
  });

  // 动画结束统一移除类，避免残留影响 hover 等变换
  document.addEventListener('animationend', function (e) {
    if (e.animationName === 'jello' && e.target.classList) {
      e.target.classList.remove('btn-jello');
    }
  });
})();
