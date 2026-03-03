import fs from 'node:fs/promises';
import path from 'node:path';
import { Browser, BrowserContext, Locator, Page, chromium } from 'playwright';
import z from 'zod';
import { getWorkspaceBase, truncateText } from '../tools';
import { BrowserToolResult, ComputerTool } from '../types';

class BrowserManager {
  private static instance: BrowserManager | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lastActivity = Date.now();
  private idleTimerStarted = false;
  private readonly idleTimeoutMs = 5 * 60 * 1000;

  static getInstance() {
    if (!BrowserManager.instance) {
      BrowserManager.instance = new BrowserManager();
    }

    BrowserManager.instance.startIdleTimer();

    return BrowserManager.instance;
  }

  private startIdleTimer() {
    if (this.idleTimerStarted) {
      return;
    }

    this.idleTimerStarted = true;
    const timer = setInterval(async () => {
      if (Date.now() - this.lastActivity > this.idleTimeoutMs) {
        await this.cleanup();
      }
    }, 60_000);

    timer.unref?.();
  }

  async getPage() {
    this.lastActivity = Date.now();

    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
    }

    if (!this.context) {
      this.context = await this.browser.newContext({
        viewport: { width: 1440, height: 900 },
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      });
    }

    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
    }

    return this.page;
  }

  async cleanup() {
    await this.page?.close().catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);

    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

const resolveLocator = async (
  page: Page,
  selector: string,
): Promise<Locator> => {
  try {
    const cssLocator = page.locator(selector).first();
    if ((await cssLocator.count()) > 0) {
      return cssLocator;
    }
  } catch (_) {}

  const textLocator = page.getByText(selector, { exact: false }).first();

  if ((await textLocator.count()) > 0) {
    return textLocator;
  }

  throw new Error(`Unable to find an element matching "${selector}"`);
};

const navigateSchema = z.object({
  url: z.string().url('A valid URL is required'),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
});

const clickSchema = z.object({
  selector: z.string().min(1, 'A selector or visible text is required'),
  timeout: z.number().int().positive().max(30_000).optional(),
});

const typeSchema = z.object({
  selector: z.string().min(1, 'A selector is required'),
  text: z.string(),
  clear: z.boolean().optional(),
});

const screenshotSchema = z.object({
  fullPage: z.preprocess((value) => {
    if (value === undefined || value === null || value === '' || value === '.') {
      return undefined;
    }

    if (value === 'true') {
      return true;
    }

    if (value === 'false') {
      return false;
    }

    return value;
  }, z.boolean().optional()),
});

const scrapeSchema = z.object({
  selector: z.string().optional(),
  attribute: z.string().optional(),
});

const browserNavigateTool: ComputerTool<typeof navigateSchema> = {
  name: 'browser_navigate',
  description:
    'Navigate the shared browser page to a URL and wait for it to load. Required args: url. Optional args: waitUntil.',
  schema: navigateSchema,
  execute: async (params): Promise<BrowserToolResult> => {
    try {
      const page = await BrowserManager.getInstance().getPage();

      await page.goto(params.url, {
        waitUntil: params.waitUntil || 'domcontentloaded',
        timeout: 30_000,
      });

      return {
        success: true,
        data: {
          url: page.url(),
          title: await page.title(),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  },
};

const browserClickTool: ComputerTool<typeof clickSchema> = {
  name: 'browser_click',
  description:
    'Click an element using a CSS selector first, then fall back to visible text. Required args: selector. Optional args: timeout.',
  schema: clickSchema,
  execute: async (params): Promise<BrowserToolResult> => {
    try {
      const page = await BrowserManager.getInstance().getPage();
      const locator = await resolveLocator(page, params.selector);

      await locator.click({
        timeout: params.timeout || 10_000,
      });
      await page
        .waitForLoadState('domcontentloaded', { timeout: 5_000 })
        .catch(() => undefined);

      return {
        success: true,
        data: {
          clicked: params.selector,
          url: page.url(),
          title: await page.title(),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  },
};

const browserTypeTool: ComputerTool<typeof typeSchema> = {
  name: 'browser_type',
  description:
    'Type text into an input field located by CSS selector. Required args: selector, text. Optional args: clear.',
  schema: typeSchema,
  execute: async (params): Promise<BrowserToolResult> => {
    try {
      const page = await BrowserManager.getInstance().getPage();
      const locator = page.locator(params.selector).first();

      if ((params.clear ?? true) === false) {
        await locator.type(params.text);
      } else {
        await locator.fill(params.text);
      }

      return {
        success: true,
        data: {
          selector: params.selector,
          charactersTyped: params.text.length,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  },
};

const browserScreenshotTool: ComputerTool<typeof screenshotSchema> = {
  name: 'browser_screenshot',
  description:
    'Save a PNG screenshot of the current browser page into the workspace and return its path. Optional args: fullPage. Use {} for a normal screenshot or {"fullPage": true} for a full-page screenshot.',
  schema: screenshotSchema,
  execute: async (params): Promise<BrowserToolResult> => {
    try {
      const page = await BrowserManager.getInstance().getPage();
      const artifactDir = path.join(getWorkspaceBase(), 'browser-artifacts');
      const filePath = path.join(artifactDir, `screenshot_${Date.now()}.png`);

      await fs.mkdir(artifactDir, { recursive: true });
      await page.screenshot({
        path: filePath,
        fullPage: params.fullPage || false,
        type: 'png',
      });

      const stats = await fs.stat(filePath);

      return {
        success: true,
        path: filePath,
        data: {
          path: filePath,
          bytes: stats.size,
          url: page.url(),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  },
};

const browserScrapeTool: ComputerTool<typeof scrapeSchema> = {
  name: 'browser_scrape',
  description:
    'Extract text content or a specific attribute from the current browser page. Optional args: selector, attribute. Use {"attribute":"text"} or omit attribute to get text content.',
  schema: scrapeSchema,
  execute: async (params): Promise<BrowserToolResult> => {
    try {
      const page = await BrowserManager.getInstance().getPage();
      const selector = params.selector || 'body';
      const locator = page.locator(selector);
      const count = await locator.count();

      if (count === 0) {
        throw new Error(`No elements found for selector "${selector}"`);
      }

      if (params.attribute) {
        if (
          params.attribute === 'text' ||
          params.attribute === 'textContent' ||
          params.attribute === 'innerText'
        ) {
          const value = await locator.first().textContent();

          return {
            success: true,
            data: {
              selector,
              attribute: params.attribute,
              content: truncateText(value || '', 4_000),
            },
          };
        }

        const value = await locator.first().getAttribute(params.attribute);

        return {
          success: true,
          data: {
            selector,
            attribute: params.attribute,
            content: truncateText(String(value ?? '')),
          },
        };
      }

      const contents = await Promise.all(
        Array.from({ length: Math.min(count, 10) }).map((_, index) =>
          locator.nth(index).textContent(),
        ),
      );

      return {
        success: true,
        data: {
          selector,
          count,
          content: truncateText(contents.filter(Boolean).join('\n\n')),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  },
};

export const browserSkill = {
  tools: {
    browser_navigate: browserNavigateTool,
    browser_click: browserClickTool,
    browser_type: browserTypeTool,
    browser_screenshot: browserScreenshotTool,
    browser_scrape: browserScrapeTool,
  },
};
