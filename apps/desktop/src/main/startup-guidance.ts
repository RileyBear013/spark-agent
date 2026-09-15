const DEFAULT_SLOW_HINT_DELAY_MS = 1_500

type StartupGuidanceLocale = 'zh-CN' | 'en'

type StartupGuidanceOptions = {
  locale: StartupGuidanceLocale
  version: string
  slowHintDelayMs?: number
}

const COPY: Record<
  StartupGuidanceLocale,
  {
    title: string
    starting: string
    optimizing: string
    patience: string
  }
> = {
  'zh-CN': {
    title: 'SparkWork 启动中',
    starting: '正在启动 SparkWork…',
    optimizing: '启动时间较长，可能正在优化本地数据',
    patience: '首次升级预计约 20 秒，完成前请勿退出应用。',
  },
  en: {
    title: 'SparkWork is starting',
    starting: 'Starting SparkWork…',
    optimizing: 'A longer startup may mean local data is being optimized',
    patience: 'The first upgrade may take about 20 seconds. Please keep SparkWork open.',
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
 * 独立于业务 renderer 的轻量启动页。
 *
 * 数据库 migration 会同步占用主进程；本页运行在 renderer 进程中，因此即使主进程
 * 暂时繁忙，进度动画和延迟提示仍可正常显示。超过阈值后才展示首次升级说明，避免
 * 普通快速启动出现不必要的警告。
 */
export function buildStartupGuidanceDataUrl(options: StartupGuidanceOptions): string {
  const copy = COPY[options.locale]
  const version = escapeHtml(options.version)
  const slowHintDelayMs = Math.max(0, options.slowHintDelayMs ?? DEFAULT_SLOW_HINT_DELAY_MS)
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
      -webkit-font-smoothing: antialiased;
      user-select: none;
    }
    main { width: min(78vw, 360px); text-align: center; }
    .brand { margin: 0; font-size: 24px; font-weight: 650; letter-spacing: -0.025em; }
    .progress {
      position: relative;
      width: 176px;
      height: 3px;
      margin: 24px auto 18px;
      overflow: hidden;
      border-radius: 2px;
      background: #d9dde3;
    }
    .progress::after {
      position: absolute;
      inset: 0 auto 0 0;
      width: 42%;
      border-radius: inherit;
      background: #258f83;
      content: "";
      animation: loading 1.2s ease-in-out infinite;
    }
    .starting { margin: 0; color: #4f5661; font-size: 14px; line-height: 1.5; }
    .slow-hint {
      min-height: 52px;
      margin-top: 14px;
      opacity: 0;
      transform: translateY(4px);
      transition: opacity 180ms ease-out, transform 180ms ease-out;
    }
    .slow-hint.visible { opacity: 1; transform: translateY(0); }
    .slow-title { margin: 0; color: #2e333a; font-size: 14px; font-weight: 600; line-height: 1.5; }
    .slow-copy { margin: 4px 0 0; color: #686f79; font-size: 12px; line-height: 1.55; }
    .version { position: fixed; right: 18px; bottom: 14px; color: #8a919b; font-size: 11px; }
    @keyframes loading {
      0% { transform: translateX(-115%); }
      55%, 100% { transform: translateX(340%); }
    }
    @media (prefers-color-scheme: dark) {
      body { background: #181a1d; color: #f2f3f5; }
      .progress { background: #383c42; }
      .progress::after { background: #46b8aa; }
      .starting { color: #aeb4bd; }
      .slow-title { color: #e0e3e7; }
      .slow-copy { color: #9ba2ac; }
      .version { color: #747b85; }
    }
    @media (prefers-reduced-motion: reduce) {
      .progress::after { width: 100%; animation: none; }
      .slow-hint { transform: none; transition: none; }
    }
  </style>
</head>
<body>
  <main role="status" aria-live="polite" aria-atomic="true">
    <h1 class="brand">SparkWork</h1>
    <div class="progress" aria-hidden="true"></div>
    <p class="starting">${copy.starting}</p>
    <section id="slow-hint" class="slow-hint" aria-hidden="true">
      <p class="slow-title">${copy.optimizing}</p>
      <p class="slow-copy">${copy.patience}</p>
    </section>
  </main>
  <span class="version">v${version}</span>
  <script>
    window.setTimeout(() => {
      const hint = document.getElementById('slow-hint')
      if (hint) {
        hint.classList.add('visible')
        hint.setAttribute('aria-hidden', 'false')
      }
    }, ${slowHintDelayMs})
  </script>
</body>
</html>`

  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`
}

export function resolveStartupGuidanceLocale(locale: string): StartupGuidanceLocale {
  return locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}
