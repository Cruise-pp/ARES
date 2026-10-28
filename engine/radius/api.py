"""The nine endpoints of page 31d, plus /feed and /record (engine only). CORS open for the screens.

    uvicorn radius.api:app --port 8000
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .service import NotExact, Radius


class ParseBody(BaseModel):
    text: str
    lane: str | None = None


class FireBody(BaseModel):
    change: dict
    mode: str = "live"


class ResumeBody(BaseModel):
    reason: str = ""


class VersionBody(BaseModel):
    version: str


class FeedBody(BaseModel):
    payload: str


def create_app(radius: Radius | None = None) -> FastAPI:
    box = {"r": radius}

    @asynccontextmanager
    async def lifespan(_):
        if box["r"] is None:
            box["r"] = Radius(background=True)  # owner messages finish after the response
        yield

    app = FastAPI(title="Radius engine", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                       allow_methods=["*"], allow_headers=["*"])
    R = lambda: box["r"]

    def found(x, what: str):
        if x is None:
            raise HTTPException(404, f"no such {what}")
        return x

    @app.get("/graph")
    def graph():
        return R().graph_view()

    @app.post("/changes/parse")
    def changes_parse(body: ParseBody):
        return R().parse(body.text, body.lane)

    @app.post("/changes")
    def changes_fire(body: FireBody):
        if body.mode not in ("live", "preview"):
            raise HTTPException(422, "mode is live or preview")
        try:
            return R().fire(body.change, body.mode)
        except NotExact as e:
            return JSONResponse(status_code=409, content=e.parsed)

    @app.get("/changes")
    def changes_list():
        return R().changes()

    @app.get("/runs/{run_id}")
    def run(run_id: str):
        return found(R().run(run_id), "run")

    @app.post("/workflows/{wf_id}/resume")
    def resume(wf_id: str, body: ResumeBody):
        try:
            return R().resume(wf_id, body.reason)
        except KeyError:
            raise HTTPException(404, "no such workflow")
        except ValueError as e:
            raise HTTPException(422, str(e))

    @app.get("/tasks/{task_id}")
    def task(task_id: str):
        return found(R().task(task_id), "task")

    @app.post("/tasks/{task_id}/accept")
    def accept(task_id: str):
        try:
            return R().accept(task_id)
        except KeyError:
            raise HTTPException(404, "no such task")

    @app.post("/tools/{tool_id}/version")
    def tool_version(tool_id: str, body: VersionBody):
        try:
            return R().tool_version(tool_id, body.version)
        except KeyError:
            raise HTTPException(404, "no such tool")

    @app.post("/feed")
    def feed(body: FeedBody):
        return R().feed(body.payload)

    @app.get("/record")
    def record():
        return R().record()

    return app


app = create_app()
