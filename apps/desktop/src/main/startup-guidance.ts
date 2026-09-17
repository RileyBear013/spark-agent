export type StartupGuidanceLocale = 'zh-CN' | 'en'
export type StartupGuidanceStage = 'backup' | 'migration' | 'launch'

export interface StartupGuidanceUpdate {
  stage: StartupGuidanceStage
  backupPercent?: number
  migrationCurrent?: number
  migrationTotal?: number
  migrationName?: string
}

type StartupGuidanceOptions = {
  locale: StartupGuidanceLocale
  version: string
  migrationTotal?: number
  preflightFallback?: boolean
}

const COPY: Record<
  StartupGuidanceLocale,
  {
    title: string
    subtitle: string
    fallbackSubtitle: string
    backup: string
    migration: string
    launch: string
    backupDetail: string
    migrationDetail: string
    launchDetail: string
  }
> = {
  'zh-CN': {
    title: '正在升级本地数据',
    subtitle: '仅在数据结构需要更新时运行，完成前请勿退出 SparkWork。',
    fallbackSubtitle: '正在检查并保护现有数据，完成前请勿退出 SparkWork。',
    backup: '创建升级恢复点',
    migration: '升级本地数据',
    launch: '启动 SparkWork',
    backupDetail: '正在安全备份',
    migrationDetail: '正在执行第 {current}/{total} 项',
    launchDetail: '数据升级完成，正在打开应用',
  },
  en: {
    title: 'Updating local data',
    subtitle: 'This only runs when the data structure needs an update. Keep SparkWork open.',
    fallbackSubtitle: 'Checking and protecting existing data. Keep SparkWork open.',
    backup: 'Create recovery point',
    migration: 'Update local data',
    launch: 'Start SparkWork',
    backupDetail: 'Creating a safe backup',
    migrationDetail: 'Running update {current} of {total}',
    launchDetail: 'Data update complete. Opening SparkWork',
  },
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * 独立于业务 renderer 的数据库升级页。
 *
 * 页面只在确认存在待执行 migration（或预检查失败需走保守路径）时创建。备份阶段
 * 展示 SQLite Online Backup 的真实页数百分比；migration 仅展示第 N/M 项，单条 SQL
 * 内部没有可信进度时使用活动态，避免伪造百分比。
 */
export function buildStartupGuidanceDataUrl(options: StartupGuidanceOptions): string {
  const copy = COPY[options.locale]
  const version = escapeHtml(options.version)
  const subtitle = options.preflightFallback ? copy.fallbackSubtitle : copy.subtitle
  const migrationTotal = Math.max(0, Math.floor(options.migrationTotal ?? 0))
  const copyJson = JSON.stringify({
    backup: copy.backup,
    migration: copy.migration,
    launch: copy.launch,
    backupDetail: copy.backupDetail,
    migrationDetail: copy.migrationDetail,
    launchDetail: copy.launchDetail,
  })
  const html = `<!doctype html>
<html lang="${options.locale}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
  <title>${copy.title}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body {
      display: grid;
      place-items: center;
      background: #f5f6f8;
      color: #17191c;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      -webkit-app-region: drag;
      -webkit-font-smoothing: antialiased;
      user-select: none;
    }
    main { width: min(78vw, 380px); }
    h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: -0.02em; }
    .subtitle { max-width: 350px; margin: 8px 0 24px; color: #686f79; font-size: 13px; line-height: 1.55; }
    .steps { display: grid; gap: 13px; margin: 0; padding: 0; list-style: none; }
    .step {
      display: grid;
      grid-template-columns: 16px minmax(0, 1fr) auto;
      align-items: center;
      min-height: 22px;
      color: #8a919b;
      font-size: 13px;
      line-height: 1.4;
    }
    .step-dot {
      width: 8px;
      height: 8px;
      border: 1px solid #adb3bc;
      border-radius: 50%;
    }
    .step.active { color: #2e333a; font-weight: 600; }
    .step.active .step-dot { border-color: #258f83; background: #258f83; }
    .step.complete { color: #59616c; }
    .step.complete .step-dot { border-color: #258f83; background: #258f83; opacity: 0.55; }
    .step-meta { margin-left: 12px; color: #686f79; font-size: 12px; font-weight: 500; }
    .progress {
      position: relative;
      height: 3px;
      margin-top: 22px;
      overflow: hidden;
      border-radius: 2px;
      background: #d9dde3;
    }
    .progress-fill {
      width: 0;
      height: 100%;
      border-radius: inherit;
      background: #258f83;
      transition: width 160ms ease-out;
    }
    .progress.indeterminate .progress-fill {
      width: 38%;
      animation: loading 1.2s ease-in-out infinite;
    }
    .detail { min-height: 20px; margin: 10px 0 0; color: #4f5661; font-size: 12px; line-height: 1.5; }
    .version { position: fixed; right: 18px; bottom: 14px; color: #8a919b; font-size: 11px; }
    @keyframes loading {
      0% { transform: translateX(-115%); }
      55%, 100% { transform: translateX(300%); }
    }
    @media (prefers-color-scheme: dark) {
      body { background: #181a1d; color: #f2f3f5; }
      .subtitle, .step-meta { color: #9ba2ac; }
      .step { color: #747b85; }
      .step.active { color: #e0e3e7; }
      .step.complete { color: #aeb4bd; }
      .step-dot { border-color: #5d646e; }
      .step.active .step-dot, .step.complete .step-dot { border-color: #46b8aa; background: #46b8aa; }
      .progress { background: #383c42; }
      .progress-fill { background: #46b8aa; }
      .detail { color: #aeb4bd; }
      .version { color: #747b85; }
    }
    @media (prefers-reduced-motion: reduce) {
      .progress-fill { transition: none; }
      .progress.indeterminate .progress-fill { width: 100%; animation: none; opacity: 0.55; }
    }
  </style>
</head>
<body>
  <main role="status" aria-live="polite" aria-atomic="true">
    <h1>${copy.title}</h1>
    <p class="subtitle">${subtitle}</p>
    <ol class="steps">
      <li class="step active" data-stage="backup"><span class="step-dot"></span><span>${copy.backup}</span><span class="step-meta" data-meta="backup">0%</span></li>
      <li class="step" data-stage="migration"><span class="step-dot"></span><span>${copy.migration}</span><span class="step-meta" data-meta="migration">${migrationTotal > 0 ? `0/${migrationTotal}` : ''}</span></li>
      <li class="step" data-stage="launch"><span class="step-dot"></span><span>${copy.launch}</span><span class="step-meta" data-meta="launch"></span></li>
    </ol>
    <div id="progress" class="progress" role="progressbar" aria-label="${copy.backup}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="progress-fill"></div></div>
    <p id="detail" class="detail">${copy.backupDetail} · 0%</p>
  </main>
  <span class="version">v${version}</span>
  <script>
    const copy = ${copyJson}
    const stageOrder = ['backup', 'migration', 'launch']
    const progress = document.getElementById('progress')
    const progressFill = progress.querySelector('.progress-fill')
    const detail = document.getElementById('detail')
    const clampPercent = (value) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)))
    window.__sparkUpdateStartupGuidance = (update) => {
      const activeIndex = stageOrder.indexOf(update.stage)
      document.querySelectorAll('.step').forEach((element) => {
        const index = stageOrder.indexOf(element.dataset.stage)
        element.classList.toggle('complete', index < activeIndex)
        element.classList.toggle('active', index === activeIndex)
      })

      if (update.stage === 'backup') {
        const percent = clampPercent(update.backupPercent)
        progress.classList.remove('indeterminate')
        progressFill.style.width = percent + '%'
        progress.setAttribute('aria-label', copy.backup)
        progress.setAttribute('aria-valuenow', String(percent))
        document.querySelector('[data-meta="backup"]').textContent = percent + '%'
        detail.textContent = copy.backupDetail + ' · ' + percent + '%'
        return
      }

      document.querySelector('[data-meta="backup"]').textContent = '100%'
      if (update.stage === 'migration') {
        const current = Math.max(1, Math.floor(Number(update.migrationCurrent) || 1))
        const total = Math.max(current, Math.floor(Number(update.migrationTotal) || current))
        progress.classList.add('indeterminate')
        progress.setAttribute('aria-label', copy.migration)
        progress.removeAttribute('aria-valuenow')
        document.querySelector('[data-meta="migration"]').textContent = current + '/' + total
        const summary = copy.migrationDetail.replace('{current}', String(current)).replace('{total}', String(total))
        detail.textContent = update.migrationName ? summary + ' · ' + update.migrationName : summary
        return
      }

      progress.classList.remove('indeterminate')
      progressFill.style.width = '100%'
      progress.setAttribute('aria-label', copy.launch)
      progress.setAttribute('aria-valuenow', '100')
      detail.textContent = copy.launchDetail
    }
  </script>
</body>
</html>`

  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`
}

export function resolveStartupGuidanceLocale(locale: string): StartupGuidanceLocale {
  return locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}
