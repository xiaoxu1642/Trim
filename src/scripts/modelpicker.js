// modelpicker.js - 各模块「联网 AI 简介」模型选择
// 三个模块（电脑优化中心 / 启动项管理 / 右键管理）各自记录自己使用的模型，
// 改一个模块不会影响另外两个；模型本身的启用状态与接口参数统一在
// 「设置 - 大模型管理」中维护，此处只做选择。
// 弹窗样式与「设置 - 使用说明」保持一致。
(function () {
  'use strict';

  const SCOPE_META = {
    optimizer: { label: '电脑优化中心' },
    startup: { label: '启动项管理' },
    contextmenu: { label: '右键管理' },
    memoryclean: { label: '内存清理' }
  };

  let settingsCache = null;
  let openResolve = null;
  let escHandler = null;

  function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text == null ? '' : text).replace(/[&<>"']/g, m => map[m]);
  }

  async function loadSettings(force) {
    if (settingsCache && !force) return settingsCache;
    try {
      if (window.api?.settings?.load) {
        const resp = await window.api.settings.load();
        if (resp && resp.success && resp.data) {
          settingsCache = resp.data;
          return settingsCache;
        }
      }
    } catch (e) { /* 读取失败使用空配置 */ }
    settingsCache = { models: {}, aiScopes: {}, modelList: [] };
    return settingsCache;
  }

  function normalize(data) {
    const list = Array.isArray(data.modelList) && data.modelList.length
      ? data.modelList
      : [
        { key: 'baidu', label: '百度千帆·普通版', displayName: '百度千帆·普通版', kind: 'baidu_web', enabled: false, verified: false },
        { key: 'baidu_pro', label: '百度千帆·高性能版', displayName: '百度千帆·高性能版', kind: 'baidu_web_summary', enabled: false, verified: false },
        { key: 'zhihu', label: '知乎直答', displayName: '知乎直答', kind: 'openai', enabled: false, verified: false },
        { key: 'metaso', label: '秘塔 AI', displayName: '秘塔 AI', kind: 'openai', enabled: false, verified: false },
        { key: 'custom', label: '自定义模型', displayName: '自定义模型', kind: 'openai', enabled: false, verified: false }
      ];
    const scopes = data.aiScopes || {};
    return { list, scopes };
  }

  function close(changed) {
    document.getElementById('modelPickerBackdrop')?.remove();
    if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
    if (openResolve) { openResolve(changed); openResolve = null; }
  }

  // 打开模型选择弹窗；返回 Promise<boolean>，true 表示用户切换了模型
  function open(scope) {
    const scopeKey = SCOPE_META[scope] ? scope : 'contextmenu';
    const meta = SCOPE_META[scopeKey];
    close(false);
    return new Promise(resolve => {
      openResolve = resolve;
      loadSettings(true).then(data => {
        // 防重入：若期间已有同名弹窗被挂载（快速重复触发），先移除旧弹窗，避免叠加导致"点两下才能关闭"
        document.getElementById('modelPickerBackdrop')?.remove();
        const { list, scopes } = normalize(data || {});
        const current = (scopes && scopes[scopeKey]) || 'metaso';

        const backdrop = document.createElement('div');
        backdrop.className = 'usage-backdrop model-picker-backdrop';
        backdrop.id = 'modelPickerBackdrop';
        backdrop.innerHTML = `
          <div class="usage-modal model-picker-modal" role="dialog" aria-modal="true" aria-labelledby="modelPickerTitle">
            <div class="usage-header">
              <h2 id="modelPickerTitle">选择 AI 简介模型 · ${escapeHtml(meta.label)}</h2>
              <button class="usage-close" id="modelPickerClose" type="button" title="关闭" aria-label="关闭">&times;</button>
            </div>
            <div class="usage-body model-picker-body">
              <p class="model-picker-tip">
                这里只选择「${escapeHtml(meta.label)}」使用的模型，不会影响另外两个模块。
                模型是否启用、接口地址与密钥请在「设置 - 大模型管理」中维护。
              </p>
              <div class="model-picker-list">
                ${list.map(m => {
                  const stateText = m.enabled ? (m.verified ? '已启用 · 已验证' : '已启用') : '未启用';
                  const stateCls = m.enabled ? (m.verified ? 'ok' : 'warn') : 'off';
                  const unusable = !m.enabled;
                  return `
                    <label class="model-picker-item${m.key === current ? ' active' : ''}${unusable ? ' unusable' : ''}">
                      <input type="radio" name="modelPickerChoice" value="${escapeHtml(m.key)}" ${m.key === current ? 'checked' : ''} ${unusable ? 'disabled' : ''} />
                      <span class="model-picker-radio"></span>
                      <span class="model-picker-copy">
                        <span class="model-picker-name">${escapeHtml(m.displayName || m.label)}</span>
                        <span class="model-picker-desc">${escapeHtml(m.builtin ? '内置模型' : '用户自定义（OpenAI 兼容 chat/completions）')}</span>
                      </span>
                      <span class="model-picker-state ${stateCls}">${escapeHtml(stateText)}</span>
                    </label>`;
                }).join('')}
              </div>
            </div>
            <div class="usage-footer model-picker-footer">
              <button class="btn btn-secondary" id="modelPickerManage" type="button">去设置</button>
              <span class="model-picker-spacer"></span>
              <button class="btn btn-secondary" id="modelPickerCancel" type="button">取消</button>
              <button class="btn btn-primary" id="modelPickerSave" type="button">保存</button>
            </div>
          </div>
        `;
        document.body.appendChild(backdrop);

        backdrop.querySelectorAll('.model-picker-item').forEach(item => {
          item.addEventListener('click', () => {
            if (item.classList.contains('unusable')) {
              window.app?.toast('warning', '该模型尚未启用，请先到「设置 - 大模型管理」中启用并保存');
              return;
            }
            backdrop.querySelectorAll('.model-picker-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
          });
        });

        backdrop.querySelector('#modelPickerClose').addEventListener('click', () => close(false));
        backdrop.querySelector('#modelPickerCancel').addEventListener('click', () => close(false));
        backdrop.addEventListener('click', e => { if (e.target === backdrop) close(false); });
        backdrop.querySelector('#modelPickerManage').addEventListener('click', () => {
          if (window.api?.modelsWindow?.open) window.api.modelsWindow.open();
          else window.app?.toast('warning', '当前环境不支持打开大模型管理窗口');
        });

        backdrop.querySelector('#modelPickerSave').addEventListener('click', async () => {
          const checked = backdrop.querySelector('input[name="modelPickerChoice"]:checked');
          const key = checked ? checked.value : current;
          if (key === current) { close(false); return; }
          try {
            if (window.api?.models?.setScope) {
              const resp = await window.api.models.setScope(scopeKey, key);
              if (resp && resp.success) {
                window.app?.toast('success', `「${meta.label}」AI 简介模型已切换`);
                window.app?.log('info', `切换 ${meta.label} AI 简介模型: ${key}`);
                close(true);
                return;
              }
              window.app?.toast('error', (resp && resp.message) || '保存失败');
              return;
            }
            window.app?.toast('warning', '当前环境不支持保存模型选择');
          } catch (e) {
            window.app?.toast('error', '保存失败: ' + e.message);
          }
        });

        escHandler = (e) => { if (e.key === 'Escape') close(false); };
        document.addEventListener('keydown', escHandler);
      });
    });
  }

  function init() {
    const buttons = [
      ['btnOptimizerAiIntro', 'optimizer'],
      ['btnStartupAiIntro', 'startup'],
      ['btnContextAiIntro', 'contextmenu']
    ];
    buttons.forEach(([id, scope]) => {
      document.getElementById(id)?.addEventListener('click', () => open(scope));
    });
    loadSettings(false);
  }

  window.modelpicker = { init, open };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
