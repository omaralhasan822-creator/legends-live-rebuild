"""Legends Live: real-time rooms, text chat, turn-based truth/dare, WebRTC signaling."""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import string
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
app = FastAPI(title="Legends Live", docs_url=None, redoc_url=None)
ROOMS: dict[str, "Room"] = {}
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
AVATARS = {"🦊", "🐼", "🐸", "🤖", "🐯", "🦄", "🐺", "🐱", "🐲", "🦁", "🐙", "🐰"}
MAX_PLAYERS = 10


@dataclass
class Player:
    id: str
    token: str
    name: str
    avatar: str
    score: int = 0
    ws: WebSocket | None = None
    mic: bool = False
    left_at: float | None = None
    last_chat: float = 0


@dataclass
class Room:
    code: str
    players: list[Player] = field(default_factory=list)
    host: str = ""
    phase: str = "lobby"
    active: str | None = None
    judge: str | None = None
    category: str | None = None
    ruling: str = ""
    round: int = 0
    chat: list[dict] = field(default_factory=list)
    updated: float = field(default_factory=time.monotonic)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def get(self, player_id: str | None) -> Player | None:
        return next((p for p in self.players if p.id == player_id), None)

    def public(self) -> dict:
        return {
            "code": self.code,
            "host": self.host,
            "phase": self.phase,
            "active": self.active,
            "judge": self.judge,
            "category": self.category,
            "ruling": self.ruling if self.phase in ("reveal", "results") else "",
            "round": self.round,
            "players": [{
                "id": p.id,
                "name": p.name,
                "avatar": p.avatar,
                "score": p.score,
                "online": p.ws is not None,
                "mic": p.mic,
            } for p in self.players],
            "chat": self.chat[-60:],
        }


def room_code() -> str:
    while True:
        code = "".join(secrets.choice(ALPHABET) for _ in range(6))
        if code not in ROOMS:
            return code


def safe_name(raw: Any) -> str:
    if not isinstance(raw, str):
        return "لاعب مجهول"
    value = " ".join(raw.strip().split())[:22]
    return value or "لاعب مجهول"


def avatar(raw: Any) -> str:
    return raw if raw in AVATARS else "🦊"


def text_limited(raw: Any, max_length: int) -> str:
    return raw.strip()[:max_length] if isinstance(raw, str) else ""


async def send(ws: WebSocket, event: str, **data):
    await ws.send_json({"type": event, **data})


async def publish(room: Room, event: str, **data):
    msg = {"type": event, **data}
    peers = [p.ws for p in room.players if p.ws is not None]
    if peers:
        await asyncio.gather(*(ws.send_json(msg) for ws in peers), return_exceptions=True)


async def state(room: Room):
    room.updated = time.monotonic()
    await publish(room, "room:state", state=room.public())


def next_online(room: Room, current: str | None, exclude_self: bool = False) -> str | None:
    if not room.players:
        return None
    current_index = next((i for i, p in enumerate(room.players) if p.id == current), -1)
    for n in range(1, len(room.players) + 1):
        candidate = room.players[(current_index + n) % len(room.players)]
        if candidate.ws is not None and (not exclude_self or candidate.id != current):
            return candidate.id
    return None


def fresh_player(name: Any, face: Any, ws: WebSocket) -> Player:
    return Player(id=secrets.token_hex(7), token=secrets.token_urlsafe(24), name=safe_name(name), avatar=avatar(face), ws=ws)


async def remove_player_connection(room: Room, player: Player, ws: WebSocket):
    async with room.lock:
        if player.ws is not ws:  # A replaced websocket disconnected.
            return
        player.ws = None
        player.mic = False
        player.left_at = time.monotonic()
        if room.host == player.id:
            host = next((p for p in room.players if p.ws is not None), None)
            if host:
                room.host = host.id
        if room.phase == "write" and room.judge == player.id:
            room.judge = next_online(room, room.active, exclude_self=True) or room.active
        if room.phase == "choice" and room.active == player.id:
            room.active = next_online(room, player.id) or player.id
        await publish(room, "voice:left", id=player.id)
        await state(room)


