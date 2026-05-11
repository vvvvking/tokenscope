/**
 * TokenScope — i18n.js
 *
 * Minimal string table. Callers do: t('key', lang) or t('key'|lang=undef → auto).
 */

export const STRINGS = {
  en: {
    app_name: 'TokenScope',
    tagline: 'Real-time LLM usage monitor',
    tab_today: 'Today',
    tab_live: 'Live',
    tab_history: 'History',
    tab_models: 'Models',
    col_model: 'Model',
    col_calls: 'Calls',
    col_input: 'Input',
    col_output: 'Output',
    col_total: 'Total',
    col_cost: 'Cost',
    col_time: 'Time',
    col_host: 'Host',
    col_status: 'Status',
    col_elapsed: 'Elapsed',
    empty_today: 'No LLM calls captured yet today.\nMake any request and it will appear here in real time.',
    hint_estimated: 'Estimated — provider did not return token usage',
    btn_open_panel: 'Open Side Panel',
    btn_options: 'Settings',
    btn_clear: 'Clear All Data',
    btn_export_json: 'Export JSON',
    btn_export_csv: 'Export CSV',
    btn_add_row: '+ Add row',
    btn_save: 'Save',
    btn_saved: 'Saved ✓',
    settings_title: 'TokenScope — Settings',
    sec_general: 'General',
    sec_pricing: 'Pricing (optional)',
    sec_hosts: 'Watched Hosts',
    sec_data: 'Data',
    lbl_language: 'Language',
    lbl_lang_auto: 'Auto',
    lbl_lang_zh: '中文',
    lbl_lang_en: 'English',
    lbl_show_cost: 'Show cost column (using pricing below)',
    lbl_retention: 'Max detail records to keep',
    lbl_watch_all: 'Watch all hosts',
    lbl_watch_allowlist: 'Only these hosts',
    pricing_desc: 'TokenScope never assumes prices. Add your own rates here — the cost column uses them.\nPattern supports glob wildcards, e.g. "gpt-4o*" matches any variant.',
    pricing_pattern: 'Model pattern',
    pricing_in: 'Input $ / 1M tokens',
    pricing_out: 'Output $ / 1M tokens',
    pricing_currency: 'Currency',
    confirm_clear: 'Delete ALL captured call records and aggregations? This cannot be undone.',
    streaming: 'streaming',
    non_streaming: 'non-stream',
    just_now: 'just now',
    s_ago: 's ago',
    m_ago: 'min ago',
    h_ago: 'h ago',
    active: 'Active',
    done: 'Done',
    error: 'Error',
    live_empty: 'Waiting for LLM API calls on this tab…',
    history_empty: 'No history yet.',
    panel_today_total: 'Today so far',
    panel_calls: 'calls',
    panel_tokens: 'tokens',
    footer_privacy: '100% local — nothing leaves your browser.',
    footer_source: 'Source',
    sec_proxy: 'Desktop Agent Proxy',
    proxy_desc: 'Capture token usage from desktop agents (Claude Code, Cursor, Cline, OpenClaw, Python / Node SDKs, etc.) by routing them through the local tokenscope-proxy.\nInstall:  npx tokenscope-proxy   (no config, loopback only)\nThen point your tool at  http://127.0.0.1:17666  and enable the switch below.',
    lbl_proxy_enabled: 'Connect to local tokenscope-proxy',
    lbl_proxy_url: 'Proxy WebSocket URL',
    lbl_proxy_status: 'Status',
    btn_test_connection: 'Test',
    proxy_testing: 'Testing…',
    proxy_test_ok:  'Reachable ✓',
    proxy_test_fail:'Not reachable',
    proxy_state_open:       'Connected',
    proxy_state_connecting: 'Connecting…',
    proxy_state_closed:     'Disconnected',
    proxy_state_error:      'Error',
    proxy_state_unknown:    'Unknown'
  },

  zh: {
    app_name: 'TokenScope',
    tagline: '实时大模型用量监控',
    tab_today: '今日',
    tab_live: '实时',
    tab_history: '历史',
    tab_models: '模型',
    col_model: '模型',
    col_calls: '次数',
    col_input: '输入',
    col_output: '输出',
    col_total: '总计',
    col_cost: '费用',
    col_time: '时间',
    col_host: '来源',
    col_status: '状态',
    col_elapsed: '耗时',
    empty_today: '今天还没有捕获到任何大模型调用。\n像平时一样去用 ChatGPT / Claude / 自部署模型，这里会实时出现。',
    hint_estimated: '估算值 — 该服务未返回真实 token 数',
    btn_open_panel: '打开侧边栏',
    btn_options: '设置',
    btn_clear: '清空所有数据',
    btn_export_json: '导出 JSON',
    btn_export_csv: '导出 CSV',
    btn_add_row: '+ 新增一行',
    btn_save: '保存',
    btn_saved: '已保存 ✓',
    settings_title: 'TokenScope — 设置',
    sec_general: '通用',
    sec_pricing: '单价（可选）',
    sec_hosts: '监听站点',
    sec_data: '数据',
    lbl_language: '界面语言',
    lbl_lang_auto: '自动',
    lbl_lang_zh: '中文',
    lbl_lang_en: 'English',
    lbl_show_cost: '显示费用列（按下方单价计算）',
    lbl_retention: '最多保留调用明细条数',
    lbl_watch_all: '监听全部站点',
    lbl_watch_allowlist: '仅监听以下站点',
    pricing_desc: 'TokenScope 不内置任何价格表。你自己填入单价，费用列据此计算。\n模式支持通配符，例如 "gpt-4o*" 会匹配所有 gpt-4o 变体。',
    pricing_pattern: '模型匹配模式',
    pricing_in: '输入 $ / 1M token',
    pricing_out: '输出 $ / 1M token',
    pricing_currency: '币种',
    confirm_clear: '确认删除所有调用记录和统计？此操作不可撤销。',
    streaming: '流式',
    non_streaming: '非流式',
    just_now: '刚刚',
    s_ago: '秒前',
    m_ago: '分钟前',
    h_ago: '小时前',
    active: '进行中',
    done: '完成',
    error: '出错',
    live_empty: '正在等待本页面的大模型 API 调用……',
    history_empty: '暂无历史记录。',
    panel_today_total: '今日累计',
    panel_calls: '次调用',
    panel_tokens: 'tokens',
    footer_privacy: '100% 本地 — 数据不会离开你的浏览器。',
    footer_source: '源码',
    sec_proxy: '桌面端 Agent 代理',
    proxy_desc: '通过本地 tokenscope-proxy 捕获桌面端 Agent（Claude Code / Cursor / Cline / OpenClaw / Python·Node SDK 等）的 token 用量。\n安装：npx tokenscope-proxy （零配置，仅监听 127.0.0.1）\n随后把你的工具 BASE_URL 改为 http://127.0.0.1:17666，并勾选下方开关即可。',
    lbl_proxy_enabled: '连接到本地 tokenscope-proxy',
    lbl_proxy_url: '代理 WebSocket 地址',
    lbl_proxy_status: '连接状态',
    btn_test_connection: '测试连接',
    proxy_testing: '测试中…',
    proxy_test_ok:  '可访问 ✓',
    proxy_test_fail:'无法访问',
    proxy_state_open:       '已连接',
    proxy_state_connecting: '连接中…',
    proxy_state_closed:     '未连接',
    proxy_state_error:      '连接出错',
    proxy_state_unknown:    '未知'
  }
};

