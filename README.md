# AI Desktop Assistant

An intelligent desktop assistant built with Electron, React, and TypeScript. Provides AI-powered assistance with Google Calendar, Tasks, Email integration, browser automation, and proactive monitoring.

## Features

### Core Capabilities

- **AI-Powered Interactions**: Support for both OpenAI GPT and local Ollama models
- **Voice Input**: Whisper-based voice transcription for hands-free interaction
- **Google Integration**: Seamless integration with Google Calendar, Tasks, and Gmail
- **Browser Automation**: Automated web browsing and interaction using Playwright
- **Screen Analysis**: Visual understanding using screenshot analysis
- **Proactive Monitoring**: Intelligent background monitoring and notifications

### Proactive Features

The assistant includes a comprehensive proactive monitoring system that operates in the background:

- **Timekeeper**: Meeting briefings, morning briefs, and calendar management
- **Executive Function**: Task deadline reminders and stale task detection
- **Gatekeeper**: AI-powered email importance analysis and filtering
- **System Watchdog**: Resource monitoring and system health alerts

### User Interface

- **Minimalist Design**: Transparent, always-on-top window
- **Quick Access**: Global hotkey (Ctrl+Y) to toggle visibility and Ctrl+H to add a screenshot
- **Real-time Status**: Live updates on agent progress and thinking
- **Markdown Support**: Rich text rendering with LaTeX math support

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Electron Main Process                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ AgentService │  │ GoogleService│  │BrowserService│  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │SystemService │  │ProactiveSvc  │  │WhisperService│  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
                        ↕ IPC
┌─────────────────────────────────────────────────────────┐
│                 Electron Renderer Process                │
│            React + TypeScript + TailwindCSS              │
│  ┌──────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │   App    │  │    Input     │  │ ResponseDisplay │   │
│  └──────────┘  └──────────────┘  └─────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Setup

### Prerequisites

- Node.js 18+ and npm
- Google Cloud Console project with API credentials
- (Optional) Ollama installed for local AI model support
- (Optional) OpenAI API key for cloud AI

### Installation

1. Clone the repository

```bash
git clone <repository-url>
cd assistant
```

2. Install dependencies

```bash
npm install
```

3. Configure environment variables

Create a `.env` file in the project root:

```env
# AI Provider Configuration
OPENAI_API_KEY=your_openai_api_key_here
USE_OLLAMA=true  # Set to true to enable local Ollama
OLLAMA_MODEL=qwen2.5:3b  # Model to use if USE_OLLAMA=true
USE_LOCAL_PROACTIVE=true  # Use Ollama for proactive features
DEBUG=false # For debugging logs
```

4. Set up Google OAuth

   a. Download Google Cloud credentials:

   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select existing one
   - Enable APIs: Google Tasks API, Google Calendar API, Gmail API
   - Create OAuth 2.0 credentials (Desktop app type)
   - Download credentials and save as `credentials.json` in project root

   b. Run OAuth flow:

   ```bash
   npm run oauth
   ```

   Or authenticate through the app's UI on first run.

### Development

Run the development server:

```bash
npm run dev
```

This starts:

- TypeScript compilation for main process (watch mode)
- Vite dev server for renderer process (port 5173)
- Electron application

### Building

Build for production:

```bash
npm run build
npm start  # Or npm run preview
```

## Configuration

### Environment Variables

| Variable              | Description                                    | Default           |
| --------------------- | ---------------------------------------------- | ----------------- |
| `OPENAI_API_KEY`      | OpenAI API key for cloud AI                    | Required          |
| `USE_OLLAMA`          | Enable ollama for conversations with the agent | `true`            |
| `OLLAMA_MODEL`        | Ollama model name                              | `llama3.2:latest` |
| `USE_LOCAL_PROACTIVE` | Use Ollama for proactive features              | `true`            |
| `ASSISTANT_NAME`      | Assistant name in UI                           | `Assistant`       |
| `DEBUG`               | Debugging in console                           | `false`           |

### Google OAuth Setup

