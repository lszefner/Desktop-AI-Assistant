import { app } from "electron";
import { writeFile, unlink, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { existsSync, readdirSync } from "fs";
import { execSync, spawn } from "child_process";
import { logger } from "../utils/logger.js";

// Dynamic import for ESM compatibility
let pipeline: any = null;
let transcriber: any = null;
let isLoading = false;
let loadPromise: Promise<void> | null = null;

const MODEL_NAME = "Xenova/whisper-tiny";
const SAMPLE_RATE = 16000;

export class WhisperService {
  private modelsPath: string;
  private ffmpegPath: string | null = null;

  constructor() {
    this.modelsPath = join(app.getPath("userData"), "whisper-models");
    this.findFfmpeg();
  }

  private findFfmpeg(): void {
    try {
      // Try to find ffmpeg in PATH
      const result = execSync("where ffmpeg", { encoding: "utf-8" });
      this.ffmpegPath = result.trim().split("\n")[0];
      logger.debug("Whisper", `Found ffmpeg at: ${this.ffmpegPath}`);
    } catch {
      logger.debug(
        "Whisper",
        "ffmpeg not found in PATH, checking common locations..."
      );
      // Check common Windows paths
      const commonPaths = [
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
        "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
        join(app.getPath("userData"), "ffmpeg", "ffmpeg.exe"),
      ];
      for (const p of commonPaths) {
        if (existsSync(p)) {
          this.ffmpegPath = p;
          logger.debug("Whisper", `Found ffmpeg at: ${this.ffmpegPath}`);
          return;
        }
      }
      // WinGet (winget install Gyan.FFmpeg)
      const winGetBase = join(
        process.env.LOCALAPPDATA || "",
        "Microsoft",
        "WinGet",
        "Packages"
      );
      if (existsSync(winGetBase)) {
        for (const dir of readdirSync(winGetBase)) {
          if (dir.startsWith("Gyan.FFmpeg")) {
            const pkgPath = join(winGetBase, dir);
            for (const sub of readdirSync(pkgPath)) {
              if (sub.startsWith("ffmpeg-") && sub.endsWith("_build")) {
                const ff = join(pkgPath, sub, "bin", "ffmpeg.exe");
                if (existsSync(ff)) {
                  this.ffmpegPath = ff;
                  logger.debug("Whisper", `Found ffmpeg at: ${this.ffmpegPath}`);
                  return;
                }
              }
            }
          }
        }
      }
      logger.warn("Whisper", "ffmpeg not found - audio conversion will fail");
      this.ffmpegPath = null;
    }
  }

  async initialize(): Promise<boolean> {
    try {
      // Ensure models directory exists
      if (!existsSync(this.modelsPath)) {
        await mkdir(this.modelsPath, { recursive: true });
      }

      // Load the transformers library dynamically
      if (!pipeline) {
        logger.debug("Whisper", "Loading transformers library...");
        const transformers = await import("@xenova/transformers");
        pipeline = transformers.pipeline;

        // Set cache directory for models
        transformers.env.cacheDir = this.modelsPath;
        transformers.env.allowLocalModels = true;
      }

      logger.info("Whisper", "Initialized successfully");
      return true;
    } catch (error: any) {
      logger.error("Whisper", "Initialization error", error);
      return false;
    }
  }

  private async loadTranscriber(): Promise<void> {
    if (transcriber) return;
    if (isLoading && loadPromise) {
      await loadPromise;
      return;
    }

    isLoading = true;
    loadPromise = (async () => {
      try {
        logger.info("Whisper", `Loading model ${MODEL_NAME}...`);
        logger.debug(
          "Whisper",
          "This may take a moment on first run (downloading model)..."
        );

        transcriber = await pipeline(
          "automatic-speech-recognition",
          MODEL_NAME,
          {
            quantized: true,
          }
        );

        logger.info("Whisper", "Model loaded successfully");
      } catch (error: any) {
        logger.error("Whisper", "Failed to load model", error);
        throw error;
      } finally {
        isLoading = false;
      }
    })();

    await loadPromise;
  }

  // Convert audio to WAV format using ffmpeg
  private async convertToWav(
    inputBuffer: Buffer,
    inputExtension: string
  ): Promise<Buffer> {
    if (!this.ffmpegPath) {
      throw new Error(
        "ffmpeg not found - please install ffmpeg and add it to PATH"
      );
    }

    const tempInput = join(
      app.getPath("temp"),
      `whisper-input-${Date.now()}${inputExtension}`
    );
    const tempOutput = join(
      app.getPath("temp"),
      `whisper-output-${Date.now()}.wav`
    );

    try {
      await writeFile(tempInput, inputBuffer);

      // Convert to 16kHz mono WAV
      await new Promise<void>((resolve, reject) => {
        const ffmpeg = spawn(this.ffmpegPath!, [
          "-i",
          tempInput,
          "-ar",
          String(SAMPLE_RATE),
          "-ac",
          "1",
          "-f",
          "wav",
          "-y",
          tempOutput,
        ]);

        let stderr = "";
        ffmpeg.stderr.on("data", (data) => {
          stderr += data.toString();
        });

        ffmpeg.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
        });

        ffmpeg.on("error", reject);
      });

      const wavBuffer = await readFile(tempOutput);

      // Cleanup
      try {
        await unlink(tempInput);
        await unlink(tempOutput);
      } catch {}

      return wavBuffer;
    } catch (error) {
      // Cleanup on error
      try {
        await unlink(tempInput);
        await unlink(tempOutput);
      } catch {}
      throw error;
    }
  }

  // Parse WAV file and extract Float32Array audio data
  private parseWav(wavBuffer: Buffer): Float32Array {
    // Find "data" chunk
    let dataStart = 44;
    for (let i = 0; i < wavBuffer.length - 4; i++) {
      if (
        wavBuffer[i] === 0x64 && // 'd'
        wavBuffer[i + 1] === 0x61 && // 'a'
        wavBuffer[i + 2] === 0x74 && // 't'
        wavBuffer[i + 3] === 0x61 // 'a'
      ) {
        dataStart = i + 8; // Skip "data" + 4 bytes size
        break;
      }
    }

    // Read audio data as 16-bit PCM and convert to Float32
    const samples = new Float32Array((wavBuffer.length - dataStart) / 2);
    for (let i = 0; i < samples.length; i++) {
      const offset = dataStart + i * 2;
      // Read as signed 16-bit little-endian
      let sample = wavBuffer[offset] | (wavBuffer[offset + 1] << 8);
      if (sample >= 0x8000) sample -= 0x10000;
      // Normalize to [-1, 1]
      samples[i] = sample / 32768;
    }

    return samples;
  }

  async transcribe(
    audioBuffer: Buffer,
    extension: string = ".webm"
  ): Promise<string> {
    try {
      await this.loadTranscriber();

      if (!transcriber) {
        throw new Error("Whisper model not loaded");
      }

      logger.debug("Whisper", "Converting audio to WAV...");

      // Convert to WAV format using ffmpeg
      const wavBuffer = await this.convertToWav(audioBuffer, extension);

      // Parse WAV and get audio samples
      const audioData = this.parseWav(wavBuffer);

      logger.debug(
        "Whisper",
        `Transcribing audio... ${audioData.length} samples`
      );
      const startTime = Date.now();

      // Transcribe using Float32Array directly
      const result = await transcriber(audioData, {
        chunk_length_s: 30,
        stride_length_s: 5,
        language: "english",
        task: "transcribe",
        sampling_rate: SAMPLE_RATE,
      });

      const elapsed = Date.now() - startTime;
      logger.debug("Whisper", `Transcription completed in ${elapsed}ms`);

      return result.text?.trim() || "";
    } catch (error: any) {
      logger.error("Whisper", "Transcription error", error);
      throw error;
    }
  }

  async transcribeFromBase64(
    base64Audio: string,
    mimeType: string = "audio/webm"
  ): Promise<string> {
    try {
      const audioBuffer = Buffer.from(base64Audio, "base64");

      let extension = ".webm";
      if (mimeType.includes("wav")) extension = ".wav";
      else if (mimeType.includes("mp3")) extension = ".mp3";
      else if (mimeType.includes("ogg")) extension = ".ogg";

      return await this.transcribe(audioBuffer, extension);
    } catch (error: any) {
      logger.error("Whisper", "Base64 transcription error", error);
      throw error;
    }
  }

  isModelLoaded(): boolean {
    return !!transcriber;
  }

  isLoading(): boolean {
    return isLoading;
  }

  hasFfmpeg(): boolean {
    return !!this.ffmpegPath;
  }
}
