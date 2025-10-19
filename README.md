# Local LLM App

This repository contains a FastAPI backend that exposes an MCP-compatible WebSocket endpoint and a React/Vite frontend that exercises the APIs.

## Project layout

- `backend/` – FastAPI application with a lightweight MCP server loop (`app/main.py`).
- `frontend/` – React + Vite client that connects to the backend REST API and MCP WebSocket.

## Backend

```bash
cd backend
cp .env.example .env  # optional, tweak values as needed
python -m venv .venv
source .venv/bin/activate
pip install -e .
python -m app
```

By default the API runs on `http://localhost:8000` and the MCP WebSocket is available at `ws://localhost:8000/mcp`. CORS is configured to allow the Vite dev server on port `5173`. Adjust values in `.env` if you host elsewhere.

## Frontend

```bash
cd frontend
cp .env.example .env  # optional overrides
npm install
npm run dev
```

The Vite dev server defaults to `http://localhost:5173` and proxies `/api` requests to the backend. The UI automatically connects to the MCP endpoint and provides quick buttons to send `ping`, list resources, and read the sample `status` resource.

## Extending the MCP server

- Implement new methods inside `backend/app/main.py` by updating `MCPServer._handle_message`.
- The `backend/mcp/` package is a placeholder for more complex handlers or model integrations.
- Replace the stubbed `"models_loaded"` data in `_read_resource` with real model state once available.

## Next steps

- Add automated tests (see `backend/pyproject.toml` dev dependencies) to cover API routes and MCP behaviour.
- Containerise the services or introduce docker-compose for a single command dev environment.
- Secure the WebSocket with authentication if exposing beyond local development.
# local-llm
