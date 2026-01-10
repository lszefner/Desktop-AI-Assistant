// Browser automation service using Playwright
// Similar to browser-use but for Node.js/TypeScript

import { chromium, Browser, BrowserContext, Page } from "playwright";
import { logger } from "../utils/logger.js";

export interface BrowserAction {
  action: string;
  selector?: string;
  text?: string;
  url?: string;
  script?: string;
  value?: string;
}

export interface PageContent {
  url: string;
  title: string;
  text: string;
  links: { text: string; href: string }[];
  inputs: { name: string; type: string; placeholder?: string }[];
  buttons: { text: string; selector: string }[];
}

export class BrowserService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private isHeadless: boolean;

  constructor(headless = true) {
    this.isHeadless = headless;
  }

  // Initialize browser
  async launch(): Promise<void> {
    if (this.browser) return;

    logger.info("Browser", "Launching browser...");
    this.browser = await chromium.launch({
      headless: this.isHeadless,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--no-sandbox",
      ],
    });

    this.context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });

    this.page = await this.context.newPage();
    logger.debug("Browser", "Browser launched successfully");
  }

  // Close browser
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      logger.debug("Browser", "Browser closed");
    }
  }

  // Ensure browser is running
  private async ensureBrowser(): Promise<Page> {
    if (!this.page) {
      await this.launch();
    }
    return this.page!;
  }

  // Navigate to URL
  async navigate(url: string): Promise<string> {
    const page = await this.ensureBrowser();
    logger.info("Browser", `Navigating to: ${url}`);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(1000); // Wait for dynamic content
      return `Successfully navigated to ${url}. Title: ${await page.title()}`;
    } catch (error: any) {
      return `Navigation failed: ${error.message}`;
    }
  }

  // Get current page content
  async getPageContent(): Promise<PageContent> {
    const page = await this.ensureBrowser();

    const content = await page.evaluate(() => {
      // Extract main text content
      const getText = () => {
        const elementsToRemove = document.querySelectorAll(
          "script, style, nav, header, footer, aside, [hidden], .ad, .advertisement"
        );
        const clone = document.body.cloneNode(true) as HTMLElement;
        clone
          .querySelectorAll(
            "script, style, nav, header, footer, aside, [hidden]"
          )
          .forEach((el) => el.remove());

        return clone.innerText
          .replace(/\s+/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim()
          .slice(0, 5000);
      };

      // Extract links
      const links = Array.from(document.querySelectorAll("a[href]"))
        .slice(0, 20)
        .map((a) => ({
          text: (a as HTMLAnchorElement).innerText.trim().slice(0, 100),
          href: (a as HTMLAnchorElement).href,
        }))
        .filter((l) => l.text && l.href.startsWith("http"));

      // Extract form inputs
      const inputs = Array.from(
        document.querySelectorAll("input, textarea, select")
      )
        .slice(0, 15)
        .map((el) => ({
          name:
            (el as HTMLInputElement).name ||
            (el as HTMLInputElement).id ||
            (el as HTMLInputElement).placeholder ||
            "",
          type: (el as HTMLInputElement).type || el.tagName.toLowerCase(),
          placeholder: (el as HTMLInputElement).placeholder,
        }))
        .filter((i) => i.name);

      // Extract buttons
      const buttons = Array.from(
        document.querySelectorAll(
          'button, input[type="submit"], [role="button"]'
        )
      )
        .slice(0, 10)
        .map((el, idx) => ({
          text:
            (el as HTMLElement).innerText?.trim().slice(0, 50) ||
            (el as HTMLInputElement).value ||
            `Button ${idx + 1}`,
          selector: el.id
            ? `#${el.id}`
            : el.className
            ? `.${el.className.split(" ")[0]}`
            : `button:nth-of-type(${idx + 1})`,
        }));

      return {
        url: window.location.href,
        title: document.title,
        text: getText(),
        links,
        inputs,
        buttons,
      };
    });

    return content;
  }

  // Get simplified page snapshot for LLM
  async getSnapshot(): Promise<string> {
    const content = await this.getPageContent();

    let snapshot = `## Current Page: ${content.title}\nURL: ${content.url}\n\n`;
    snapshot += `### Page Content:\n${content.text.slice(0, 3000)}\n\n`;

    if (content.links.length > 0) {
      snapshot += `### Links:\n`;
      content.links.forEach((link, i) => {
        snapshot += `[${i + 1}] ${link.text} -> ${link.href}\n`;
      });
      snapshot += "\n";
    }

    if (content.inputs.length > 0) {
      snapshot += `### Form Fields:\n`;
      content.inputs.forEach((input) => {
        snapshot += `- ${input.name} (${input.type})${
          input.placeholder ? ` - "${input.placeholder}"` : ""
        }\n`;
      });
      snapshot += "\n";
    }

    if (content.buttons.length > 0) {
      snapshot += `### Buttons:\n`;
      content.buttons.forEach((btn) => {
        snapshot += `- "${btn.text}" [selector: ${btn.selector}]\n`;
      });
    }

    return snapshot;
  }

  // Click an element
  async click(selector: string): Promise<string> {
    const page = await this.ensureBrowser();

    try {
      // Try multiple selector strategies
      const selectors = [
        selector,
        `text="${selector}"`,
        `[aria-label="${selector}"]`,
        `button:has-text("${selector}")`,
        `a:has-text("${selector}")`,
      ];

      for (const sel of selectors) {
        try {
          const element = await page.$(sel);
          if (element) {
            await element.click();
            await page.waitForTimeout(1000);
            return `Clicked element: ${selector}`;
          }
        } catch {
          continue;
        }
      }

      return `Could not find element to click: ${selector}`;
    } catch (error: any) {
      return `Click failed: ${error.message}`;
    }
  }

  // Fill a form field
  async fill(selector: string, value: string): Promise<string> {
    const page = await this.ensureBrowser();

    try {
      const selectors = [
        selector,
        `[name="${selector}"]`,
        `[id="${selector}"]`,
        `[placeholder*="${selector}" i]`,
        `input[aria-label*="${selector}" i]`,
      ];

      for (const sel of selectors) {
        try {
          const element = await page.$(sel);
          if (element) {
            await element.fill(value);
            return `Filled "${selector}" with "${value}"`;
          }
        } catch {
          continue;
        }
      }

      return `Could not find field: ${selector}`;
    } catch (error: any) {
      return `Fill failed: ${error.message}`;
    }
  }

  // Type text (with key events)
  async type(selector: string, text: string): Promise<string> {
    const page = await this.ensureBrowser();

    try {
      await page.locator(selector).first().type(text, { delay: 50 });
      return `Typed "${text}" into ${selector}`;
    } catch (error: any) {
      return `Type failed: ${error.message}`;
    }
  }

  // Press a key
  async pressKey(key: string): Promise<string> {
    const page = await this.ensureBrowser();

    try {
      await page.keyboard.press(key);
      return `Pressed key: ${key}`;
    } catch (error: any) {
      return `Key press failed: ${error.message}`;
    }
  }

  // Take screenshot and return base64
  async screenshot(): Promise<string> {
    const page = await this.ensureBrowser();

    try {
      const buffer = await page.screenshot({ type: "png" });
      return buffer.toString("base64");
    } catch (error: any) {
      throw new Error(`Screenshot failed: ${error.message}`);
    }
  }

  // Execute JavaScript on page
  async evaluate(script: string): Promise<string> {
    const page = await this.ensureBrowser();

    try {
      const result = await page.evaluate(script);
      return typeof result === "string"
        ? result
        : JSON.stringify(result, null, 2);
    } catch (error: any) {
      return `Script execution failed: ${error.message}`;
    }
  }

  // Scroll page
  async scroll(direction: "up" | "down" | "top" | "bottom"): Promise<string> {
    const page = await this.ensureBrowser();

    try {
      switch (direction) {
        case "down":
          await page.evaluate(() => window.scrollBy(0, 500));
          break;
        case "up":
          await page.evaluate(() => window.scrollBy(0, -500));
          break;
        case "top":
          await page.evaluate(() => window.scrollTo(0, 0));
          break;
        case "bottom":
          await page.evaluate(() =>
            window.scrollTo(0, document.body.scrollHeight)
          );
          break;
      }
      return `Scrolled ${direction}`;
    } catch (error: any) {
      return `Scroll failed: ${error.message}`;
    }
  }

  // Wait for element or timeout
  async waitFor(selector: string, timeout = 5000): Promise<string> {
    const page = await this.ensureBrowser();

    try {
      await page.waitForSelector(selector, { timeout });
      return `Element found: ${selector}`;
    } catch (error: any) {
      return `Wait timeout: ${selector} not found within ${timeout}ms`;
    }
  }

  // Go back
  async goBack(): Promise<string> {
    const page = await this.ensureBrowser();

    try {
      await page.goBack();
      return `Navigated back to: ${page.url()}`;
    } catch (error: any) {
      return `Go back failed: ${error.message}`;
    }
  }

  // Get current URL
  async getCurrentUrl(): Promise<string> {
    const page = await this.ensureBrowser();
    return page.url();
  }

  // Search and interact - high-level action (uses DuckDuckGo to avoid bot detection)
  async searchGoogle(query: string): Promise<string> {
    const page = await this.ensureBrowser();

    // Use DuckDuckGo which has better bot tolerance than Google
    const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
    logger.info("Browser", `Searching via DuckDuckGo: ${query}`);

    try {
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      // Wait for results to load
      await page.waitForTimeout(2000);

      // Try to wait for result links
      try {
        await page.waitForSelector('[data-testid="result"]', { timeout: 5000 });
      } catch {
        // Results might be under different selectors
      }

      return await this.getSnapshot();
    } catch (error: any) {
      logger.warn("Browser", "Search failed, trying direct navigation");
      // Fallback: direct URL search
      await page.goto(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        }
      );
      await page.waitForTimeout(1000);
      return await this.getSnapshot();
    }
  }

  // Extract specific data from page
  async extractData(instruction: string): Promise<string> {
    const page = await this.ensureBrowser();

    // Get page content and structure
    const content = await this.getPageContent();

    // Return formatted data for LLM to process
    return JSON.stringify(
      {
        instruction,
        pageTitle: content.title,
        pageUrl: content.url,
        textContent: content.text,
        availableLinks: content.links.slice(0, 10),
        formFields: content.inputs,
        buttons: content.buttons,
      },
      null,
      2
    );
  }

  // Execute a sequence of actions
  async executeActions(actions: BrowserAction[]): Promise<string[]> {
    const results: string[] = [];

    for (const action of actions) {
      let result: string;

      switch (action.action) {
        case "navigate":
          result = await this.navigate(action.url!);
          break;
        case "click":
          result = await this.click(action.selector!);
          break;
        case "fill":
          result = await this.fill(action.selector!, action.value!);
          break;
        case "type":
          result = await this.type(action.selector!, action.text!);
          break;
        case "press":
          result = await this.pressKey(action.text!);
          break;
        case "scroll":
          result = await this.scroll(action.text as any);
          break;
        case "wait":
          result = await this.waitFor(action.selector!);
          break;
        case "snapshot":
          result = await this.getSnapshot();
          break;
        case "evaluate":
          result = await this.evaluate(action.script!);
          break;
        default:
          result = `Unknown action: ${action.action}`;
      }

      results.push(result);
    }

    return results;
  }
}
