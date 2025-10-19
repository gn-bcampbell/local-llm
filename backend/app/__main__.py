from __future__ import annotations
import os
import uvicorn

def main() -> None:
    uvicorn.run(
        "app.main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
        reload=os.getenv("UVICORN_RELOAD", "true").lower() == "true",
    )

if __name__ == "__main__":
    main()
