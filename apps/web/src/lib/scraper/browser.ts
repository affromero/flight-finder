import type { Browser, BrowserContext } from 'playwright';
import type { CountryProfile } from './country-profiles';

// Chrome-only user agents — Google blocks non-Chrome heavily
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
];

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1366, height: 768 },
  { width: 1680, height: 1050 },
  { width: 1280, height: 800 },
];

function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export interface LaunchBrowserOptions {
  proxyUrl?: string; // When set, DNS is forced through the SOCKS5 proxy
}

export function buildBrowserArgs(options: LaunchBrowserOptions = {}): string[] {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--window-size=1440,900',
    // Docker Desktop (macOS/Windows) runs in a VM where Chromium's GPU
    // crashes. The ANGLE/SwiftShader software-GL flags fix that and are safe
    // everywhere, so they stay unconditional.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    // WebRTC leak prevention -- block ICE candidates from exposing real IP
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--enforce-webrtc-ip-permission-check',
  ];

  // --single-process (and its --in-process-gpu companion) work around Docker
  // Desktop GPU crashes, but can crash native Chromium on heavy SPAs such as
  // Google Flights. Native and desktop runs use multi-process Chromium by
  // default; the Docker image explicitly opts into the workaround.
  if (process.env.BROWSER_SINGLE_PROCESS === 'true') {
    args.push('--single-process', '--in-process-gpu');
  }

  // When proxying via SOCKS5, force DNS resolution through the proxy to prevent leaks.
  // Extract the proxy hostname to exclude it from the rule (it must resolve normally).
  if (options.proxyUrl) {
    try {
      const proxyHost = new URL(options.proxyUrl.replace('socks5://', 'http://')).hostname;
      args.push(`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${proxyHost}`);
    } catch {
      args.push('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost');
    }
  }

  return args;
}

export async function launchBrowser(options: LaunchBrowserOptions = {}): Promise<Browser> {
  const { chromium } = await import('playwright');

  return chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: buildBrowserArgs(options),
  });
}

export interface StealthContextOptions {
  countryProfile?: CountryProfile;
  proxyUrl?: string; // e.g. 'socks5://expressvpn:1080'
}

const DEFAULT_TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin'];