@app.websocket("/ws")
async def ws_handler(ws: WebSocket):
    await ws.accept()
    room: Room | None = None
    player: Player | None = None
    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > 12000:
                await send(ws, "error", message="الرسالة طويلة جداً")
                continue
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, dict):
                continue
            typ = payload.get("type")

            if typ in ("room:create", "room:join", "room:resume"):
                if room is not None:
                    await send(ws, "error", message="أنت موجود في غرفة بالفعل")
                    continue
                code = text_limited(payload.get("code", ""), 6).upper()
                if typ == "room:create":
                    code = room_code()
                    room = Room(code)
                    ROOMS[code] = room
                else:
                    room = ROOMS.get(code)
                    if not room:
                        await send(ws, "error", message="كود الغرفة غير صحيح أو انتهت الغرفة")
                        room = None
                        continue
                async with room.lock:
                    if typ == "room:resume":
                        token = text_limited(payload.get("token", ""), 80)
                        player = next((p for p in room.players if secrets.compare_digest(p.token, token)), None)
                        if not player:
                            await send(ws, "error", message="تعذر استعادة جلستك، ادخل من جديد")
                            room = None
                            continue
                        old_ws = player.ws
                        player.ws = ws
                        player.left_at = None
                        player.mic = False
                        if old_ws is not None and old_ws != ws:
                            try:
                                await old_ws.close(code=4001)
                            except Exception:
                                pass
                    else:
                        if len(room.players) >= MAX_PLAYERS:
                            await send(ws, "error", message="الغرفة ممتلئة (١٠ لاعبين كحد أقصى)")
                            room = None
                            continue
                        # Late-arriving friends may join an ongoing match.
                        player = fresh_player(payload.get("name"), payload.get("avatar"), ws)
                        room.players.append(player)
                        if not room.host:
                            room.host = player.id
                    await send(ws, "room:welcome", id=player.id, token=player.token, state=room.public())
                    await state(room)
                continue

            if not room or not player or player.ws is not ws:
                await send(ws, "error", message="ادخل إلى غرفة أولاً")
                continue

            async with room.lock:
                if typ == "room:start":
                    if room.host != player.id or room.phase not in ("lobby", "results"):
                        continue
                    online = [p for p in room.players if p.ws is not None]
                    if not online:
                        continue
                    if room.phase == "results":
                        for p in room.players:
                            p.score = 0
                    room.round = 1
                    room.phase = "choice"
                    room.active = online[0].id
                    room.judge = None
                    room.category = None
                    room.ruling = ""
                    await state(room)

                elif typ == "game:pick":
                    if room.phase != "choice" or room.active != player.id:
                        continue
                    category = payload.get("category")
                    if category not in ("truth", "dare"):
                        continue
                    room.category = category
                    room.judge = next_online(room, room.active, exclude_self=True) or room.active
                    room.ruling = ""
                    room.phase = "write"
                    await state(room)

                elif typ == "game:submit":
                    if room.phase != "write" or room.judge != player.id:
                        continue
                    ruling = text_limited(payload.get("ruling"), 220)
                    if len(ruling) < 3:
                        await send(ws, "error", message="اكتب حكماً من ثلاثة أحرف على الأقل")
                        continue
                    room.ruling = ruling
                    room.phase = "reveal"
                    await state(room)

                elif typ == "game:complete":
                    if room.phase != "reveal" or player.id not in (room.active, room.host):
                        continue
                    if payload.get("result") not in ("done", "skip"):
                        continue
                    target = room.get(room.active)
                    if target and payload["result"] == "done":
                        target.score += 10
                    room.round += 1
                    room.active = next_online(room, room.active)
                    room.phase = "choice" if room.active else "results"
                    room.judge = None
                    room.category = None
                    room.ruling = ""
                    await state(room)

                elif typ == "room:end":
                    if player.id != room.host or room.phase == "lobby":
                        continue
                    room.phase = "results"
                    room.ruling = ""
                    await state(room)

                elif typ == "room:chat":
                    now = time.monotonic()
                    if now - player.last_chat < 0.35:
                        continue
                    message = text_limited(payload.get("text"), 300)
                    if not message:
                        continue
                    player.last_chat = now
                    chat = {"id": secrets.token_hex(5), "from": player.id, "name": player.name, "avatar": player.avatar, "text": message, "time": int(time.time())}
                    room.chat.append(chat)
                    room.chat = room.chat[-60:]
                    await publish(room, "room:chat", message=chat)

                elif typ == "voice:status":
                    player.mic = payload.get("enabled") is True
                    await publish(room, "voice:status", id=player.id, enabled=player.mic)

                elif typ == "voice:signal":
                    to_id = payload.get("to")
                    peer = room.get(to_id)
                    signal = payload.get("signal")
                    if (peer and peer.ws is not None and isinstance(signal, dict)
                            and len(json.dumps(signal)) < 7500
                            and ("description" in signal or "candidate" in signal)):
                        await send(peer.ws, "voice:signal", sender=player.id, signal=signal)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if room and player:
            await remove_player_connection(room, player, ws)


async def cleanup():
    while True:
        await asyncio.sleep(120)
        now = time.monotonic()
        for code, room in list(ROOMS.items()):
            async with room.lock:
                # Keep disconnected players for 20 minutes for reconnection.
                room.players = [p for p in room.players if p.ws is not None or p.left_at is None or now - p.left_at < 1200]
                if not any(p.ws is not None for p in room.players) and now - room.updated > 1200:
                    ROOMS.pop(code, None)


@app.on_event("startup")
async def start_cleanup():
    asyncio.create_task(cleanup())


@app.get("/health")
async def health():
    return {"status": "ok", "rooms": len(ROOMS)}


@app.get("/")
async def root():
    return FileResponse(ROOT / "public" / "index.html")


app.mount("/", StaticFiles(directory=str(ROOT / "public")), name="static")
