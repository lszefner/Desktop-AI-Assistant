import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { Panel } from "./components/Panel";
import { Input } from "./components/Input";
import { ThinkingBar } from "./components/ThinkingBar";
import { ResponseDisplay } from "./components/ResponseDisplay";

type AppState = "idle" | "thinking" | "responding";

// Parse response to separate thinking/actions from actual response
function parseResponse(text: string): { thoughts: string[]; response: string } {
  const lines = text.split("\n");
  const thoughts: string[] = [];
  const responseLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Match patterns like [Searching...], [Tool Result], etc.
    if (/^\[.+\]$/.test(trimmed) || /^\[.+\.{3}\]$/.test(trimmed)) {
      thoughts.push(trimmed);
    }
    // Match "Sir, I will..." or "Let me..." patterns as thoughts
    else if (
      /^(Sir,? I will|Let me|I('ll| will) (search|check|look|analyze|fetch))/i.test(
        trimmed
      )
    ) {
      thoughts.push(trimmed);
    }
    // Match "Please hold on" or similar
    else if (/please (hold on|wait|stand by)/i.test(trimmed)) {
      thoughts.push(trimmed);
    } else if (trimmed) {
      responseLines.push(line);
    }
  }

  return {
    thoughts,
    response: responseLines.join("\n").trim(),
  };
}

