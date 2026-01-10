import { desktopCapturer } from "electron";
import { writeFile, readFile } from "fs/promises";
import { join } from "path";
import { app } from "electron";
import { logger } from "../utils/logger.js";

export interface ScreenshotResult {
  path: string;
  base64: string;
}

export class ScreenshotService {
  async captureScreen(): Promise<ScreenshotResult> {
    try {
      logger.debug("Screenshot", "Capturing screen...");

      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1920, height: 1080 },
      });

      if (sources.length === 0) {
        throw new Error("No screen sources available");
      }

      // Get the primary display
      const primarySource = sources[0];
      const image = primarySource.thumbnail;

      if (!image) {
        throw new Error("Failed to capture screen image");
      }

      // Save to temp directory
      const tempPath = app.getPath("temp");
      const filename = `screenshot-${Date.now()}.png`;
      const filePath = join(tempPath, filename);

      // Convert nativeImage to PNG buffer
      const pngBuffer = image.toPNG();
      await writeFile(filePath, pngBuffer);

      // Convert to base64 for API
      const base64 = pngBuffer.toString("base64");

      logger.debug("Screenshot", `Saved to: ${filePath}`);
      logger.debug("Screenshot", `Base64 length: ${base64.length}`);

      return { path: filePath, base64 };
    } catch (error: any) {
      logger.error("Screenshot", "Error", error);
      throw new Error(`Screenshot failed: ${error.message}`);
    }
  }

  async captureAsBase64(): Promise<string> {
    const result = await this.captureScreen();
    return result.base64;
  }
}
