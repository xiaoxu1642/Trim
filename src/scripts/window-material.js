// window-material.js - 子窗口材质 / 主题同步（大模型管理 · 外设优化 · 应用进程管理）
// 主窗口的同类逻辑在 theme.js；子窗口不加载 theme.js，这里补齐最小集：
//   1. 恒浅色：给 body 挂 theme-light（v2.1 应用固定浅色，不再跟随系统主题）
//   2. 按外观设置挂 electron-mica + data-material，让原生 Mica/亚克力透过半透明表面可见
//      （材质切换由主进程广播 appearance:material-changed，实时跟随主窗口设置）
// 预览窗（preview-window.html）刻意不加载本文件：看图对比场景保持纯黑底。
(function () {
  'use strict';

  var IS_ELECTRON = !!window.api?.app;

  function applyTheme() {
    document.body.classList.remove('theme-dark');
    document.body.classList.add('theme-light');
  }

  // material='none' 或系统不支持 DWM 材质时移除透明化类，回落不透明 CSS 表面
  function applyMaterial(material, micaEnabled) {
    if (micaEnabled && material && material !== 'none') {
      document.body.classList.add('electron-mica');
      document.body.dataset.material = material;
    } else {
      document.body.classList.remove('electron-mica');
      delete document.body.dataset.material;
    }
  }

  function init() {
    applyTheme();
    if (!IS_ELECTRON) {
      return;
    }
    Promise.all([
      window.api.app.getInfo().catch(function () { return null; }),
      window.api.appearance?.getMaterial?.().catch(function () { return null; })
    ]).then(function (results) {
      var info = results[0];
      var mat = results[1];
      var micaEnabled = !!(info && info.micaEnabled);
      // 材质总开关关闭时按「无材质」回落（窗口界面升级3）
      var effectiveMaterial = (mat && mat.materialEnabled === false) ? 'none' : (mat && mat.material);
      applyMaterial(effectiveMaterial, micaEnabled);
    });

    // 主进程广播：材质变化实时跟随（主窗设置页切换材质时子窗即时生效）
    window.api.appearance?.onMaterialChanged?.(function (material) {
      applyMaterial(material, true);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