1. Place `credentials.json` in project root
2. On first run, the app will prompt for OAuth authentication
3. Complete the OAuth flow in your browser
4. Token is saved to `token.json` (auto-refreshed when expired)

## Usage

### Keyboard Shortcuts

- `Ctrl+Y` (or `Cmd+Y` on Mac): Toggle assistant window
- `Ctrl+H`: Capture screenshot and attach to next message
- `Escape`: Hide assistant window
- `Enter`: Send message (Shift+Enter for new line)

### Voice Input

Click the microphone button to start voice input. The assistant uses Whisper for speech-to-text transcription.

### AI Provider Switching

Toggle between OpenAI and Ollama using the cloud/monitor icon in the input field.

### Proactive Features

The assistant automatically monitors:

- **Meetings**: Sends briefings 5 minutes before meetings start
- **Tasks**: Reminds about deadlines 2 hours before due date
- **Emails**: Analyzes and notifies about important emails
- **System**: Monitors resource usage and alerts on high CPU/memory

Proactive checks run every 2 minutes by default.

## Project Structure

```
assistant/
├── src/
│   ├── main/                 # Electron main process
│   │   ├── main.ts          # Main entry point
│   │   ├── preload.ts       # Preload script
│   │   ├── services/        # Service modules
│   │   │   ├── agent.ts     # AI agent service
│   │   │   ├── google.ts    # Google API integration
│   │   │   ├── browser.ts   # Browser automation
│   │   │   ├── proactive.ts # Proactive monitoring
│   │   │   └── ...
│   │   └── utils/
│   │       └── logger.ts    # Logging utility
│   └── renderer/            # Electron renderer (UI)
│       ├── App.tsx          # Main React component
│       ├── components/      # React components
│       └── ...
├── dist/                    # Build output
├── package.json
├── tsconfig.json
└── .env                     # Environment variables (create this)
```

## API Integration

### OpenAI

The assistant uses OpenAI's GPT models for:

- Main conversation and reasoning
- Tool selection and execution
- Vision capabilities (screenshot analysis)

### Google APIs

Integrated Google APIs:

- **Calendar API**: List, search, create events
- **Tasks API**: Manage tasks and todos
- **Gmail API**: Read, search, and manage emails

### Ollama (Optional)

For local, privacy-focused operation:

- Install Ollama: https://ollama.ai/
- Pull model: `ollama pull llama3.2:latest`
- Set `USE_OLLAMA=true` in `.env`

## Development Guide

### Adding New Tools

1. Add tool definition to `TOOL_DEFINITIONS` in `src/main/services/agent.ts`
2. Register tool handler in `registerTools()` method
3. Implement service method if needed

### Adding Proactive Checks

1. Add check method to `ProactiveService` class
2. Register in `runProactiveChecks()` method
3. Use `sendNotification()` for user alerts

### Logging

Use the centralized logger:

```typescript
import { logger } from "./utils/logger.js";

logger.info("Category", "Message");
logger.error("Category", "Error message", error);
```

In production, only warnings and errors are logged.

## Troubleshooting

### Google OAuth Issues

- Ensure `credentials.json` is in project root
- Check that all required APIs are enabled in Google Cloud Console
- Verify redirect URI matches OAuth configuration

### Ollama Connection

- Ensure Ollama is running: `ollama serve`
- Verify model is available: `ollama list`
- Check `OLLAMA_MODEL` matches installed model name

### Proactive Features Not Working

- Check that Google services are initialized
- Verify OAuth token is valid
- Review console logs for errors

## License

See [LICENSE](LICENSE) file for details.

## Contributing

This is a private project. For issues or questions, contact the maintainer.

## Acknowledgments

Built with:

- [Electron](https://www.electronjs.org/) - Cross-platform desktop framework
- [React](https://react.dev/) - UI library
- [TypeScript](https://www.typescriptlang.org/) - Type safety
- [OpenAI](https://openai.com/) - AI capabilities
- [Ollama](https://ollama.ai/) - Local AI models
- [Playwright](https://playwright.dev/) - Browser automation