export async function createStealthContext(browser: Browser, options: StealthContextOptions = {}): Promise<BrowserContext> {
  const profile = options.countryProfile;
  const viewport = randomPick(VIEWPORTS);
  const proxy = options.proxyUrl ? { server: options.proxyUrl } : undefined;
  const context = await browser.newContext({
    userAgent: randomPick(USER_AGENTS),
    viewport,
    locale: profile?.locale ?? 'en-US',
    timezoneId: profile ? randomPick(profile.timezones) : randomPick(DEFAULT_TIMEZONES),
    geolocation: profile?.geolocation,
    permissions: profile?.geolocation ? ['geolocation'] : [],
    proxy,
    // NOTE: do NOT set Sec-Fetch-* here. extraHTTPHeaders applies to *every*
    // request, so hardcoding Sec-Fetch-Dest=document / Mode=navigate / Site=none
    // poisons Google Flights' results XHR (which must send Mode=cors,
    // Site=same-origin, Dest=empty). Google's backend then never resolves that
    // fetch and the page hangs forever on "Loading results" — reproduced
    // deterministically on MEL→TWU. Chromium already sets correct per-request
    // Sec-Fetch-* values on its own, so overriding them adds no stealth value.
    extraHTTPHeaders: {
      'Accept-Language': profile?.acceptLanguage ?? 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  // Comprehensive anti-detection: webdriver, chrome.runtime, plugins, languages
  const profileLocale = profile?.locale ?? null;
  await context.addInitScript((locale: string | null) => {
    // Hide webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // Mock chrome.runtime (missing in headless = bot signal)
    if (!(window as unknown as Record<string, unknown>).chrome) {
      Object.defineProperty(window, 'chrome', {
        value: { runtime: {}, loadTimes: () => ({}), csi: () => ({}) },
        writable: false,
      });
    }

    // Mock plugins (empty in headless = bot signal)
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', description: 'Portable Document Format', filename: 'internal-pdf-viewer', length: 1 },
        { name: 'Chrome PDF Viewer', description: '', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', length: 1 },
        { name: 'Native Client', description: '', filename: 'internal-nacl-plugin', length: 2 },
      ],
    });

    // Mock languages to match country profile (should align with Accept-Language header)
    Object.defineProperty(navigator, 'languages', {
      get: () => locale ? [locale, locale.split('-')[0]!, 'en'].filter((v, i, a) => a.indexOf(v) === i) : ['en-US', 'en'],
    });

    // Mock permissions query (headless returns inconsistent results)
    const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    Object.defineProperty(window.navigator.permissions, 'query', {
      value: (params: PermissionDescriptor) =>
        params.name === 'notifications'
          ? Promise.resolve({ state: 'prompt', onchange: null } as PermissionStatus)
          : originalQuery(params),
    });

    // Mock connection info
    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        effectiveType: '4g',
        rtt: 50,
        downlink: 10,
        saveData: false,
      }),
    });

    // Hardware concurrency (headless sometimes reports 1)
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 4 + Math.floor(Math.random() * 5), // 4-8 cores
    });

    // Device memory (headless sometimes missing)
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => 8,
    });

    // WebRTC leak prevention -- stub RTCPeerConnection to prevent real IP exposure
    // Chrome flags handle the network layer; this catches any JS-level WebRTC enumeration
    const OriginalRTC = window.RTCPeerConnection;
    if (OriginalRTC) {
      (window as unknown as Record<string, unknown>).RTCPeerConnection = class extends OriginalRTC {
        constructor(config?: RTCConfiguration) {
          // Strip STUN/TURN servers that could reveal the real IP
          const sanitized = { ...config, iceServers: [] };
          super(sanitized);
        }
      };
    }
  }, profileLocale);

  // Fingerprint noise: canvas, WebGL, AudioContext -- makes each context unique
  await context.addInitScript(() => {
    // Canvas fingerprint noise -- shift a few random pixels per toDataURL call
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (type?: string, quality?: number) {
      try {
        const ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
          const x = Math.floor(Math.random() * this.width);
          const y = Math.floor(Math.random() * this.height);
          const pixel = ctx.getImageData(x, y, 1, 1);
          pixel.data[0] = (pixel.data[0]! + Math.floor(Math.random() * 3) - 1) & 0xff;
          pixel.data[1] = (pixel.data[1]! + Math.floor(Math.random() * 3) - 1) & 0xff;
          ctx.putImageData(pixel, x, y);
        }
      } catch {
        // Cross-origin canvas -- skip noise
      }
      return originalToDataURL.call(this, type, quality);
    };

    // WebGL fingerprint -- spoof unmasked renderer/vendor strings
    const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
    const rendererSuffixes = ['Direct3D11', 'Direct3D9', 'OpenGL', 'Metal', 'Vulkan'];
    const suffix = rendererSuffixes[Math.floor(Math.random() * rendererSuffixes.length)];
    const spoofedRenderer = `ANGLE (Intel, Mesa Intel(R) UHD Graphics 630, ${suffix})`;
    const spoofedVendor = 'Google Inc. (Intel)';

    function spoofGetParameter(this: WebGLRenderingContext, pname: GLenum): unknown {
      // UNMASKED_VENDOR_WEBGL = 0x9245, UNMASKED_RENDERER_WEBGL = 0x9246
      const ext = this.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        if (pname === ext.UNMASKED_RENDERER_WEBGL) return spoofedRenderer;
        if (pname === ext.UNMASKED_VENDOR_WEBGL) return spoofedVendor;
      }
      return originalGetParameter.call(this, pname);
    }
    WebGLRenderingContext.prototype.getParameter = spoofGetParameter as typeof originalGetParameter;

    // Also handle WebGL2 if available
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const originalGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
      function spoofGetParameter2(this: WebGL2RenderingContext, pname: GLenum): unknown {
        const ext = this.getExtension('WEBGL_debug_renderer_info');
        if (ext) {
          if (pname === ext.UNMASKED_RENDERER_WEBGL) return spoofedRenderer;
          if (pname === ext.UNMASKED_VENDOR_WEBGL) return spoofedVendor;
        }
        return originalGetParameter2.call(this, pname);
      }
      WebGL2RenderingContext.prototype.getParameter = spoofGetParameter2 as typeof originalGetParameter2;
    }

    // AudioContext fingerprint -- add micro-noise to frequency/time domain data
    const OriginalAnalyser = window.AnalyserNode;
    if (OriginalAnalyser) {
      const origGetFloat = OriginalAnalyser.prototype.getFloatFrequencyData;
      OriginalAnalyser.prototype.getFloatFrequencyData = function (array: Float32Array<ArrayBuffer>) {
        origGetFloat.call(this, array);
        for (let i = 0; i < array.length; i++) {
          array[i] = array[i]! + (Math.random() * 0.001 - 0.0005);
        }
      };
    }
  });

  // Screen property alignment -- match screen dimensions to viewport
  await context.addInitScript((vp: { width: number; height: number }) => {
    Object.defineProperty(window.screen, 'width', { get: () => vp.width });
    Object.defineProperty(window.screen, 'height', { get: () => vp.height });
    Object.defineProperty(window.screen, 'availWidth', { get: () => vp.width });
    Object.defineProperty(window.screen, 'availHeight', { get: () => vp.height - 40 }); // taskbar offset
    Object.defineProperty(window.screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(window, 'outerWidth', { get: () => vp.width });
    Object.defineProperty(window, 'outerHeight', { get: () => vp.height + 85 }); // chrome UI offset
    Object.defineProperty(window, 'devicePixelRatio', { get: () => 1 });
  }, viewport);

  return context;
}
