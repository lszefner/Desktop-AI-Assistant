import React, {
  forwardRef,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";

interface InputProps {
  onSubmit: (value: string) => void;
  isListening: boolean;
  onListeningChange: (listening: boolean) => void;
  disabled?: boolean;
  provider?: "openai" | "ollama";
  onProviderChange?: (provider: "openai" | "ollama") => void;
  onHeightChange?: (height: number) => void;
}

export const Input = forwardRef<HTMLTextAreaElement, InputProps>(
  (
    {
      onSubmit,
      isListening,
      onListeningChange,
      disabled,
      provider = "openai",
      onProviderChange,
      onHeightChange,
    },
    ref
  ) => {
    const [value, setValue] = useState("");
    const [isTranscribing, setIsTranscribing] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);

    // Merge refs
    useEffect(() => {
      if (ref && textareaRef.current) {
        if (typeof ref === "function") {
          ref(textareaRef.current);
        } else {
          (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current =
            textareaRef.current;
        }
      }
    }, [ref]);

    // Auto-resize textarea based on content
    useEffect(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        const newHeight = Math.min(textareaRef.current.scrollHeight, 120);
        textareaRef.current.style.height = `${newHeight}px`;
        // Notify parent of height change
        if (onHeightChange) {
          onHeightChange(newHeight);
        }
      }
    }, [value, onHeightChange]);

    // Initial height measurement on mount
    useEffect(() => {
      if (textareaRef.current && onHeightChange) {
        const initialHeight = Math.min(textareaRef.current.scrollHeight, 120);
        onHeightChange(initialHeight);
      }
    }, [onHeightChange]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && value.trim()) {
        e.preventDefault();
        onSubmit(value);
        setValue("");
      }
      if (e.key === "Escape") {
        window.electron?.hideWindow();
      }
    };

    const startRecording = useCallback(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        const mediaRecorder = new MediaRecorder(stream, {
          mimeType: "audio/webm;codecs=opus",
        });

        audioChunksRef.current = [];

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        mediaRecorder.onstop = async () => {
          // Stop all tracks
          stream.getTracks().forEach((track) => track.stop());

          if (audioChunksRef.current.length === 0) {
            onListeningChange(false);
            return;
          }

          setIsTranscribing(true);

          try {
            // Convert audio to blob
            const audioBlob = new Blob(audioChunksRef.current, {
              type: "audio/webm",
            });

            // Convert to base64
            const reader = new FileReader();
            reader.onloadend = async () => {
              const base64Audio = (reader.result as string).split(",")[1];

              // Send to main process for transcription
              console.log("[Input] Sending audio for transcription...");
              const result = await window.electron?.transcribeAudio(
                base64Audio
              );

              if (result?.success && result.transcript) {
                console.log("[Input] Transcription:", result.transcript);
                setValue(result.transcript);

                // Auto-submit if we have meaningful text
                if (result.transcript.trim().split(" ").length >= 2) {
                  onSubmit(result.transcript);
                  setValue("");
                }
              } else {
                console.error("[Input] Transcription failed:", result?.error);
              }

              setIsTranscribing(false);
              onListeningChange(false);
            };

            reader.readAsDataURL(audioBlob);
          } catch (error) {
            console.error("[Input] Error processing audio:", error);
            setIsTranscribing(false);
            onListeningChange(false);
          }
        };

        mediaRecorderRef.current = mediaRecorder;
        mediaRecorder.start();
        onListeningChange(true);
        setValue("");

        console.log("[Input] Recording started...");
      } catch (error) {
        console.error("[Input] Failed to start recording:", error);
        onListeningChange(false);
      }
    }, [onListeningChange, onSubmit]);

    const stopRecording = useCallback(() => {
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state === "recording"
      ) {
        console.log("[Input] Stopping recording...");
        mediaRecorderRef.current.stop();
      }
    }, []);

    const toggleListening = useCallback(() => {
      if (isListening) {
        stopRecording();
      } else {
        startRecording();
      }
    }, [isListening, startRecording, stopRecording]);

    const toggleProvider = useCallback(() => {
      if (onProviderChange) {
        // Toggle between: openai <-> ollama
        const nextProvider = provider === "openai" ? "ollama" : "openai";
        onProviderChange(nextProvider);
      }
    }, [provider, onProviderChange]);

    return (
      <div className="flex gap-2 items-end">
        <button
          onClick={toggleProvider}
          disabled={disabled || isTranscribing}
          title={
            provider === "openai"
              ? "Switch to Ollama (Local)"
              : "Switch to OpenAI (Cloud)"
          }
          className={`
              w-10 h-10
              flex items-center justify-center
              rounded-lg
              transition-all
              duration-200
              bg-black/85 text-white/60 hover:text-white/80
              ${
                disabled || isTranscribing
                  ? "cursor-not-allowed opacity-50"
                  : "cursor-pointer"
              }
            `}
          style={{ marginRight: "6px" }}
        >
          {provider === "openai" ? (
            <span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width={22}
                height={22}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="feather feather-cloud"
              >
                <path d="M17.5 19a4.5 4.5 0 0 0 0-9 5 5 0 1 0-9.33 4.18A5 5 0 0 0 6.5 19z" />
              </svg>
            </span>
          ) : (
            <span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width={22}
                height={22}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="feather feather-monitor"
              >
                <rect x={2} y={3} width={20} height={14} rx={2} />
                <line x1={8} y1={21} x2={16} y2={21} />
                <line x1={12} y1={17} x2={12} y2={21} />
              </svg>
            </span>
          )}
        </button>

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isTranscribing
              ? "Transcribing..."
              : isListening
              ? "Listening... click to stop"
              : "Whats on your mind?"
          }
          disabled={disabled || isTranscribing}
          rows={1}
          className={`
            flex-1
            bg-black/85
            text-white
            placeholder-white
            rounded-lg
            px-4 py-2.5
            text-[14px]
            border
            border-white/10
            shadow-lg
            shadow-black/30
            transition-all
            duration-200
            resize-none
            overflow-hidden
            min-h-[44px]
            outline-none
            focus:outline-none
            focus:border-white/20
            ${(isListening || isTranscribing) && "bg-black/40 border-white/15"}
            ${disabled ? "cursor-not-allowed opacity-50" : ""}
          `}
          style={{ lineHeight: "1.4" }}
        />

        <button
          onClick={toggleListening}
          disabled={disabled || isTranscribing}
          title={isListening ? "Stop recording" : "Start voice input (Whisper)"}
          className={`
            w-10 h-10
            flex items-center justify-center
            rounded-lg
            transition-all
            duration-200
            ${
              isTranscribing
                ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                : isListening
                ? "bg-red-500/20 text-red-400 border border-red-500/30 animate-pulse"
                : "bg-black/85 text-white/60 hover:text-white/80"
            }
            ${
              disabled || isTranscribing
                ? "cursor-not-allowed opacity-50"
                : "cursor-pointer"
            }
          `}
        >
          {isTranscribing ? <LoadingIcon /> : <MicIcon />}
        </button>
      </div>
    );
  }
);

function MicIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M19 10a7 7 0 0 1-14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function LoadingIcon() {
  return (
    <svg
      className="animate-spin"
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" strokeOpacity="1" />
    </svg>
  );
}
