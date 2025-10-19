from __future__ import annotations

import asyncio
import logging
import os
import json
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field


logger = logging.getLogger(__name__)

load_dotenv()

LM_STUDIO_BASE_URL = os.getenv("http://127.0.0.1:1234", "http://127.0.0.1:1234")


class LMStudioAPIError(RuntimeError):
    """Represents an upstream LM Studio error that includes an optional status code."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class LMStudioClient:
    """Thin client wrapper around the LM Studio API."""

    def __init__(self, base_url: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._selected_model: str | None = None
        self._cached_models: list[dict[str, Any]] = []

    @property
    def selected_model(self) -> str | None:
        return self._selected_model

    @property
    def cached_models(self) -> list[dict[str, Any]]:
        return self._cached_models

    async def list_models(self, timeout: httpx.Timeout | None = None) -> list[dict[str, Any]]:
        timeout = timeout or httpx.Timeout(10.0)
        try:
            async with httpx.AsyncClient(base_url=self._base_url, timeout=timeout) as client:
                response = await client.get("/v1/models")
                response.raise_for_status()
        except httpx.HTTPStatusError as exc:  # pragma: no cover - propagate upstream error codes
            raise LMStudioAPIError(
                f"LM Studio /v1/models responded with {exc.response.status_code}: {exc.response.text}",
                status_code=exc.response.status_code,
            ) from exc
        except httpx.HTTPError as exc:  # pragma: no cover - simple network guard
            raise LMStudioAPIError(f"LM Studio /v1/models request failed: {exc}") from exc

        payload = response.json()
        if isinstance(payload, dict):
            models_data = payload.get("data")
        elif isinstance(payload, list):
            models_data = payload
        else:
            models_data = None

        if not isinstance(models_data, list):
            raise RuntimeError("Unexpected models payload from LM Studio")

        self._cached_models = models_data
        if self._selected_model and not any(model.get("id") == self._selected_model for model in models_data):
            self._selected_model = None
        return models_data

    async def select_model(self, model_id: str) -> str:
        if not self._cached_models:
            await self.list_models()

        if not any(model.get("id") == model_id for model in self._cached_models):
            raise ValueError(f"Model '{model_id}' not available in LM Studio")

        self._selected_model = model_id
        return model_id

    async def create_chat_completion(self, payload: dict[str, Any]) -> dict[str, Any]:
        effective_payload = payload.copy()
        model = effective_payload.get("model") or self._selected_model
        if not model:
            raise ValueError("No model supplied and no model has been selected")
        effective_payload["model"] = model

        try:
            async with httpx.AsyncClient(base_url=self._base_url, timeout=httpx.Timeout(60.0)) as client:
                response = await client.post("/v1/chat/completions", json=effective_payload)
                response.raise_for_status()
        except httpx.HTTPStatusError as exc:  # pragma: no cover - passthrough of upstream errors
            raise LMStudioAPIError(
                f"LM Studio /v1/chat/completions responded with {exc.response.status_code}: {exc.response.text}",
                status_code=exc.response.status_code,
            ) from exc
        except httpx.HTTPError as exc:  # pragma: no cover - network guard
            raise LMStudioAPIError(f"LM Studio chat request failed: {exc}") from exc

        return response.json()


def get_allowed_origins() -> list[str]:
    """Returns the list of allowed origins for CORS."""
    vite_origin = os.getenv("VITE_DEV_SERVER", "http://localhost:5173")
    extra = os.getenv("ADDITIONAL_ORIGINS", "")
    if extra:
        return [vite_origin, *[origin.strip() for origin in extra.split(",") if origin.strip()]]
    return [vite_origin]


class MCPServer:
    """Tiny MCP server skeleton that speaks JSON-RPC over WebSocket.

    It implements a single resource so the frontend can probe the LLM status.
    Extend the `handle_request` method to wire in real tools or model logic.
    """

    def __init__(self, model_client: LMStudioClient | None = None) -> None:
        self._resource_cache = [{"name": "status", "description": "Static server status resource."}]
        self._model_client = model_client

    async def connection_loop(self, websocket: WebSocket) -> None:
        await websocket.accept()
        await websocket.send_json(
            {
                "jsonrpc": "2.0",
                "method": "session/welcome",
                "params": {"message": "MCP server ready"},
            },
        )

        try:
            while True:
                raw_message = await websocket.receive_text()
                response = await self._handle_message(raw_message)
                if response is not None:
                    await websocket.send_text(response)
        except WebSocketDisconnect:
            logger.info("MCP client disconnected")
        except Exception:  # pragma: no cover - defensive; logs unexpected exceptions
            logger.exception("Error while handling MCP connection")

    async def _handle_message(self, raw_message: str) -> str | None:
        try:
            message = json.loads(raw_message)
        except json.JSONDecodeError:
            logger.warning("Received non-JSON MCP message: %s", raw_message)
            return json.dumps(
                {
                    "jsonrpc": "2.0",
                    "error": {"code": -32700, "message": "Invalid JSON payload"},
                },
            )

        if message.get("jsonrpc") != "2.0":
            return json.dumps(
                {
                    "jsonrpc": "2.0",
                    "error": {"code": -32600, "message": "Only JSON-RPC 2.0 is supported"},
                },
            )

        method = message.get("method")
        request_id = message.get("id")
        params = message.get("params", {})

        result: Any
        if method == "ping":
            result = {"message": "pong", "timestamp": asyncio.get_running_loop().time()}
        elif method == "resources/list":
            result = {"resources": self._resource_cache}
        elif method == "resources/read":
            resource_name = params.get("name")
            result = {"content": self._read_resource(resource_name)}
        else:
            return json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {
                        "code": -32601,
                        "message": f"Unknown method: {method}",
                    },
                },
            )

        return json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result})

    def _read_resource(self, resource_name: str | None) -> dict[str, Any]:
        if resource_name != "status":
            return {"state": "unknown resource"}

        models_loaded: list[str] = []
        selected = None
        if self._model_client is not None:
            models_loaded = [model.get("id", "?") for model in self._model_client.cached_models]
            selected = self._model_client.selected_model

        return {
            "state": "ok",
            "details": {
                "models_loaded": models_loaded,
                "selected_model": selected,
                "uptime_seconds": 0,
            },
        }


class SelectModelRequest(BaseModel):
    model: str = Field(..., min_length=1)


class ChatCompletionRequest(BaseModel):
    messages: list[dict[str, Any]]
    model: str | None = None
    temperature: float | None = None
    max_tokens: int | None = Field(default=None, alias="max_tokens")
    top_p: float | None = Field(default=None, alias="top_p")
    frequency_penalty: float | None = Field(default=None, alias="frequency_penalty")
    presence_penalty: float | None = Field(default=None, alias="presence_penalty")
    stop: list[str] | None = None

    model_config = ConfigDict(populate_by_name=True, extra="allow")


lm_client = LMStudioClient(LM_STUDIO_BASE_URL)
mcp_server = MCPServer(model_client=lm_client)

app = FastAPI(title="Local LLM Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok"})


@app.websocket("/mcp")
async def mcp_endpoint(websocket: WebSocket) -> None:
    await mcp_server.connection_loop(websocket)


@app.get("/lm/models")
async def list_lm_models() -> JSONResponse:
    try:
        models = await lm_client.list_models()
    except LMStudioAPIError as error:
        raise HTTPException(
            status_code=error.status_code or status.HTTP_502_BAD_GATEWAY,
            detail=str(error),
        ) from error

    return JSONResponse({"models": models, "selected_model": lm_client.selected_model})


@app.get("/lm/selection")
async def get_lm_selection() -> JSONResponse:
    return JSONResponse({"selected_model": lm_client.selected_model})


@app.post("/lm/select")
async def select_lm_model(request: SelectModelRequest) -> JSONResponse:
    try:
        selected = await lm_client.select_model(request.model)
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(error),
        ) from error
    except LMStudioAPIError as error:
        raise HTTPException(
            status_code=error.status_code or status.HTTP_502_BAD_GATEWAY,
            detail=str(error),
        ) from error

    return JSONResponse({"selected_model": selected})


@app.post("/lm/chat")
async def lm_chat_completion(request: ChatCompletionRequest) -> JSONResponse:
    payload = request.model_dump(by_alias=True, exclude_none=True)
    try:
        response = await lm_client.create_chat_completion(payload)
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(error),
        ) from error
    except LMStudioAPIError as error:
        raise HTTPException(
            status_code=error.status_code or status.HTTP_502_BAD_GATEWAY,
            detail=str(error),
        ) from error

    return JSONResponse(response)