export default function App() {
  const [state, setState] = useState<AppState>("idle");
  const [status, setStatus] = useState("");
  const [response, setResponse] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [attachedScreenshot, setAttachedScreenshot] = useState<string | null>(
    null
  );
  const [provider, setProvider] = useState<"openai" | "ollama">("openai");
  const [inputHeight, setInputHeight] = useState(44); // Track actual textarea height
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Parse response into thoughts and actual response
  const parsed = useMemo(() => parseResponse(response), [response]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Initialize provider on mount
  useEffect(() => {
    window.electron?.getProvider().then((p) => {
      setProvider(p);
    });
  }, []);

  // Handle provider change
  const handleProviderChange = useCallback(
    async (newProvider: "openai" | "ollama") => {
      setProvider(newProvider);
      await window.electron?.setProvider(newProvider);
    },
    []
  );

  // Handle input height change
  const handleInputHeightChange = useCallback((height: number) => {
    setInputHeight(height);
  }, []);

  // Listen for status updates from main process
  useEffect(() => {
    const cleanup = window.electron?.onStatus((newStatus) => {
      setStatus(newStatus);
    });
    return cleanup;
  }, []);

  // Listen for screenshot attached event (Ctrl+H)
  useEffect(() => {
    const cleanup = window.electron?.onScreenshotAttached((base64) => {
      setAttachedScreenshot(base64);
    });
    return cleanup;
  }, []);

  // Listen for context cleared (Ctrl+;)
  useEffect(() => {
    const cleanup = window.electron?.onContextCleared?.(() => {
      setState("idle");
      setStatus("");
      setResponse("");
      setAttachedScreenshot(null);
      window.electron?.clearScreenshot();
      window.electron?.resizeWindow(68);
      setTimeout(() => inputRef.current?.focus(), 50);
    });
    return cleanup;
  }, []);

  // Listen for reset event (when window is shown via Ctrl+Y)
  useEffect(() => {
    const cleanup = window.electron?.onReset(() => {
      // Reset all state
      setState("idle");
      setStatus("");
      setResponse("");
      setAttachedScreenshot(null);
      // Resize window immediately to idle size (compact)
      window.electron?.resizeWindow(68);
      // Focus input
      setTimeout(() => inputRef.current?.focus(), 50);
    });
    return cleanup;
  }, []);

  // Listen for notification action queries
  useEffect(() => {
    const cleanup = window.electron?.onNotificationAction((query: string) => {
      console.log("[Renderer] Notification action query received:", query);
      // Auto-submit the query
      if (query && query.trim()) {
        handleSubmit(query);
      }
    });
    return cleanup;
  }, []);

  console.log("[Renderer] State:", state);

  const handleSubmit = useCallback(
    async (query: string) => {
      if (!query.trim()) return;

      // Handle special commands
      if (["exit", "quit", "close"].includes(query.toLowerCase())) {
        window.electron?.hideWindow();
        return;
      }

      setState("thinking");
      setStatus(attachedScreenshot ? "Analyzing screenshot..." : "Thinking...");
      setResponse("");

      // Clear screenshot indicator after submitting (it will be used by the agent)
      const hadScreenshot = !!attachedScreenshot;
      setAttachedScreenshot(null);

      try {
        console.log(
          "[Renderer] Calling electron.query with:",
          query,
          "hasScreenshot:",
          hadScreenshot
        );
        const result = await window.electron?.query(query);
        console.log("[Renderer] Received result:", result);

        if (!result || result.trim() === "") {
          console.warn("[Renderer] Empty result received");
          setResponse("I'm ready to help, Sir. Please try again.");
        } else {
          setResponse(result);
        }
        setState("responding");
        // Refocus input after response
        setTimeout(() => inputRef.current?.focus(), 100);
      } catch (error: any) {
        console.error("[Renderer] Error:", error);
        setResponse(
          `I apologize, Sir. An error occurred: ${error?.message || error}`
        );
        setState("responding");
        // Refocus input after error
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    },
    [attachedScreenshot]
  );

  const handleReset = useCallback(() => {
    setState("idle");
    setStatus("");
    setResponse("");
    setAttachedScreenshot(null);
    // Clear any pending screenshot on main process
    window.electron?.clearScreenshot();
    // Immediately resize window to idle size (compact)
    window.electron?.resizeWindow(68);
    inputRef.current?.focus();
  }, []);

  const handleClearScreenshot = useCallback(() => {
    setAttachedScreenshot(null);
    window.electron?.clearScreenshot();
  }, []);

  // Notify main process of height changes - use layout effect for sync resize before paint
  useLayoutEffect(() => {
    // Calculate fresh to avoid stale closures
    const height = (() => {
      const basePadding = 16 + 28;
      const actualInputHeight = inputHeight; // Use tracked height instead of fixed 44
      const indicatorsRowHeight = attachedScreenshot ? 28 : 0;

      if (state === "idle") {
        return 4 + 4 + 8 + 8 + actualInputHeight + indicatorsRowHeight;
      }
      if (state === "thinking") {
        return basePadding + actualInputHeight + 12 + 50;
      }

      // Responding - if no content yet, use minimum
      if (!response || response.trim() === "") {
        return basePadding + actualInputHeight + 12 + 50;
      }

      const thoughtsHeight =
        parsed.thoughts.length > 0 ? 50 + parsed.thoughts.length * 22 + 12 : 0;
      const lineBreaks = (parsed.response.match(/\n/g) || []).length;
      const estimatedLines = Math.max(
        lineBreaks + 1,
        Math.ceil(parsed.response.length / 55)
      );
      const markdownMultiplier =
        parsed.response.includes("```") || parsed.response.includes("$$")
          ? 1.4
          : 1.2;
      const contentHeight = estimatedLines * 21 * markdownMultiplier;
      const actualContentHeight = Math.min(contentHeight, 350);
      const totalHeight =
        basePadding +
        actualInputHeight +
        12 +
        thoughtsHeight +
        actualContentHeight;

      return Math.round(Math.min(550, Math.max(120, totalHeight)));
    })();

    console.log(
      "[Renderer] Resizing to:",
      height,
      "state:",
      state,
      "responseLen:",
      response.length
    );
    window.electron?.resizeWindow(height);
  }, [
    state,
    response,
    parsed.response,
    parsed.thoughts.length,
    attachedScreenshot,
    inputHeight, // Include inputHeight in dependencies
  ]);

  return (
    <Panel compact={state === "idle"}>
      {/* Screenshot indicator */}
      {attachedScreenshot && state === "idle" && (
        <div className="flex items-center gap-2 mb-1.5 px-1">
          <div className="flex items-center gap-1.5 px-2 py-0.5 bg-blue-500/20 rounded text-xs text-blue-400">
            <img
              src={`data:image/png;base64,${attachedScreenshot}`}
              alt="Screenshot"
              className="w-6 h-4 object-cover rounded opacity-80"
            />
            <button
              onClick={handleClearScreenshot}
              className="ml-1 hover:text-blue-300 text-blue-500"
              title="Remove screenshot"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <Input
        ref={inputRef}
        onSubmit={handleSubmit}
        isListening={isListening}
        onListeningChange={setIsListening}
        disabled={state === "thinking"}
        provider={provider}
        onProviderChange={handleProviderChange}
        onHeightChange={handleInputHeightChange}
      />

      {state === "thinking" && <ThinkingBar status={status} isActive={true} />}

      {state === "responding" && (
        <ResponseDisplay thoughts={parsed.thoughts} content={parsed.response} />
      )}
    </Panel>
  );
}
