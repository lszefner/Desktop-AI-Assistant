// Web search with page content scraping for deeper results

import { logger } from "../utils/logger.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string; // Full page content when scraped
}

export class WebSearchService {
  private userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  // Main search - gets results and optionally scrapes pages
  async search(
    query: string,
    maxResults = 5,
    scrapePages = true
  ): Promise<SearchResult[]> {
    logger.info("WebSearch", `Searching for: ${query}`);

    const results: SearchResult[] = await this.searchDuckDuckGoLite(
      query,
      maxResults
    );

    // Scrape top pages for content
    if (scrapePages && results.length > 0) {
      logger.debug("WebSearch", "Scraping top pages for content...");
      const pagesToScrape = Math.min(3, results.length); // Scrape top 3

      const scrapePromises = results
        .slice(0, pagesToScrape)
        .map(async (result, idx) => {
          try {
            const content = await this.scrapePage(result.url);
            results[idx].content = content;
          } catch (error: any) {
            logger.warn(
              "WebSearch",
              `Failed to scrape ${result.url}: ${error.message}`
            );
          }
        });

      await Promise.all(scrapePromises);
    }

    return results;
  }

  // Scrape a page and extract main content
  private async scrapePage(url: string): Promise<string> {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": this.userAgent,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(8000),
        redirect: "follow",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html")) {
        return ""; // Skip non-HTML content
      }

      const html = await response.text();
      return this.extractContent(html);
    } catch (error: any) {
      logger.warn("WebSearch", `Scrape error for ${url}: ${error.message}`);
      return "";
    }
  }

  // Extract main content from HTML, removing boilerplate
  private extractContent(html: string): string {
    // Remove scripts, styles, nav, header, footer, ads
    let content = html
      // Remove script tags and content
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      // Remove style tags and content
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
      // Remove comments
      .replace(/<!--[\s\S]*?-->/g, "")
      // Remove nav, header, footer, aside, menu elements
      .replace(/<(nav|header|footer|aside|menu)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      // Remove common ad/sidebar classes
      .replace(
        /<[^>]*(sidebar|advertisement|ad-|ads-|banner|popup|modal|cookie|newsletter|subscribe)[^>]*>[\s\S]*?<\/[^>]+>/gi,
        ""
      )
      // Remove hidden elements
      .replace(
        /<[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi,
        ""
      )
      .replace(/<[^>]*hidden[^>]*>[\s\S]*?<\/[^>]+>/gi, "");

    // Try to find main content area
    const mainPatterns = [
      /<main\b[^>]*>([\s\S]*?)<\/main>/i,
      /<article\b[^>]*>([\s\S]*?)<\/article>/i,
      /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<div[^>]*class="[^"]*post[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<div[^>]*class="[^"]*article[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<div[^>]*id="content"[^>]*>([\s\S]*?)<\/div>/i,
    ];

    for (const pattern of mainPatterns) {
      const match = content.match(pattern);
      if (match && match[1] && match[1].length > 200) {
        content = match[1];
        break;
      }
    }

    // Extract text from remaining HTML
    content = content
      // Replace block elements with newlines
      .replace(/<(p|div|br|h[1-6]|li|tr)[^>]*>/gi, "\n")
      // Remove all remaining HTML tags
      .replace(/<[^>]+>/g, " ")
      // Decode HTML entities
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num)))
      // Clean up whitespace
      .replace(/\s+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // Limit content length (keep most relevant part)
    const maxLength = 3000;
    if (content.length > maxLength) {
      // Try to cut at sentence boundary
      const truncated = content.slice(0, maxLength);
      const lastPeriod = truncated.lastIndexOf(". ");
      if (lastPeriod > maxLength * 0.7) {
        content = truncated.slice(0, lastPeriod + 1);
      } else {
        content = truncated + "...";
      }
    }

    return content;
  }

  private async searchDuckDuckGoLite(
    query: string,
    maxResults: number
  ): Promise<SearchResult[]> {
    try {
      const encoded = encodeURIComponent(query);

      // Use lite version for cleaner HTML
      const response = await fetch(
        `https://lite.duckduckgo.com/lite/?q=${encoded}`,
        {
          headers: {
            "User-Agent": this.userAgent,
            Accept: "text/html",
          },
          signal: AbortSignal.timeout(8000),
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const html = await response.text();
      const results: SearchResult[] = [];

      // Parse lite version HTML
      const linkRegex =
        /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
      const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([^<]+)/gi;

      const links: { url: string; title: string }[] = [];
      const snippets: string[] = [];

      let match;
      while ((match = linkRegex.exec(html)) !== null) {
        links.push({ url: match[1], title: this.decodeHtml(match[2].trim()) });
      }
      while ((match = snippetRegex.exec(html)) !== null) {
        snippets.push(this.decodeHtml(match[1].trim()));
      }

      for (let i = 0; i < Math.min(links.length, maxResults); i++) {
        results.push({
          title: links[i].title,
          url: links[i].url,
          snippet: snippets[i] || "No description available",
        });
      }

      // Fallback to standard version
      if (results.length === 0) {
        return await this.searchDuckDuckGoStandard(query, maxResults);
      }

      logger.debug("WebSearch", `DuckDuckGo found ${results.length} results`);
      return results;
    } catch (error: any) {
      logger.warn("WebSearch", `DuckDuckGo lite failed: ${error.message}`);
      return await this.searchDuckDuckGoStandard(query, maxResults);
    }
  }

  private async searchDuckDuckGoStandard(
    query: string,
    maxResults: number
  ): Promise<SearchResult[]> {
    try {
      const encoded = encodeURIComponent(query);
      const response = await fetch(
        `https://html.duckduckgo.com/html/?q=${encoded}`,
        {
          headers: {
            "User-Agent": this.userAgent,
            Accept: "text/html",
          },
          signal: AbortSignal.timeout(8000),
        }
      );

      if (!response.ok) return [];

      const html = await response.text();
      const results: SearchResult[] = [];

      const patterns = [
        /<a[^>]*class="result__a"[^>]*href="[^"]*uddg=([^&"]+)[^"]*"[^>]*>([^<]+)<\/a>/gi,
        /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*class="[^"]*result[^"]*"[^>]*>([^<]+)<\/a>/gi,
      ];

      const snippetPattern =
        /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippets: string[] = [];

      let match;
      while ((match = snippetPattern.exec(html)) !== null) {
        snippets.push(
          this.decodeHtml(match[1].replace(/<[^>]+>/g, "").trim()).slice(0, 300)
        );
      }

      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let idx = 0;
        while (
          (match = pattern.exec(html)) !== null &&
          results.length < maxResults
        ) {
          const url = decodeURIComponent(match[1]);
          const title = this.decodeHtml(match[2].trim());

          if (url.includes("duckduckgo.com")) continue;

          results.push({
            title,
            url: url.startsWith("http") ? url : `https://${url}`,
            snippet: snippets[idx] || "No description available",
          });
          idx++;
        }
        if (results.length > 0) break;
      }

      return results;
    } catch (error: any) {
      logger.warn("WebSearch", `DuckDuckGo standard failed: ${error.message}`);
      return [];
    }
  }

  private decodeHtml(html: string): string {
    return html
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num)))
      .replace(/<[^>]+>/g, "")
      .trim();
  }

  async news(query: string, maxResults = 5): Promise<SearchResult[]> {
    return this.search(`${query} news latest`, maxResults);
  }
}
