import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";

type Direction = "incoming" | "outgoing";

interface LogLine {
  direction: Direction;
  payload: string;
}

interface LMModel {
  id: string;
  [key: string]: unknown;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";
const MCP_ENDPOINT = import.meta.env.VITE_MCP_WS ?? "ws://localhost:8000/mcp";

const json = (value: unknown) => JSON.stringify(value, null, 2);

export default function App() {
  const [health, setHealth] = useState("Checking…");
  const [healthError, setHealthError] = useState<string | null>(null);
  const [socketState, setSocketState] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [socketError, setSocketError] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [models, setModels] = useState<LMModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectingModel, setSelectingModel] = useState(false);
  const [selectError, setSelectError] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatResponse, setChatResponse] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [isSendingChat, setIsSendingChat] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);

  const fetchModels = useCallback(
    async (signal?: AbortSignal) => {
      setModelsLoading(true);
      setModelsError(null);
      try {
        const response = await fetch(`${API_BASE}/lm/models`, { signal });
        if (!response.ok) {
          throw new Error(`Failed to load models (${response.status})`);
        }
        const payload = await response.json();
        const nextModels = Array.isArray(payload.models) ? payload.models : [];
        setModels(nextModels);
        setSelectedModel(payload.selected_model ?? null);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setModelsError((error as Error).message);
      } finally {
        setModelsLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    const controller = new AbortController();
    const fetchHealth = async () => {
      try {
        const response = await fetch(`${API_BASE}/health`, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Unexpected status: ${response.status}`);
        }
        const payload = await response.json();
        setHealth(payload.status ?? "ok");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setHealthError((error as Error).message);
      }
    };

    fetchHealth();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchModels(controller.signal);
    return () => controller.abort();
  }, [fetchModels]);

  useEffect(() => {
    setSocketState("connecting");
    setSocketError(null);

    const socket = new WebSocket(MCP_ENDPOINT);
    socketRef.current = socket;
    let closedByCleanup = false;

    socket.addEventListener("open", () => {
      setSocketState("connected");
      setSocketError(null);
    });

    socket.addEventListener("close", (event) => {
      setSocketState("disconnected");
      if (!closedByCleanup && !event.wasClean) {
        setSocketError("WebSocket closed unexpectedly");
      }
    });

    socket.addEventListener("error", () => {
      setSocketError("WebSocket error");
    });

    socket.addEventListener("message", (event) => {
      setLog((prev) => [...prev, { direction: "incoming", payload: event.data }]);
    });

    return () => {
      closedByCleanup = true;
      socket.close();
      socketRef.current = null;
    };
  }, []);

  const isConnected = useMemo(() => socketState === "connected", [socketState]);
  const isChatDisabled = useMemo(
    () => isSendingChat || !selectedModel || chatInput.trim().length === 0,
    [isSendingChat, selectedModel, chatInput]
  );

  const handleRefreshModels = () => {
    setSelectError(null);
    fetchModels();
  };

  const handleModelChange = async (event: ChangeEvent<HTMLSelectElement>) => {
    const nextModel = event.target.value || null;
    if (nextModel === selectedModel) {
      return;
    }

    setSelectError(null);

    if (!nextModel) {
      setSelectedModel(null);
      return;
    }

    const previousModel = selectedModel;
    setSelectedModel(nextModel);
    setSelectingModel(true);

    try {
      const response = await fetch(`${API_BASE}/lm/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: nextModel })
      });
      if (!response.ok) {
        throw new Error(`Failed to select model (${response.status})`);
      }
      const payload = await response.json();
      setSelectedModel(payload.selected_model ?? nextModel);
    } catch (error) {
      setSelectedModel(previousModel);
      setSelectError((error as Error).message);
    } finally {
      setSelectingModel(false);
    }
  };

  const handleChatInputChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setChatInput(event.target.value);
  };

  const handleChatSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chatInput.trim()) {
      return;
    }

    setChatError(null);
    setChatResponse(null);
    setIsSendingChat(true);

    try {
      const response = await fetch(`${API_BASE}/lm/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: chatInput }],
          model: selectedModel ?? undefined
        })
      });
      let payload: unknown = null;
      if (!response.ok) {
        try {
          payload = await response.json();
        } catch (parseError) {
          // ignore parse errors so we can surface the original status text instead
        }
        const detail =
          payload && typeof payload === "object" && "detail" in payload ? (payload as { detail: unknown }).detail : null;
        const message =
          typeof detail === "string"
            ? detail
            : `Chat request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})`;
        throw new Error(message);
      }
      payload = await response.json();
      setChatResponse(json(payload));
    } catch (error) {
      setChatError((error as Error).message);
    } finally {
      setIsSendingChat(false);
    }
  };

  const sendMessage = (payload: unknown) => {
    if (!isConnected || !socketRef.current) {
      setSocketError("WebSocket is not connected");
      return;
    }

    const serialized = json(payload);
    socketRef.current.send(serialized);
    setLog((prev) => [...prev, { direction: "outgoing", payload: serialized }]);
  };

  const handlePing = () => {
    sendMessage({ jsonrpc: "2.0", id: Date.now(), method: "ping" });
  };

  const handleListResources = () => {
    sendMessage({ jsonrpc: "2.0", id: Date.now(), method: "resources/list" });
  };

  const handleReadStatus = () => {
    sendMessage({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "resources/read",
      params: { name: "status" }
    });
  };

  const resetLog = () => setLog([]);

  return (
    <main style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>Local LLM Playground</h1>
        <div>
          <strong>Backend health:</strong> {healthError ? <span style={styles.error}>{healthError}</span> : health}
        </div>
        <div>
          <strong>MCP status:</strong> {socketState}
          {socketError ? <span style={styles.error}> — {socketError}</span> : null}
        </div>
      </header>

      <section style={styles.controls}>
        <button onClick={handlePing} disabled={!isConnected}>
          Send ping
        </button>
        <button onClick={handleListResources} disabled={!isConnected}>
          List resources
        </button>
        <button onClick={handleReadStatus} disabled={!isConnected}>
          Read status
        </button>
        <button onClick={resetLog} type="button">
          Clear log
        </button>
      </section>

      <section style={styles.lmSection}>
        <h2 style={styles.subtitle}>LM Studio</h2>
        <div style={styles.sectionRow}>
          <button type="button" onClick={handleRefreshModels} disabled={modelsLoading}>
            {modelsLoading ? "Refreshing…" : "Refresh models"}
          </button>
          <span style={styles.muted}>
            Active model: {selectedModel ?? "None"}
            {selectingModel ? " (updating…)" : null}
          </span>
        </div>
        {modelsError ? <div style={styles.error}>{modelsError}</div> : null}
        <label style={styles.labelRow}>
          <span>Choose model:</span>
          <select
            value={selectedModel ?? ""}
            onChange={handleModelChange}
            disabled={modelsLoading || selectingModel}
            style={styles.select}
          >
            <option value="">Select a model…</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.id}
              </option>
            ))}
          </select>
        </label>
        {selectError ? <div style={styles.error}>{selectError}</div> : null}
        <form onSubmit={handleChatSubmit} style={styles.chatForm}>
          <label htmlFor="chat-input">Prompt</label>
          <textarea
            id="chat-input"
            value={chatInput}
            onChange={handleChatInputChange}
            placeholder="Ask anything…"
            rows={6}
            style={styles.textarea}
          />
          <button type="submit" disabled={isChatDisabled}>
            {isSendingChat ? "Sending…" : "Send to model"}
          </button>
        </form>
        {chatError ? <div style={styles.error}>{chatError}</div> : null}
        {chatResponse ? <pre style={styles.chatOutput}>{chatResponse}</pre> : null}
      </section>

      <section style={styles.log}>
        <h2 style={styles.subtitle}>WebSocket traffic</h2>
        <pre style={styles.pre}>
          {log.length === 0
            ? "Interact with the buttons above once the MCP connection is ready."
            : log
                .map(({ direction, payload }) => `${direction === "outgoing" ? "⇢" : "⇠"} ${payload}`)
                .join("\n\n")}
        </pre>
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    fontFamily: "system-ui, sans-serif",
    margin: "0 auto",
    maxWidth: "900px",
    padding: "2rem"
  },
  header: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    marginBottom: "1.5rem"
  },
  title: {
    fontSize: "2.5rem",
    margin: 0
  },
  controls: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.75rem",
    marginBottom: "1.5rem"
  },
  lmSection: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    marginBottom: "1.5rem",
    border: "1px solid #d0d7de",
    borderRadius: "0.75rem",
    padding: "1rem",
    background: "#fff"
  },
  sectionRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    flexWrap: "wrap"
  },
  muted: {
    color: "#57606a"
  },
  labelRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    flexWrap: "wrap"
  },
  select: {
    fontSize: "1rem",
    padding: "0.35rem 0.5rem",
    borderRadius: "0.5rem",
    border: "1px solid #d0d7de",
    minWidth: "200px"
  },
  chatForm: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem"
  },
  textarea: {
    fontFamily: "inherit",
    fontSize: "1rem",
    padding: "0.5rem",
    borderRadius: "0.5rem",
    border: "1px solid #d0d7de",
    minHeight: "140px"
  },
  chatOutput: {
    margin: 0,
    background: "#f6f8fa",
    borderRadius: "0.5rem",
    padding: "0.75rem",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word"
  },
  log: {
    border: "1px solid #d0d7de",
    borderRadius: "0.75rem",
    padding: "1rem",
    background: "#f6f8fa"
  },
  pre: {
    margin: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word"
  },
  subtitle: {
    marginBottom: "0.75rem"
  },
  error: {
    color: "#d0342c"
  }
};