export function resolveLang(pref) {
  if (pref === 'zh' || pref === 'en') return pref;
  const nav = (navigator.language || 'en').toLowerCase();
  return nav.startsWith('zh') ? 'zh' : 'en';
}

export function t(key, lang) {
  const L = resolveLang(lang);
  const row = STRINGS[L] || STRINGS.en;
  return row[key] != null ? row[key] : (STRINGS.en[key] || key);
}

export function applyI18n(root, lang) {
  const L = resolveLang(lang);
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.getAttribute('data-i18n');
    el.textContent = t(k, L);
  });
  root.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const k = el.getAttribute('data-i18n-ph');
    el.setAttribute('placeholder', t(k, L));
  });
  root.querySelectorAll('[data-i18n-title]').forEach(el => {
    const k = el.getAttribute('data-i18n-title');
    el.setAttribute('title', t(k, L));
  });
  root.setAttribute('lang', L);
}

export function fmtAgo(ts, lang) {
  const L = resolveLang(lang);
  const delta = Math.max(0, Date.now() - ts);
  if (delta < 10_000) return t('just_now', L);
  if (delta < 60_000) return Math.floor(delta/1000) + ' ' + t('s_ago', L);
  if (delta < 3600_000) return Math.floor(delta/60000) + ' ' + t('m_ago', L);
  return Math.floor(delta/3600000) + ' ' + t('h_ago', L);
}
